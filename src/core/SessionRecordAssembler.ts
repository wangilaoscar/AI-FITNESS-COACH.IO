// SessionRecordAssembler.ts
// Purpose: Converts a completed, SAVED TrackingSession into an immutable
// SessionRecord.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Constructs the record purely from already-established data — the
//     route, final SessionStatistics, lifecycle timestamps, and
//     GPSConfiguration a TrackingSession already carries. No calculation,
//     no RoutePoint creation, no statistics recalculation.
//   - Produces the record in memory only. Never persists it, never
//     touches Storage/SessionRepository, never publishes an event.
//   - Never mutates the source TrackingSession.
//
// FLAGGED PRECONDITION DECISION: this task's own description says the
// Assembler converts a "STOPPED" TrackingSession, but Step 2's actual,
// already-approved SessionAggregate.applyVerdict returns a session with
// status 'SAVED' (not 'STOPPED') for a successful SaveSession — Save is
// the transition that produces the SAVED snapshot in the first place.
// Requiring merely STOPPED here would let a record be assembled before
// the user has actually chosen Save over Discard, violating the already
// -locked invariant that "a SessionRecord is produced only after a valid
// Save command succeeds" (Milestone 3.5 §4 Invariants). This
// implementation therefore requires the input session's status to be
// SAVED, deferring to Step 2's real, locked behavior over this task's
// looser prose summary, per the instruction to follow the existing
// approved lifecycle rather than invent a different status model.

import type { SessionRecord, TrackingSession } from '../types/session.types';

/**
 * Assemble a SessionRecord from a SAVED TrackingSession.
 *
 * Throws if `session.status` is not 'SAVED' — ACTIVE, PAUSED, and STOPPED
 * are all rejected (see the flagged precondition decision above for why
 * STOPPED alone is not sufficient).
 *
 * Reuses the session's own route, statistics, lifecycle, and
 * gpsConfiguration values directly — these are already frozen by
 * SessionAggregate, so no re-freezing or cloning of them is needed here;
 * only the new SessionRecord wrapper object itself is frozen.
 */
export function assembleSessionRecord(session: TrackingSession): SessionRecord {
  if (session.status !== 'SAVED') {
    throw new Error(
      `SessionRecordAssembler requires a SAVED session (received status: ${session.status}).`
    );
  }

  return Object.freeze({
    route: session.route,
    statistics: session.statistics,
    lifecycle: session.lifecycle,
    gpsConfiguration: session.gpsConfiguration,
  });
}