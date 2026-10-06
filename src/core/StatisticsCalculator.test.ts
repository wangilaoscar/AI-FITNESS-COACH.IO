import { calculateSessionStatistics } from './StatisticsCalculator';
import type { LifecycleTimestamps, RoutePoint } from '../types/session.types';

function point(overrides: Partial<RoutePoint>): RoutePoint {
  return { latitude: 0, longitude: 0, timestamp: 0, ...overrides };
}

function lifecycle(overrides: Partial<LifecycleTimestamps>): LifecycleTimestamps {
  return { startedAt: 0, stoppedAt: null, pauseIntervals: [], ...overrides };
}

const ZERO_STATS = {
  distanceMeters: 0,
  currentSpeedMetersPerSecond: 0,
  averageSpeedMetersPerSecond: 0,
  maxSpeedMetersPerSecond: 0,
};

describe('StatisticsCalculator — zero/one RoutePoint rule', () => {
  it('1. zero RoutePoints → all numeric statistics are zero (with a fully-closed, zero-length lifecycle)', () => {
    const stats = calculateSessionStatistics({
      routePoints: [],
      lifecycle: lifecycle({ startedAt: 0, stoppedAt: 0 }),
    });
    expect(stats).toEqual({ ...ZERO_STATS, elapsedActiveMs: 0 });
  });

  it('2. one RoutePoint → distance/current/average/max are zero', () => {
    const stats = calculateSessionStatistics({
      routePoints: [point({ timestamp: 1000 })],
      lifecycle: lifecycle({ startedAt: 0, stoppedAt: 2000 }),
    });
    expect(stats.distanceMeters).toBe(0);
    expect(stats.currentSpeedMetersPerSecond).toBe(0);
    expect(stats.averageSpeedMetersPerSecond).toBe(0);
    expect(stats.maxSpeedMetersPerSecond).toBe(0);
  });
});

describe('StatisticsCalculator — segment distance and speed', () => {
  it('3. two points one second apart produce the expected segment distance and speed', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }), // ~111.2m at this latitude
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(stats.distanceMeters).toBeGreaterThan(110);
    expect(stats.distanceMeters).toBeLessThan(112);
    // One-second segment: speed (m/s) numerically equals distance (m).
    expect(stats.currentSpeedMetersPerSecond).toBeCloseTo(stats.distanceMeters, 6);
  });

  it('4. total distance is the sum of valid segment distances', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
        point({ latitude: 0.002, longitude: 0, timestamp: 3000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 3000 }),
    });
    // Two equal ~111.2m segments:
    expect(stats.distanceMeters).toBeGreaterThan(220);
    expect(stats.distanceMeters).toBeLessThan(224);
  });

  it('5. current speed equals the latest valid segment speed', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }), // fast segment
        point({ latitude: 0.002, longitude: 0, timestamp: 2000 }),
        point({ latitude: 0.0025, longitude: 0, timestamp: 3000 }), // slower segment
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 3000 }),
    });
    // Second segment (0.0005°, ~55.6m over 1s) is slower than the first
    // (0.002°, ~222.4m over 1s) — current speed must reflect the latest one.
    expect(stats.currentSpeedMetersPerSecond).toBeLessThan(stats.maxSpeedMetersPerSecond);
    expect(stats.currentSpeedMetersPerSecond).toBeGreaterThan(50);
    expect(stats.currentSpeedMetersPerSecond).toBeLessThan(61);
  });

  it('6. maximum speed equals the maximum valid segment speed (max distinct from both the first and the current/last segment)', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }), // medium segment (~111m/s)
        point({ latitude: 0.003, longitude: 0, timestamp: 3000 }), // fastest segment (~222m/s)
        point({ latitude: 0.0035, longitude: 0, timestamp: 4000 }), // slowest segment (~55.6m/s), and current
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 4000 }),
    });
    expect(stats.maxSpeedMetersPerSecond).toBeGreaterThan(stats.currentSpeedMetersPerSecond);
    expect(stats.maxSpeedMetersPerSecond).toBeGreaterThan(217);
    expect(stats.maxSpeedMetersPerSecond).toBeLessThan(227);
  });
});

