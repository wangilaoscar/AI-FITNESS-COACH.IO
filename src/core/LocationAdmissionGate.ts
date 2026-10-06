// LocationAdmissionGate.ts
// Purpose: Determines whether an incoming LocationUpdate may enter the
// session-processing pipeline.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Session-context eligibility only: admits an observation only while
//     the session is ACTIVE.
//   - Timestamp sequencing only: an admitted observation's timestamp must
//     strictly advance past the last admitted one. Equal or earlier is
//     rejected — this is the same "duplicate/out-of-order" rule already
//     established in Milestone 4 Revision 1.1's failure-handling model
//     ("a timestamp equal to or older than the last accepted... is
//     treated as out-of-sequence and discarded"), not a new policy
//     invented for this step.
//   - Returns a verdict only. Does not create a RoutePoint, does not
//     touch TrackingSession, does not calculate anything, does not
//     publish an event.
//
// GPS accuracy/plausibility filtering remains exclusively the GPS
// System's responsibility (Milestone 3 §2). This module never inspects
// `accuracy`, `speed`, `altitude`, or `heading` for any admission
// decision — the only LocationUpdate field it ever reads is `timestamp`,
// alongside the session status supplied by the caller.

import type { LocationUpdate } from '../features/gps/types/gps.types';
import type { SessionStatus } from '../types/session.types';

export interface AdmissionResult {
  readonly admitted: boolean;
  readonly locationUpdate: LocationUpdate;
  readonly reason: string | null;
}

export class LocationAdmissionGate {
  private lastAcceptedTimestamp: number | null = null;

  /**
   * Decide whether `locationUpdate` may be admitted, given the session's
   * current status (supplied by the caller — the Gate does not read
   * TrackingSession itself). This is the Gate's entire public decision
   * surface: "can this LocationUpdate be admitted right now?" Its only
   * side effect, and only on acceptance, is advancing its own internal
   * timestamp-sequencing state.
   */
  evaluate(locationUpdate: LocationUpdate, sessionStatus: SessionStatus): AdmissionResult {
    if (!Number.isFinite(locationUpdate.timestamp)) {
      return this.reject(locationUpdate, 'LocationUpdate timestamp is not a valid finite number.');
    }

    if (sessionStatus !== 'ACTIVE') {
      return this.reject(
        locationUpdate,
        `Session is not ACTIVE (current status: ${sessionStatus}); LocationUpdate cannot be admitted.`
      );
    }

    if (this.lastAcceptedTimestamp !== null && locationUpdate.timestamp <= this.lastAcceptedTimestamp) {
      return this.reject(
        locationUpdate,
        `LocationUpdate timestamp (${locationUpdate.timestamp}) does not advance past the last accepted timestamp (${this.lastAcceptedTimestamp}).`
      );
    }

    this.lastAcceptedTimestamp = locationUpdate.timestamp;
    return { admitted: true, locationUpdate, reason: null };
  }

  /**
   * Reset timestamp-sequencing state so a new TrackingSession's timestamps
   * are judged independently of any previous session's.
   *
   * This is a mechanism, not a session-lifecycle policy: the Gate has no
   * awareness of Start/Pause/Resume/Stop/Save/Discard commands, so it
   * cannot decide *when* to call this itself. An orchestrating caller
   * (outside this step's scope) is expected to call it once, when a new
   * session begins. Sequencing deliberately does NOT reset across a
   * Pause→Resume within the same session — see the flagged design note
   * accompanying this implementation.
   */
  reset(): void {
    this.lastAcceptedTimestamp = null;
  }

  private reject(locationUpdate: LocationUpdate, reason: string): AdmissionResult {
    return { admitted: false, locationUpdate, reason };
  }
}