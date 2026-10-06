export type {
  SessionStatus,
  GPSConfiguration,
  UserPreferences,
  RoutePoint,
  SessionStatistics,
  PauseInterval,
  LifecycleTimestamps,
  TrackingSession,
} from '../../types/session.types';

/**
 * SessionRecord is intentionally left OPAQUE, by the same precedent
 * already established for GPSConfiguration, UserPreferences, and
 * GPSHealth: Milestone 3.5 named its business meaning ("the permanent,
 * immutable record of a completed and saved session") but no milestone
 * has given it a concrete field-level shape, since the module that
 * actually assembles one — the Session Record Assembler — is a later
 * implementation step (Step 9), not this one. Added here only because
 * Step 8 (Event Publisher) needs a type to attach to
 * `SessionRecordProduced` event payloads — the Publisher itself never
 * inspects it.
 */
export type SessionRecord = Readonly<Record<string, unknown>>;
/**
 * SessionRecord — given a concrete shape here for the first time (Step
 * 10), unlike GPSConfiguration/UserPreferences/GPSHealth, which remain
 * genuinely opaque because no milestone ever specified their content at
 * all. SessionRecord's content, by contrast, was already specified
 * across the locked architecture: "a frozen snapshot of a TrackingSession
 * — carries its final RoutePoint sequence and final SessionStatistics"
 * (Milestone 3.5 §3/§4), together with lifecycle timestamps and the
 * GPSConfiguration the session used. All four fields below already exist
 * as concrete domain types (RoutePoint, SessionStatistics,
 * LifecycleTimestamps, GPSConfiguration) — nothing new was invented, and
 * no business field (an id, a title, a device identifier, a schema
 * version) was added. `status` is deliberately excluded: a saved record
 * has no ongoing status the way a live TrackingSession does.
 */
export interface SessionRecord {
  readonly route: ReadonlyArray<RoutePoint>;
  readonly statistics: SessionStatistics;
  readonly lifecycle: LifecycleTimestamps;
  readonly gpsConfiguration: GPSConfiguration;
}