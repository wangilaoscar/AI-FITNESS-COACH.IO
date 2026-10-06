// RoutePointFactory.ts
// Purpose: Promotes an already-admitted LocationUpdate into a RoutePoint.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Pure transformation only: one admitted LocationUpdate in, one
//     RoutePoint out. No state, no side effects, no decisions.
//   - Does NOT decide admissibility (LocationAdmissionGate's job, Step 4)
//     — this module trusts that whatever it receives has already been
//     admitted, and re-validates nothing about it.
//   - Preserves the LocationUpdate's timestamp exactly — never generates,
//     rounds, or derives a new one.
//   - Never copies or uses LocationUpdate.speed — that field is
//     informational only (Milestone 3.5 Rev. 1.1); speed is exclusively
//     the Statistics Calculator's concern (Step 6).
//   - Does NOT commit the RoutePoint anywhere — that remains
//     SessionAggregate.addRoutePoint's exclusive responsibility.
//
// Route-density policy: NONE currently exists anywhere in the locked
// architecture or this repository — only a comment in the Milestone-1-era
// RouteBuilder.ts stub mentions "downsampling" as an intent, with no
// concrete rule ever defined. Per instructions, no policy is invented
// here. This Factory is therefore a strict 1:1 transformation: every
// admitted LocationUpdate it receives produces exactly one RoutePoint.
// A route-density policy remains an open architectural decision to be
// addressed deliberately in a later, explicit step — not silently
// introduced here.
//
// Only the three fields RoutePoint's locked domain contract actually
// defines (latitude, longitude, timestamp) are promoted. LocationUpdate's
// other fields (altitude, accuracy, heading, speed) are read from, never
// copied — RoutePoint's contract is not expanded to accommodate them.

import type { LocationUpdate } from '../features/gps/types/gps.types';
import type { RoutePoint } from '../types/session.types';

/**
 * Transform one already-admitted LocationUpdate into a RoutePoint.
 *
 * Deterministic and side-effect-free: the same input always produces an
 * equal (deep-equal) output, the input is never mutated, and no state is
 * retained between calls.
 */
export function createRoutePoint(locationUpdate: LocationUpdate): RoutePoint {
  return Object.freeze({
    latitude: locationUpdate.latitude,
    longitude: locationUpdate.longitude,
    timestamp: locationUpdate.timestamp,
  });
}