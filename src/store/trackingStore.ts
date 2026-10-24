// trackingStore.ts
// Purpose: Zustand store — active session reactive state
// (Stub file — Phase 1 architecture scaffold. No implementation yet.)
// trackingState.ts
// Purpose: A pure read-model of the Tracking Engine's published state.
//
// WHAT THIS IS
//   Two pure functions and one type:
//     - createInitialTrackingState(session)  → the starting TrackingState
//     - reduceTrackingState(state, event)    → the next TrackingState
//   Given a correct starting state and a gapless, in-order stream of the
//   nine locked DomainEvents (Milestone 4 Revision 1.1), folding them
//   through reduceTrackingState reproduces, at every event boundary, what
//   the SessionAggregate holds at that instant.
//
// WHAT THIS IS NOT (deliberately out of scope for this step)
//   No subscription to EventPublisher, no reading of the Aggregate, no
//   Zustand/React/Expo, no persistence, no command dispatch. It imports
//   TYPES only — it has no runtime dependency on the engine.
//
// STATUS IS NOT STORED
//   There is no `status` field. Status is derived exactly as the
//   Aggregate derives its own: `state.session?.status ?? 'IDLE'`
//   (SessionAggregate.getCurrentStatus). Only IDLE/ACTIVE/PAUSED/STOPPED
//   are ever observable: SAVED and DISCARDED appear only on the snapshot a
//   Save/Discard command result returns — never in an event, and never as
//   the Aggregate's live status.
//
// EVENT SEMANTICS (every payload is used exactly as published)
//   SessionStarted / Paused / Resumed / Stopped
//                        → session is replaced by the event's full snapshot.
//   RoutePointRecorded   → the point is appended to the live session's route.
//   StatisticsUpdated    → the live session's statistics are replaced.
//   GPSHealthChanged     → gpsHealth is replaced (opaque; independent of
//                          whether a session is live).
//   SessionRecordProduced→ session becomes null (the Aggregate has already
//                          reset to IDLE) and lastRecord is replaced.
//   SessionDiscarded     → session becomes null (same documented reset);
//                          lastRecord is untouched.
//
// APPROVED DECISIONS
//   1. A RoutePointRecorded / StatisticsUpdated event while there is no
//      live session cannot occur under gapless delivery. If it is ever
//      seen, the existing state is returned unchanged — never an error.
//   2. lastRecord persists until a later SessionRecordProduced replaces it.
//      It is NOT cleared by SessionStarted or by SessionDiscarded.
//   3. Status is derived, not stored (see above).
//   4. Terminal events leave session === null, i.e. derived status IDLE,
//      matching the Aggregate's documented automatic reset.
//
// PROPERTIES
//   - Pure and total: never throws, never reads a clock, never mutates its
//     arguments, and returns the SAME state reference when nothing applies.
//   - Fields an event does not concern keep their existing references.
//   - Outputs are new plain objects (not frozen); inputs may be frozen.
//
// KNOWN LIMITATIONS (properties of the locked contracts, not of this file)
//   - Determinism assumes gapless, in-order delivery from a known starting
//     state. Delta events carry no session id or sequence number, so a
//     missed event is undetectable here.
//   - GPSHealth and the last SessionRecord are event-only: neither the
//     engine nor the Aggregate retains them, so a state created mid-run
//     starts with both as null.
//   - GPSHealth and GPSConfiguration are opaque; they are passed through.

import type { DomainEvent } from '../core/EventPublisher';
import type { GPSHealth } from '../features/gps/types/gps.types';
import type { SessionRecord, TrackingSession } from '../types/session.types';

export interface TrackingState {
  /** The live session snapshot, or null when there is none (derived status: 'IDLE'). */
  readonly session: TrackingSession | null;
  /** The most recent GPSHealth published, or null if none has been observed. */
  readonly gpsHealth: GPSHealth | null;
  /** The most recent SessionRecord published, or null if none has been observed. */
  readonly lastRecord: SessionRecord | null;
}

/**
 * Build the starting state from the Aggregate's current snapshot
 * (SessionAggregate.getCurrentSession(): the live session, or null).
 * The snapshot is stored as given — not validated, copied, or altered.
 * gpsHealth and lastRecord start as null (see KNOWN LIMITATIONS).
 */
export function createInitialTrackingState(session: TrackingSession | null): TrackingState {
  return { session, gpsHealth: null, lastRecord: null };
}

/** Apply one DomainEvent. Pure and total; see the header for the exact rules. */
export function reduceTrackingState(state: TrackingState, event: DomainEvent): TrackingState {
  switch (event.type) {
    case 'SessionStarted':
    case 'SessionPaused':
    case 'SessionResumed':
    case 'SessionStopped':
      return { ...state, session: event.session };

    case 'RoutePointRecorded': {
      const live = state.session;
      if (live === null) return state; // decision 1
      return { ...state, session: { ...live, route: [...live.route, event.routePoint] } };
    }

    case 'StatisticsUpdated': {
      const live = state.session;
      if (live === null) return state; // decision 1
      return { ...state, session: { ...live, statistics: event.statistics } };
    }

    case 'GPSHealthChanged':
      return { ...state, gpsHealth: event.gpsHealth };

    case 'SessionRecordProduced':
      return { ...state, session: null, lastRecord: event.sessionRecord }; // decisions 2 + 4

    case 'SessionDiscarded':
      return { ...state, session: null }; // decisions 2 + 4

    default: {
      // Compile-time guard: adding a tenth event to DomainEvent fails type-checking here.
      // Runtime: an out-of-contract value leaves the state unchanged (the function stays total).
      const unreachable: never = event;
      void unreachable;
      return state;
    }
  }
}