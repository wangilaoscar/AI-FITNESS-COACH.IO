// gps.types.ts
// Purpose: Raw GPS data type definitions
// (Stub file — Phase 1 architecture scaffold. No implementation yet.)
// gps.types.ts
// Purpose: Raw GPS data type definitions
//
// LocationUpdate is the GPS System's locked domain contract (Milestone
// 3.5 + Rev. 1.1), given a concrete field-level shape here for the first
// time. Fields match exactly what the locked architecture already
// established — nothing added, nothing renamed.
//
// LocationUpdate.speed is explicitly informational only. It must NEVER be
// treated as the authoritative skating speed anywhere in the Tracking
// Engine — that authority belongs solely to the Statistics Calculator's
// derived SessionStatistics.

export interface LocationUpdate {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
  readonly accuracy: number;
  readonly heading: number | null;
  readonly speed: number | null;
  readonly timestamp: number;
}
export interface LocationUpdate {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
  readonly accuracy: number;
  readonly heading: number | null;
  readonly speed: number | null;
  readonly timestamp: number;
}

/**
 * GPSHealth is intentionally left OPAQUE, by the same precedent already
 * established for GPSConfiguration and UserPreferences (Steps 2 and 7):
 * Milestone 3.5 Rev. 1.1 named its business meaning ("a discrete trust
 * indicator — Excellent/Good/Fair/Poor/Unavailable") but no milestone has
 * given it a concrete field-level shape in code yet. It is added here,
 * for the first time, only because Step 8 (Event Publisher) needs a type
 * to attach to `GPSHealthChanged` event payloads — the Publisher itself
 * never inspects it.
 */
export type GPSHealth = Readonly<Record<string, unknown>>;