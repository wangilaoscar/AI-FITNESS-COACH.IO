// ConfigurationResolver.ts
// Purpose: Translates UserPreferences into GPSConfiguration.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Owns the DECISION of what tracking policy a session should use.
//   - Does not execute that policy — the GPS System's Location Provider
//     Adapter (Milestone 3) applies whatever GPSConfiguration it is given.
//   - Pure, deterministic, side-effect-free. No GPS access, no
//     permissions, no session mutation, no statistics, no commands.
//
// ARCHITECTURAL GAP (reported, not silently resolved):
// Neither UserPreferences nor GPSConfiguration has a concrete field-level
// shape anywhere in the locked architecture — both are intentionally
// opaque (see src/types/session.types.ts). Milestone 3.5 named two user
// preferences conceptually ("unit system," "GPS accuracy preference") and
// Milestone 3 Rev. 1.1 named two GPSConfiguration concerns conceptually
// ("update frequency," "distance interval"), but no milestone ever locked
// which UserPreferences field maps to which GPSConfiguration field, nor
// what values either side actually takes.
//
// Inventing a mapping now — e.g. deciding that a "high" accuracy
// preference means a specific update interval in milliseconds — would be
// fabricating business policy that has never been architecturally
// approved, which these instructions explicitly forbid.
//
// This implementation is therefore a structurally correct, semantically
// empty pass-through: it establishes the pipeline's shape and location
// (UserPreferences → Configuration Resolver → GPSConfiguration) without
// pretending a real policy decision is happening. It returns an empty,
// opaque GPSConfiguration regardless of input, since no input field is
// yet known to mean anything on the output side. A real implementation of
// this function requires both opaque types to be given concrete fields
// first, in a dedicated, explicit architectural step — not invented here
// to make this step look complete.

import type { GPSConfiguration, UserPreferences } from '../types/session.types';

/**
 * Resolve a GPSConfiguration from the given UserPreferences.
 *
 * Currently a deliberate no-op pass-through (see the gap reported above):
 * every input produces the same empty, valid GPSConfiguration. This is
 * intentional, not a bug — once UserPreferences and GPSConfiguration are
 * each given concrete fields in a future, explicit step, this function is
 * where the real mapping belongs.
 */
export function resolveConfiguration(userPreferences: UserPreferences): GPSConfiguration {
  // `userPreferences` is intentionally unused beyond accepting it: no
  // known field of it currently corresponds to any known field of
  // GPSConfiguration. Accepting it (rather than omitting the parameter)
  // preserves the correct function signature for when a mapping exists.
  return {};
}