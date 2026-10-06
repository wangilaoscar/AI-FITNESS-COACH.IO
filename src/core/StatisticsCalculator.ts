// StatisticsCalculator.ts
// Purpose: The sole calculation authority for SessionStatistics.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Pure, deterministic, side-effect-free. No session mutation, no GPS
//     logic, no commands, no persistence, no events, no UI.
//   - Derives distance, current/average/max speed, and elapsed active time
//     from RoutePoints and LifecycleTimestamps only.
//   - Never uses LocationUpdate.speed (it isn't even in this module's
//     input — RoutePoint carries no speed field at all).
//   - Never performs GPS accuracy filtering or admission — trusts that
//     every RoutePoint it receives was already accepted upstream.
//   - Never uses Date.now() — see the flagged design note below on how an
//     in-progress (stoppedAt === null) session's elapsed time is computed
//     without one.
//
// FLAGGED DESIGN DECISION — elapsed time for an in-progress session:
// The locked rules specify elapsed active time in terms of startedAt,
// stoppedAt, and pauseIntervals, but stoppedAt is null while a session is
// still ACTIVE, and Date.now() is explicitly disallowed. This module
// resolves that by computing everything "as of" the latest timestamp it
// has actually been given — the maximum of startedAt, stoppedAt (if set),
// every pause interval's pausedAt/resumedAt, and every RoutePoint's
// timestamp. This uses only authoritative data already supplied, and
// produces the intuitively correct result at the boundaries: elapsed time
// freezes at the moment of pausing while currently paused, and correctly
// reflects a stop-while-paused once stoppedAt is set. This was not
// explicitly locked and should be treated as flagged, not settled.

import type { LifecycleTimestamps, PauseInterval, RoutePoint, SessionStatistics } from '../types/session.types';

const EARTH_RADIUS_METERS = 6371000;

export interface StatisticsCalculatorInput {
  readonly routePoints: ReadonlyArray<RoutePoint>;
  readonly lifecycle: LifecycleTimestamps;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Standard great-circle (Haversine) distance between two positions, in
 * meters. Contained privately in this module, per instructions, rather
 * than extracted into a general utility framework.
 */
function haversineDistanceMeters(a: RoutePoint, b: RoutePoint): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const sinDeltaLat = Math.sin(deltaLat / 2);
  const sinDeltaLon = Math.sin(deltaLon / 2);

  const h = sinDeltaLat * sinDeltaLat + Math.cos(lat1) * Math.cos(lat2) * sinDeltaLon * sinDeltaLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_METERS * c;
}

interface ValidSegment {
  readonly distanceMeters: number;
  readonly speedMetersPerSecond: number;
}

/**
 * A pause "spans" the gap between two consecutive RoutePoints if the
 * pause's own active window — (pausedAt, resumedAt) — overlaps the open
 * interval strictly between the two points' timestamps.
 *
 * Deliberately strict (`<`/`>`, not `<=`/`>=`) on both ends: a RoutePoint
 * whose timestamp exactly equals pausedAt was still recorded before the
 * pause took effect (it belongs to the segment ending there, not the one
 * starting there), and symmetrically for a RoutePoint exactly at
 * resumedAt. Only pause time strictly *between* two points invalidates
 * the segment connecting them (locked rule 6).
 */
function pauseSpansGap(prev: RoutePoint, next: RoutePoint, pauseIntervals: ReadonlyArray<PauseInterval>): boolean {
  return pauseIntervals.some(
    (interval) => interval.pausedAt < next.timestamp && (interval.resumedAt ?? Infinity) > prev.timestamp
  );
}

/**
 * Build the list of valid movement segments from consecutive RoutePoints,
 * excluding any pair whose gap is spanned by a pause, and excluding any
 * pair with a non-positive time delta (defensive — should not occur given
 * upstream admission, but must never produce a negative/NaN/Infinity
 * speed or corrupt totals if it somehow does).
 */
function buildValidSegments(
  routePoints: ReadonlyArray<RoutePoint>,
  pauseIntervals: ReadonlyArray<PauseInterval>
): ValidSegment[] {
  const segments: ValidSegment[] = [];

  for (let i = 1; i < routePoints.length; i++) {
    const prev = routePoints[i - 1];
    const next = routePoints[i];
    const deltaMs = next.timestamp - prev.timestamp;

    if (deltaMs <= 0) continue;
    if (pauseSpansGap(prev, next, pauseIntervals)) continue;

    const distanceMeters = haversineDistanceMeters(prev, next);
    const speedMetersPerSecond = distanceMeters / (deltaMs / 1000);
    segments.push({ distanceMeters, speedMetersPerSecond });
  }

  return segments;
}

/**
 * Elapsed active time: total session span (from startedAt to the latest
 * known timestamp) minus every pause interval's overlap with that span.
 * See the flagged design note above for how the "latest known timestamp"
 * (referenceEnd) is determined without Date.now().
 */
function computeElapsedActiveMs(routePoints: ReadonlyArray<RoutePoint>, lifecycle: LifecycleTimestamps): number {
  const knownTimestamps: number[] = [lifecycle.startedAt];
  if (lifecycle.stoppedAt !== null) knownTimestamps.push(lifecycle.stoppedAt);
  for (const interval of lifecycle.pauseIntervals) {
    knownTimestamps.push(interval.pausedAt);
    if (interval.resumedAt !== null) knownTimestamps.push(interval.resumedAt);
  }
  for (const point of routePoints) {
    knownTimestamps.push(point.timestamp);
  }

  const referenceEnd = Math.max(...knownTimestamps);
  const totalSpanMs = Math.max(0, referenceEnd - lifecycle.startedAt);

  const pausedMs = lifecycle.pauseIntervals.reduce((sum, interval) => {
    const overlapEnd = Math.min(interval.resumedAt ?? referenceEnd, referenceEnd);
    const overlapStart = interval.pausedAt;
    return sum + Math.max(0, overlapEnd - overlapStart);
  }, 0);

  return Math.max(0, totalSpanMs - pausedMs);
}

/**
 * Derive the complete SessionStatistics for a session from its accepted
 * RoutePoints and lifecycle timing. Deterministic: identical input always
 * produces an equal (deep-equal) result. Neither input is mutated.
 */
export function calculateSessionStatistics(input: StatisticsCalculatorInput): SessionStatistics {
  const { routePoints, lifecycle } = input;

  const elapsedActiveMs = computeElapsedActiveMs(routePoints, lifecycle);

  const segments = routePoints.length < 2 ? [] : buildValidSegments(routePoints, lifecycle.pauseIntervals);

  if (segments.length === 0) {
    return {
      distanceMeters: 0,
      currentSpeedMetersPerSecond: 0,
      averageSpeedMetersPerSecond: 0,
      maxSpeedMetersPerSecond: 0,
      elapsedActiveMs,
    };
  }

  const distanceMeters = segments.reduce((sum, segment) => sum + segment.distanceMeters, 0);
  const currentSpeedMetersPerSecond = segments[segments.length - 1].speedMetersPerSecond;
  const maxSpeedMetersPerSecond = segments.reduce(
    (max, segment) => Math.max(max, segment.speedMetersPerSecond),
    0
  );
  const averageSpeedMetersPerSecond = elapsedActiveMs > 0 ? distanceMeters / (elapsedActiveMs / 1000) : 0;

  return {
    distanceMeters,
    currentSpeedMetersPerSecond,
    averageSpeedMetersPerSecond,
    maxSpeedMetersPerSecond,
    elapsedActiveMs,
  };
}