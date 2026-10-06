// GPSHealthRelay.ts
// Purpose: Passes a GPS System-produced GPSHealth value through to the
// Tracking Engine's boundary, unchanged.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - A boundary adapter only — the GPS System remains the sole producer
//     and owner of GPSHealth's meaning (Milestone 3 Rev. 1.1).
//   - Performs zero interpretation: no calculation, classification,
//     upgrading/downgrading, filtering, or threshold of the value.
//   - Does not publish a GPSHealthChanged event itself — that is a later
//     engine-integration decision (Step 8's EventPublisher already
//     exists as the delivery mechanism; deciding *whether/when* to call
//     it is explicitly out of this step's scope).
//   - Stateless: no current/previous health, no history, no counters, no
//     timestamps. Identical input always produces identical output.
//
// Reuses the exact GPSHealth type introduced in Step 8
// (src/features/gps/types/gps.types.ts) — opaque, unmodified, not moved,
// not duplicated. No second GPSHealth model is introduced here, and no
// business semantics (health categories, scores, thresholds) are
// invented for it.

import type { GPSHealth } from '../features/gps/types/gps.types';

/**
 * Relay a GPSHealth value onward, unchanged.
 *
 * This is intentionally as close to the identity function as this
 * module's boundary role allows — it exists so the Tracking Engine has a
 * named seam between "the GPS System produced a health reading" and
 * "the engine received one," without that seam doing anything to the
 * value itself.
 */
export function relayGPSHealth(health: GPSHealth): GPSHealth {
  return health;
}