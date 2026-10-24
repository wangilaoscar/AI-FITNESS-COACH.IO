// session.types.ts
// Purpose: Canonical Session domain model
//
// These are the locked domain contracts from Milestone 3.5 (+ Rev. 1.1),
// given a concrete field-level shape here for the first time. Nothing here
// changes their business meaning, ownership, producer/consumer, or
// lifecycle — those remain exactly as architected. Fields are limited to
// what those documents already established; nothing has been added purely
// for implementation convenience.
//
// GPSConfiguration is intentionally left OPAQUE at this step: its concrete
// shape belongs to the Configuration Resolver (a later implementation step)
// and the GPS System's Location Provider Adapter (Milestone 3), and no
// milestone has ever defined its actual fields ("do NOT define actual
// values... only which side owns the decision" — Milestone 3 Rev. 1.1 §4).
// The Session Aggregate only stores and returns it unchanged, so an opaque
// shape is the most faithful representation available right now.
export type SessionStatus =
  | 'IDLE'
  | 'ACTIVE'
  | 'PAUSED'
  | 'STOPPED'
  | 'SAVED'
  | 'DISCARDED';

export type GPSConfiguration = Readonly<Record<string, unknown>>;

/**
 * UserPreferences is intentionally left OPAQUE for the same reason as
 * GPSConfiguration: its concrete fields are not yet locked by the domain
 * contract, and inventing them here would create an unapproved policy.
 */
export type UserPreferences = Readonly<Record<string, unknown>>;

/**
 * RoutePoint — a business-meaningful, session-scoped position record
 * (Milestone 3.5 §3). Limited to the fields that meaning requires: a
 * position, and its authoritative, immutable timestamp (Milestone 3 Rev.
 * 1.1 §3).
 */
export interface RoutePoint {
  readonly latitude: number;
  readonly longitude: number;
  readonly timestamp: number;
}

/**
 * SessionStatistics — the derived numeric summary of a session's
 * performance (Milestone 3.5 §3): "how fast, how far, how long."
 */
export interface SessionStatistics {
  readonly distanceMeters: number;
  readonly currentSpeedMetersPerSecond: number;
  readonly averageSpeedMetersPerSecond: number;
  readonly maxSpeedMetersPerSecond: number;
  readonly elapsedActiveMs: number;
}

/**
 * One pause/resume cycle within a session. `resumedAt` is null while the
 * pause is still open (the session has not yet been resumed).
 */
export interface PauseInterval {
  readonly pausedAt: number;
  readonly resumedAt: number | null;
}

/**
 * The session lifecycle timing the Session Aggregate is responsible for
 * retaining (Milestone 4 Revision 1.1's pause-boundary statistics rule) for
 * later consumption by the Statistics Calculator. Recording every
 * pause/resume cycle — not just the most recent one — is required because a
 * session may be paused and resumed more than once.
 */
export interface LifecycleTimestamps {
  readonly startedAt: number;
  readonly stoppedAt: number | null;
  readonly pauseIntervals: ReadonlyArray<PauseInterval>;
}

/**
 * TrackingSession — the aggregate representing a skating session while it
 * is live (Milestone 3.5 §3). The Session Aggregate is its sole mutable
 * holder (Milestone 4 Revision 1.1, Invariant 12).
 */
export interface TrackingSession {
  readonly status: SessionStatus;
  readonly gpsConfiguration: GPSConfiguration;
  readonly route: ReadonlyArray<RoutePoint>;
  readonly statistics: SessionStatistics;
  readonly lifecycle: LifecycleTimestamps;
}
/**
 * SessionRecord — the permanent, immutable record of a completed and
 * saved session (Milestone 3.5). A frozen snapshot of a TrackingSession:
 * its final RoutePoint sequence and final SessionStatistics, together with
 * the lifecycle timestamps and the GPSConfiguration the session used.
 * Every field is an existing domain type above — nothing new was invented,
 * and no business field (id, title, device identifier, schema version) was
 * added. `status` is deliberately excluded: a saved record has no ongoing
 * status the way a live TrackingSession does.
 *
 * This is the ONLY definition of SessionRecord in the codebase.
 */
export interface SessionRecord {
  readonly route: ReadonlyArray<RoutePoint>;
  readonly statistics: SessionStatistics;
  readonly lifecycle: LifecycleTimestamps;
  readonly gpsConfiguration: GPSConfiguration;
}