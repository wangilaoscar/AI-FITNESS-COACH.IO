// SessionAggregate.ts
// Purpose: The sole mutable holder of the live TrackingSession.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - The sole holder and mutable owner of the live TrackingSession.
//   - The only module allowed to APPLY state changes to TrackingSession.
//   - Applies approved Session State Machine verdicts — it never decides
//     whether a command is legal itself.
//   - Maintains the session's ordered RoutePoint sequence, current
//     SessionStatistics, and lifecycle timestamps.
//   - Does NOT calculate statistics, validate LocationUpdates, perform GPS
//     filtering, create RoutePoints, resolve GPSConfiguration, publish
//     events, assemble a SessionRecord, persist anything, or know about
//     GPS, Storage, UI, Navigation, React, Zustand, or Expo.
//
// The State Machine decides. The Session Aggregate applies.
//
// Every "mutation" below is implemented as a functional replacement of the
// held TrackingSession with a brand-new, deeply frozen object — the
// Aggregate never mutates a TrackingSession object's fields in place, and
// every value it returns is frozen so a caller holding a reference to a
// past snapshot cannot corrupt live state, and the Aggregate's own live
// state cannot be corrupted through a value it has handed out.

import type { SessionCommand, TransitionVerdict } from './SessionStateMachine';
import type {
  GPSConfiguration,
  RoutePoint,
  SessionStatus,
  SessionStatistics,
  TrackingSession,
} from '../types/session.types';

/**
 * Deeply freeze a TrackingSession snapshot before it becomes the Aggregate's
 * live state or is handed to a caller. This is what makes "other modules
 * must receive read-only results/snapshots rather than mutable references"
 * a runtime guarantee, not just a convention.
 */
function freezeSession(session: TrackingSession): TrackingSession {
  Object.freeze(session.route);
  for (const point of session.route) {
    Object.freeze(point);
  }
  Object.freeze(session.lifecycle.pauseIntervals);
  for (const interval of session.lifecycle.pauseIntervals) {
    Object.freeze(interval);
  }
  Object.freeze(session.lifecycle);
  Object.freeze(session.statistics);
  Object.freeze(session.gpsConfiguration);
  return Object.freeze(session);
}

export class SessionAggregate {
  private currentSession: TrackingSession | null = null;

  /**
   * The current session status, or 'IDLE' when there is no live session
   * (before the first Start, or after a terminal command has completed and
   * the automatic reset has occurred).
   */
  getCurrentStatus(): SessionStatus {
    return this.currentSession?.status ?? 'IDLE';
  }

  /**
   * A read-only snapshot of the live TrackingSession, or null when there is
   * none. The returned object (and everything inside it) is frozen.
   */
  getCurrentSession(): TrackingSession | null {
    return this.currentSession;
  }

  /**
   * Instantiate a new live TrackingSession.
   *
   * Requires an already-accepted `StartSession` verdict as proof the
   * Session State Machine has already validated this — this method does
   * not re-derive that legality itself. It does independently guard its
   * own structural invariant: at most one live TrackingSession may exist
   * at a time.
   */
  createSession(
    verdict: TransitionVerdict,
    gpsConfiguration: GPSConfiguration,
    startedAt: number
  ): TrackingSession {
    if (verdict.command !== 'StartSession' || !verdict.accepted || verdict.resultingState !== 'ACTIVE') {
      throw new Error(
        'SessionAggregate.createSession requires an accepted StartSession verdict resulting in ACTIVE.'
      );
    }
    if (this.currentSession !== null) {
      throw new Error(
        'SessionAggregate already holds a live TrackingSession; cannot create a second one.'
      );
    }

    const session: TrackingSession = {
      status: 'ACTIVE',
      gpsConfiguration,
      route: [],
      statistics: {
        distanceMeters: 0,
        currentSpeedMetersPerSecond: 0,
        averageSpeedMetersPerSecond: 0,
        maxSpeedMetersPerSecond: 0,
        elapsedActiveMs: 0,
      },
      lifecycle: {
        startedAt,
        stoppedAt: null,
        pauseIntervals: [],
      },
    };

    this.currentSession = freezeSession(session);
    return this.currentSession;
  }