describe('StatisticsCalculator — pause boundary and elapsed active time', () => {
  it('7. average speed uses ACTIVE elapsed time, not wall-clock session duration', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({
        startedAt: 1000,
        stoppedAt: 12000, // 11s wall-clock span
        pauseIntervals: [{ pausedAt: 2000, resumedAt: 12000 }], // but 10s of it was paused
      }),
    });
    // ACTIVE elapsed = 11000 - 10000(paused) = 1000ms = 1s.
    expect(stats.elapsedActiveMs).toBe(1000);
    // Average speed = distance / 1s, not distance / 11s:
    expect(stats.averageSpeedMetersPerSecond).toBeCloseTo(stats.distanceMeters, 4);
  });

  it('8. a single pause excludes its duration from elapsedActiveMs', () => {
    const stats = calculateSessionStatistics({
      routePoints: [],
      lifecycle: lifecycle({
        startedAt: 0,
        stoppedAt: 10000,
        pauseIntervals: [{ pausedAt: 3000, resumedAt: 5000 }], // 2000ms paused
      }),
    });
    expect(stats.elapsedActiveMs).toBe(10000 - 2000);
  });

  it('9. multiple pause intervals are all excluded, without double-counting or losing active time', () => {
    const stats = calculateSessionStatistics({
      routePoints: [],
      lifecycle: lifecycle({
        startedAt: 0,
        stoppedAt: 20000,
        pauseIntervals: [
          { pausedAt: 2000, resumedAt: 4000 }, // 2000ms
          { pausedAt: 10000, resumedAt: 13000 }, // 3000ms
        ],
      }),
    });
    expect(stats.elapsedActiveMs).toBe(20000 - 2000 - 3000);
  });

  it('10. a segment crossing a pause boundary is NOT counted as one continuous segment', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }), // P1→P2 valid, ACTIVE
        // pause from 2000 to 5000
        point({ latitude: 5, longitude: 5, timestamp: 5000 }), // P2→P3 spans the pause — must be excluded
        point({ latitude: 5.001, longitude: 5, timestamp: 6000 }), // P3→P4 valid, ACTIVE
      ],
      lifecycle: lifecycle({
        startedAt: 1000,
        stoppedAt: 6000,
        pauseIntervals: [{ pausedAt: 2000, resumedAt: 5000 }],
      }),
    });
    // If P2→P3 (a huge, nonsensical jump) were included, distance would be
    // enormous (hundreds of km). It must not be.
    expect(stats.distanceMeters).toBeLessThan(300); // only the two ~111m segments
    expect(stats.distanceMeters).toBeGreaterThan(220);
  });
});

describe('StatisticsCalculator — GPS boundary discipline', () => {
  it('11. speed is never taken from LocationUpdate.speed (RoutePoint carries no speed field at all)', () => {
    // Structural guarantee: RoutePoint's type has no `speed` property, so
    // this Calculator's input cannot carry LocationUpdate.speed in any
    // form. Demonstrated by constructing valid input from RoutePoint's
    // actual shape alone.
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(Object.keys(stats)).not.toContain('speed');
  });

  it('12. GPS accuracy does not affect calculations (RoutePoint has no accuracy field to affect anything)', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(stats.distanceMeters).toBeGreaterThan(0);
  });

  it('13. heading does not affect calculations (RoutePoint has no heading field)', () => {
    const a = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    const b = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(a).toEqual(b);
  });

  it('14. altitude does not affect horizontal distance (RoutePoint has no altitude field; distance is horizontal only)', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(stats.distanceMeters).toBeGreaterThan(110);
    expect(stats.distanceMeters).toBeLessThan(112);
  });
});

describe('StatisticsCalculator — timestamp handling and defensive behavior', () => {
  it('15. timestamp deltas are handled deterministically', () => {
    const input = {
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 1500 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 1500 }),
    };
    const first = calculateSessionStatistics(input);
    const second = calculateSessionStatistics(input);
    expect(first).toEqual(second);
  });

  it('16. non-positive segment time does not produce negative/NaN/Infinity speed', () => {
    const equalTimestamps = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 1000 }), // same timestamp: delta = 0
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 1000 }),
    });
    expect(Number.isFinite(equalTimestamps.currentSpeedMetersPerSecond)).toBe(true);
    expect(equalTimestamps.currentSpeedMetersPerSecond).toBe(0);
    expect(equalTimestamps.distanceMeters).toBe(0);

    const reversedOrder = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 2000 }),
        point({ latitude: 0.001, longitude: 0, timestamp: 1000 }), // moves backward in time
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
    });
    expect(Number.isFinite(reversedOrder.currentSpeedMetersPerSecond)).toBe(true);
    expect(Number.isNaN(reversedOrder.currentSpeedMetersPerSecond)).toBe(false);
    expect(reversedOrder.distanceMeters).toBe(0);
  });
});

describe('StatisticsCalculator — purity and determinism', () => {
  it('17. input arrays/objects are not mutated', () => {
    const routePoints = [
      point({ latitude: 0, longitude: 0, timestamp: 1000 }),
      point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
    ];
    const lifecycleInput = lifecycle({
      startedAt: 1000,
      stoppedAt: 2000,
      pauseIntervals: [{ pausedAt: 1500, resumedAt: 1600 }],
    });
    const routePointsSnapshot = JSON.parse(JSON.stringify(routePoints));
    const lifecycleSnapshot = JSON.parse(JSON.stringify(lifecycleInput));

    calculateSessionStatistics({ routePoints, lifecycle: lifecycleInput });

    expect(routePoints).toEqual(routePointsSnapshot);
    expect(lifecycleInput).toEqual(lifecycleSnapshot);
  });

  it('18. identical input produces identical output', () => {
    const input = {
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }),
        point({ latitude: 0.002, longitude: 0, timestamp: 2000 }),
        point({ latitude: 0.004, longitude: 0, timestamp: 3000 }),
      ],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 3000 }),
    };
    expect(calculateSessionStatistics(input)).toEqual(calculateSessionStatistics(input));
  });

  it('19. the Calculator has no hidden mutable session state between calls', () => {
    const callA = () =>
      calculateSessionStatistics({
        routePoints: [
          point({ latitude: 0, longitude: 0, timestamp: 1000 }),
          point({ latitude: 0.001, longitude: 0, timestamp: 2000 }),
        ],
        lifecycle: lifecycle({ startedAt: 1000, stoppedAt: 2000 }),
      });

    const firstResultA = callA();

    // An unrelated call with very different data in between:
    calculateSessionStatistics({
      routePoints: [
        point({ latitude: 10, longitude: 10, timestamp: 100000 }),
        point({ latitude: 10.01, longitude: 10, timestamp: 200000 }),
      ],
      lifecycle: lifecycle({ startedAt: 100000, stoppedAt: 200000 }),
    });

    const secondResultA = callA();
    expect(secondResultA).toEqual(firstResultA);
  });
});

