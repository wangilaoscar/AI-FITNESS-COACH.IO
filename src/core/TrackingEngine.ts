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
import type { UserPreferences } from '../types/session.types';
import type { LocationUpdate } from '../features/gps/types/gps.types';

export interface TrackingEngineDependencies {
  readonly aggregate: SessionAggregate;
  readonly eventPublisher: EventPublisher;
  readonly admissionGate?: LocationAdmissionGate;
  readonly commandHandler?: SessionCommandHandler;
}

/**
 * The four commands in scope through Step 11B. StartSession takes
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
  | { readonly command: 'StopSession'; readonly timestamp: number };

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
        this.eventPublisher.publish({ type: 'SessionStarted', session: result.session });
        break;
      case 'PauseSession':
        this.eventPublisher.publish({ type: 'SessionPaused', session: result.session });
        break;
      case 'ResumeSession':
        this.eventPublisher.publish({ type: 'SessionResumed', session: result.session });
        break;
      case 'StopSession':
        this.eventPublisher.publish({ type: 'SessionStopped', session: result.session });
        break;
      case 'SaveSession':
      case 'DiscardSession':
        // Explicitly out of scope through 11C (deferred to 11D). Reachable
        // only if a caller bypasses TrackingEngineCommandInput's type
        // restriction — surfaced loudly rather than silently ignored.
        throw new Error(`${result.command} is not implemented until Step 11D.`);
    }

    return result;
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