  /**
   * Apply an already-accepted Session State Machine verdict to the live
   * TrackingSession — for every command except `StartSession` (use
   * `createSession` for that, since creation needs a GPSConfiguration the
   * verdict itself doesn't carry).
   *
   * For `SaveSession`/`DiscardSession`, the terminal transition and the
   * automatic reset to "no live session" happen within this single
   * synchronous call — no other method call can observe the Aggregate in
   * between (Milestone 4 Revision 1.1 §5, atomicity invariant).
   */
  applyVerdict(verdict: TransitionVerdict, timestamp: number): TrackingSession {
    if (verdict.command === 'StartSession') {
      throw new Error('Use createSession to apply an accepted StartSession verdict.');
    }
    if (!verdict.accepted || verdict.resultingState === null) {
      throw new Error('SessionAggregate.applyVerdict requires an accepted verdict.');
    }
    if (this.currentSession === null) {
      throw new Error('SessionAggregate has no live TrackingSession to apply a verdict to.');
    }
    if (verdict.currentState !== this.currentSession.status) {
      throw new Error(
        `Verdict currentState (${verdict.currentState}) does not match the live session's status (${this.currentSession.status}).`
      );
    }

    const session = this.currentSession;
    const resultingState = verdict.resultingState;

    switch (verdict.command as Exclude<SessionCommand, 'StartSession'>) {
      case 'PauseSession': {
        const updated: TrackingSession = {
          ...session,
          status: resultingState,
          lifecycle: {
            ...session.lifecycle,
            pauseIntervals: [
              ...session.lifecycle.pauseIntervals,
              { pausedAt: timestamp, resumedAt: null },
            ],
          },
        };
        this.currentSession = freezeSession(updated);
        return this.currentSession;
      }

      case 'ResumeSession': {
        const intervals = session.lifecycle.pauseIntervals;
        const lastIndex = intervals.length - 1;
        if (lastIndex < 0 || intervals[lastIndex].resumedAt !== null) {
          throw new Error('SessionAggregate has no open pause interval to resume.');
        }
        const updatedIntervals = intervals.map((interval, index) =>
          index === lastIndex ? { ...interval, resumedAt: timestamp } : interval
        );
        const updated: TrackingSession = {
          ...session,
          status: resultingState,
          lifecycle: { ...session.lifecycle, pauseIntervals: updatedIntervals },
        };
        this.currentSession = freezeSession(updated);
        return this.currentSession;
      }

      case 'StopSession': {
        const updated: TrackingSession = {
          ...session,
          status: resultingState,
          lifecycle: { ...session.lifecycle, stoppedAt: timestamp },
        };
        this.currentSession = freezeSession(updated);
        return this.currentSession;
      }

      case 'SaveSession':
      case 'DiscardSession': {
        const finalSession = freezeSession({ ...session, status: resultingState });
        this.currentSession = null;
        return finalSession;
      }

      default: {
        const exhaustive: never = verdict.command as never;
        throw new Error(`Unhandled command: ${exhaustive}`);
      }
    }
  }

  /**
   * Append a RoutePoint to the live session's route.
   *
   * This does NOT decide whether the underlying LocationUpdate was valid,
   * perform GPS accuracy filtering, or apply route-density policy — all of
   * that has already happened upstream (Location Admission Gate / RoutePoint
   * Factory) by the time a RoutePoint reaches this method. The Aggregate's
   * own defensive check here is narrow and structural: it refuses to record
   * a session that is not ACTIVE, and it refuses an exact duplicate point
   * appended consecutively — it does not re-validate sequencing or
   * plausibility, which remain those other modules' exclusive concern.
   */
  addRoutePoint(routePoint: RoutePoint): TrackingSession {
    if (this.currentSession === null) {
      throw new Error('SessionAggregate has no live TrackingSession to add a RoutePoint to.');
    }
    if (this.currentSession.status !== 'ACTIVE') {
      throw new Error(
        `SessionAggregate cannot add a RoutePoint while the session is ${this.currentSession.status}.`
      );
    }

    const route = this.currentSession.route;
    const last = route[route.length - 1];
    if (
      last !== undefined &&
      last.timestamp === routePoint.timestamp &&
      last.latitude === routePoint.latitude &&
      last.longitude === routePoint.longitude
    ) {
      throw new Error(
        'SessionAggregate rejected an exact duplicate RoutePoint appended consecutively.'
      );
    }

    const storedPoint: RoutePoint = Object.freeze({ ...routePoint });
    const updated: TrackingSession = {
      ...this.currentSession,
      route: [...route, storedPoint],
    };
    this.currentSession = freezeSession(updated);
    return this.currentSession;
  }

  /**
   * Replace the live session's SessionStatistics with a value already
   * computed elsewhere (the Statistics Calculator). No calculation happens
   * here — the value is stored verbatim.
   */
  applyStatistics(statistics: SessionStatistics): TrackingSession {
    if (this.currentSession === null) {
      throw new Error('SessionAggregate has no live TrackingSession to apply statistics to.');
    }
    const updated: TrackingSession = { ...this.currentSession, statistics };
    this.currentSession = freezeSession(updated);
    return this.currentSession;
  }
}