describe('StatisticsCalculator — realistic multi-point route (internal consistency)', () => {
  it('20. produces internally consistent distance/speed/average/max across a multi-segment route with a mid-route pause', () => {
    const stats = calculateSessionStatistics({
      routePoints: [
        point({ latitude: 0, longitude: 0, timestamp: 1000 }), // P1
        point({ latitude: 0.002, longitude: 0, timestamp: 2000 }), // P2 — fast segment (~222m/s)
        point({ latitude: 0.003, longitude: 0, timestamp: 3000 }), // P3 — medium segment (~111m/s)
        point({ latitude: 0.003, longitude: 0, timestamp: 5000 }), // P4 — right after resume
        point({ latitude: 0.0035, longitude: 0, timestamp: 6000 }), // P5 — slow segment (~55.6m/s)
      ],
      lifecycle: lifecycle({
        startedAt: 1000,
        stoppedAt: 6000,
        pauseIntervals: [{ pausedAt: 3000, resumedAt: 5000 }],
      }),
    });

    // Three valid segments: P1→P2, P2→P3, P4→P5 (P3→P4 excluded — spans pause).
    expect(stats.distanceMeters).toBeGreaterThan(385);
    expect(stats.distanceMeters).toBeLessThan(395);

    // Current speed = latest valid segment (P4→P5, the slowest):
    expect(stats.currentSpeedMetersPerSecond).toBeGreaterThan(50);
    expect(stats.currentSpeedMetersPerSecond).toBeLessThan(61);

    // Max speed = P1→P2, the fastest:
    expect(stats.maxSpeedMetersPerSecond).toBeGreaterThan(200);

    // Internal consistency: current is not the max here, and max is the largest of all:
    expect(stats.currentSpeedMetersPerSecond).toBeLessThan(stats.maxSpeedMetersPerSecond);

    // Elapsed active time excludes the 2000ms pause:
    expect(stats.elapsedActiveMs).toBe(6000 - 1000 - 2000);

    // Average speed is between the extremes of the individual segments:
    expect(stats.averageSpeedMetersPerSecond).toBeGreaterThan(stats.currentSpeedMetersPerSecond * 0.5);
    expect(stats.averageSpeedMetersPerSecond).toBeLessThan(stats.maxSpeedMetersPerSecond);
  });
});

describe('StatisticsCalculator — elapsed active time is independent of RoutePoint count (rule 5 vs rule 7)', () => {
  it('elapsedActiveMs can be nonzero even with zero RoutePoints (distance/speed remain zero per rule 7)', () => {
    const stats = calculateSessionStatistics({
      routePoints: [],
      lifecycle: lifecycle({ startedAt: 0, stoppedAt: 30000 }),
    });
    expect(stats.elapsedActiveMs).toBe(30000);
    expect(stats).toMatchObject(ZERO_STATS);
  });

  it('flagged design decision: an in-progress session (stoppedAt null) derives elapsed time from the latest known timestamp, never Date.now()', () => {
    const stats = calculateSessionStatistics({
      routePoints: [point({ latitude: 0, longitude: 0, timestamp: 4000 })],
      lifecycle: lifecycle({ startedAt: 1000, stoppedAt: null }),
    });
    // Latest known timestamp is the single RoutePoint's (4000ms):
    expect(stats.elapsedActiveMs).toBe(4000 - 1000);
  });

  it('flagged design decision: elapsed time freezes at the moment of pausing while currently mid-pause with no stoppedAt', () => {
    const stats = calculateSessionStatistics({
      routePoints: [point({ latitude: 0, longitude: 0, timestamp: 2000 })], // last point before pause
      lifecycle: lifecycle({
        startedAt: 1000,
        stoppedAt: null,
        pauseIntervals: [{ pausedAt: 3000, resumedAt: null }], // currently open pause
      }),
    });
    // referenceEnd = max(1000, 3000, 2000) = 3000 (the pause instant itself)
    // elapsed = (3000 - 1000) - overlap(3000..3000) = 2000 - 0 = 2000
    expect(stats.elapsedActiveMs).toBe(2000);
  });
});