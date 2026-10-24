// TrackingEngine.ts
// Purpose: Core orchestrator — composition/integration shell for the ten
// locked Tracking Engine modules (Steps 1-10).
//
// STEP 11C SCOPE: adds processLocationUpdate, wiring
// LocationAdmissionGate → RoutePointFactory → SessionAggregate →
// StatisticsCalculator → SessionAggregate → EventPublisher. Command
// processing (11B: Start/Pause/Resume/Stop) is unchanged. SaveSession,
// DiscardSession, and GPSHealth remain unimplemented (later sub-stages).
//
// No transition rule, mutation, or calculation is duplicated here:
//   - Admission eligibility is decided entirely inside
//     LocationAdmissionGate — this file only inspects the already-
//     returned `admitted` flag.
//   - RoutePoint creation is delegated entirely to RoutePointFactory.
//   - Statistics are computed entirely by StatisticsCalculator, from the
//     Aggregate's own already-committed route and lifecycle — this file
//     performs no arithmetic itself.
//   - All TrackingSession mutation happens only via SessionAggregate's
//     own methods (addRoutePoint, applyStatistics) — never by touching a
//     TrackingSession field directly.

import { SessionAggregate } from './SessionAggregate';
import {
  SessionCommandHandler,
  SessionCommandInput,
  SessionCommandResult,
} from './SessionCommandHandler';
import { LocationAdmissionGate } from './LocationAdmissionGate';
import { EventPublisher } from './EventPublisher';
import { resolveConfiguration } from './ConfigurationResolver';
import { createRoutePoint } from './RoutePointFactory';
import { calculateSessionStatistics } from './StatisticsCalculator';
import { assembleSessionRecord } from './SessionRecordAssembler';
import { relayGPSHealth } from './GPSHealthRelay';
import type { TrackingSession, UserPreferences } from '../types/session.types';
import type { GPSHealth, LocationUpdate } from '../features/gps/types/gps.types';
export interface TrackingEngineDependencies {
  readonly aggregate: SessionAggregate;
  readonly eventPublisher: EventPublisher;
  readonly admissionGate?: LocationAdmissionGate;
  readonly commandHandler?: SessionCommandHandler;
}

/**
 * The six commands in scope through Step 11B. StartSession takes
 * UserPreferences rather than an already-resolved GPSConfiguration — this
 * layer is what calls the Configuration Resolver, synchronously, before
 * delegating to the Command Handler (matching the existing
 * ConfigurationResolver/SessionCommandHandler APIs exactly; no new
 * configuration field or semantic is introduced).
 */
export type TrackingEngineCommandInput =
  | { readonly command: 'StartSession'; readonly timestamp: number; readonly userPreferences: UserPreferences }
  | { readonly command: 'PauseSession'; readonly timestamp: number }
  | { readonly command: 'ResumeSession'; readonly timestamp: number }
  | { readonly command: 'StopSession'; readonly timestamp: number }
  | { readonly command: 'SaveSession'; readonly timestamp: number }
  | { readonly command: 'DiscardSession'; readonly timestamp: number };
export class TrackingEngine {
  private readonly aggregate: SessionAggregate;
  private readonly eventPublisher: EventPublisher;
  private readonly admissionGate: LocationAdmissionGate;
  private readonly commandHandler: SessionCommandHandler;

  constructor(dependencies: TrackingEngineDependencies) {
    this.aggregate = dependencies.aggregate;
    this.eventPublisher = dependencies.eventPublisher;
    this.admissionGate = dependencies.admissionGate ?? new LocationAdmissionGate();
    // The Command Handler must wrap this exact same Aggregate instance —
    // the integration layer and the Handler have to observe/mutate one
    // shared live session, never two independent ones. This is composition
    // only: no command legality rule or mutation logic lives here, both
    // remain entirely inside SessionCommandHandler/SessionAggregate.
    this.commandHandler = dependencies.commandHandler ?? new SessionCommandHandler(this.aggregate);
  }

  /**
   * Exposed only so tests can confirm each dependency was wired to the
   * instance actually passed in, rather than a hidden internal
   * substitute. Not part of the eventual public orchestration API.
   */
  getWiredDependencies(): {
    aggregate: SessionAggregate;
    eventPublisher: EventPublisher;
    admissionGate: LocationAdmissionGate;
    commandHandler: SessionCommandHandler;
  } {
    return {
      aggregate: this.aggregate,
      eventPublisher: this.eventPublisher,
      admissionGate: this.admissionGate,
      commandHandler: this.commandHandler,
    };
  }

  /**
   * COMMAND PATH (Start/Pause/Resume/Stop — Step 11B).
   *
   * Delegates entirely to the already-wired SessionCommandHandler — this
   * method never evaluates transition legality itself. If the Handler
   * rejects the command, no event is published and the method returns the
   * rejection outcome as-is. If accepted, the corresponding existing
   * event is published using the already-committed result the
   * Handler/Aggregate returned — mutation always completes before
      * publication, since `this.commandHandler.handle(...)` has already
   * returned (and therefore already committed) by the time `publish` is
   * called below.
   *
   * StopSession additionally finalizes statistics before publishing (see
   * finalizeStoppedSession), and the returned result carries that final
   * committed session rather than the intermediate STOPPED snapshot, so
   * the caller and the SessionStopped subscribers see the same value.
   * SaveSession/DiscardSession return the Handler's SAVED/DISCARDED
   * snapshot unchanged; the Aggregate has already reset to IDLE.
   */
  processCommand(input: TrackingEngineCommandInput): SessionCommandResult {
    const handlerInput: SessionCommandInput =
      input.command === 'StartSession'
        ? {
            command: 'StartSession',
            timestamp: input.timestamp,
            gpsConfiguration: resolveConfiguration(input.userPreferences),
          }
        : input;

    const result = this.commandHandler.handle(handlerInput);

    if (!result.accepted || result.session === null) {
      return result;
    }

    switch (result.command) {
            case 'StartSession':
        // A new TrackingSession's timestamps must be judged independently
        // of any previous session's. The Gate's own contract makes this the
        // orchestrator's job: reset it once, when a new session begins. It
        // is done here — only on an ACCEPTED Start (a rejected command has
        // already returned above, so it never wipes a live session's
        // sequencing) and before SessionStarted is published, so
        // subscribers observe an already-reset Gate.
        this.admissionGate.reset();
        this.eventPublisher.publish({ type: 'SessionStarted', session: result.session });
        break;
      case 'PauseSession':
        this.eventPublisher.publish({ type: 'SessionPaused', session: result.session });
        break;
      case 'ResumeSession':
        this.eventPublisher.publish({ type: 'SessionResumed', session: result.session });
        break;
            case 'StopSession': {
        const finalSession = this.finalizeStoppedSession(result.session);
        this.eventPublisher.publish({ type: 'SessionStopped', session: finalSession });
        return { ...result, session: finalSession };
      }
      case 'SaveSession': {
        // result.session is the SAVED snapshot the Aggregate returned as it
        // atomically reset itself to IDLE — the Assembler requires SAVED,
        // never STOPPED. Assembly is in-memory only; nothing is persisted.
        const sessionRecord = assembleSessionRecord(result.session);
        this.eventPublisher.publish({ type: 'SessionRecordProduced', sessionRecord });
        break;
      }
      case 'DiscardSession':
        // No SessionRecord is assembled for a discarded session.
        this.eventPublisher.publish({ type: 'SessionDiscarded' });
        break;
    }

    return result;
  }

  /**
   * GPS HEALTH PATH (Step 11D).
   *
   * Passes the GPSHealth value through GPSHealthRelay unchanged and
   * publishes it as GPSHealthChanged. This method performs no
   * interpretation: no categories, thresholds, previous-value comparison,
   * or de-duplication, and it is not gated on session status — the GPS
   * System owns what a health reading means and when one is delivered.
   * The TrackingSession is never read or mutated.
   */
  processGPSHealth(health: GPSHealth): void {
    const relayed = relayGPSHealth(health);
    this.eventPublisher.publish({ type: 'GPSHealthChanged', gpsHealth: relayed });
  }

  /**
   * Stop finalization (Step 11D, flow A). The Aggregate has already
   * committed STOPPED (with stoppedAt) by the time this is called. Final
   * statistics are computed by StatisticsCalculator from that committed
   * route and lifecycle — they can differ from the last live statistics
   * because stoppedAt may be later than the last RoutePoint — and then
   * committed back through the Aggregate. Returns the Aggregate's
   * resulting (still STOPPED) snapshot. No arithmetic is done here.
   */
  private finalizeStoppedSession(stoppedSession: TrackingSession): TrackingSession {
    const finalStatistics = calculateSessionStatistics({
      routePoints: stoppedSession.route,
      lifecycle: stoppedSession.lifecycle,
    });
    return this.aggregate.applyStatistics(finalStatistics);
  }      

  /**
   * LOCATION PATH (Step 11C).
   *
   * LocationAdmissionGate → RoutePointFactory → SessionAggregate →
   * StatisticsCalculator → SessionAggregate → EventPublisher.
   *
   * A rejected LocationUpdate produces no RoutePoint, no Aggregate
   * mutation, no statistics calculation, and no event — the method
   * returns immediately. On admission, exactly one RoutePoint is created
   * and committed before RoutePointRecorded is published, and statistics
   * are recalculated from the Aggregate's own updated route/lifecycle and
   * committed before StatisticsUpdated is published — RoutePointRecorded
   * therefore always precedes StatisticsUpdated, and neither event is
   * ever published before its corresponding mutation.
   */
  processLocationUpdate(locationUpdate: LocationUpdate): void {
    const currentStatus = this.aggregate.getCurrentStatus();
    const admission = this.admissionGate.evaluate(locationUpdate, currentStatus);
    if (!admission.admitted) {
      return;
    }

    const routePoint = createRoutePoint(locationUpdate);
    const sessionAfterPoint = this.aggregate.addRoutePoint(routePoint);
    this.eventPublisher.publish({ type: 'RoutePointRecorded', routePoint });

    const statistics = calculateSessionStatistics({
      routePoints: sessionAfterPoint.route,
      lifecycle: sessionAfterPoint.lifecycle,
    });
    this.aggregate.applyStatistics(statistics);
    this.eventPublisher.publish({ type: 'StatisticsUpdated', statistics });
  }
}
