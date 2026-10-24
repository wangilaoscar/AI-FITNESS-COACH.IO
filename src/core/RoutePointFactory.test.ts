// RoutePointFactory.test.ts
// Tests the Factory's EXISTING public contract only (Milestone 4 + Rev 1.1):
//   - a pure 1:1 transformation: one admitted LocationUpdate in, exactly one RoutePoint out;
//   - only the three fields RoutePoint's locked domain contract defines are promoted
//     (latitude, longitude, timestamp);
//   - the timestamp is preserved exactly; speed (and every other field) is never copied;
//   - it decides nothing: no admissibility check, no accuracy filtering, no de-duplication,
//     no route-density policy (none exists in the locked architecture);
//   - the result is immutable, and the input is never mutated.

import * as factoryModule from './RoutePointFactory';
import { createRoutePoint } from './RoutePointFactory';
import type { LocationUpdate } from '../features/gps/types/gps.types';

const update = (overrides: Partial<LocationUpdate> = {}): LocationUpdate => ({
  latitude: -1.2921,
  longitude: 36.8219,
  altitude: 1661,
  accuracy: 5,
  heading: 90,
  speed: 3.2,
  timestamp: 1700000000123,
  ...overrides,
});

describe('RoutePointFactory — mapping', () => {
  it('promotes latitude, longitude, and timestamp exactly', () => {
    expect(createRoutePoint(update())).toEqual({
      latitude: -1.2921,
      longitude: 36.8219,
      timestamp: 1700000000123,
    });
  });

  it('produces a RoutePoint with exactly the three contract fields — nothing else', () => {
    expect(Object.keys(createRoutePoint(update())).sort()).toEqual(['latitude', 'longitude', 'timestamp']);
  });

  it.each([
    ['altitude', { altitude: 9999 }],
    ['accuracy', { accuracy: 123 }],
    ['heading', { heading: 270 }],
    ['speed', { speed: 99 }],
  ] as const)('never copies or depends on %s: varying it changes nothing', (_field, override) => {
    expect(createRoutePoint(update(override))).toEqual(createRoutePoint(update()));
  });

  it('treats null optional fields (altitude, heading, speed) like any other value', () => {
    const point = createRoutePoint(update({ altitude: null, heading: null, speed: null }));
    expect(point).toEqual({ latitude: -1.2921, longitude: 36.8219, timestamp: 1700000000123 });
  });

  it.each([0, 1, 1234.5678, 1700000000123, Number.MAX_SAFE_INTEGER])(
    'preserves the timestamp exactly — never generated, rounded, or derived (%p)',
    (timestamp) => {
      expect(createRoutePoint(update({ timestamp })).timestamp).toBe(timestamp);
    }
  );

  it('does not re-validate: values pass through verbatim, since admissibility is the Gate\'s job', () => {
    const point = createRoutePoint(update({ latitude: 999.5, longitude: -999.5 }));
    expect(point.latitude).toBe(999.5);
    expect(point.longitude).toBe(-999.5);
  });
});

describe('RoutePointFactory — immutability and purity', () => {
  it('returns an immutable RoutePoint: writes are refused and the value is unchanged', () => {
    const point = createRoutePoint(update());

    expect(Object.isFrozen(point)).toBe(true);
    try {
      (point as unknown as { latitude: number }).latitude = 0;
      (point as unknown as { extra: number }).extra = 1;
    } catch {
      /* strict mode throws on frozen objects; either way the write is refused */
    }

    expect(point).toEqual({ latitude: -1.2921, longitude: 36.8219, timestamp: 1700000000123 });
  });

  it('returns a new object, never the LocationUpdate itself', () => {
    const input = update();
    const point = createRoutePoint(input);
    expect(point).not.toBe(input);
  });

  it('never mutates its input (the LocationUpdate stays unfrozen and unchanged)', () => {
    const input = update();
    const snapshot = { ...input };

    createRoutePoint(input);

    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('is deterministic and retains no state between calls', () => {
    const first = createRoutePoint(update({ timestamp: 1000 }));
    createRoutePoint(update({ latitude: 5, longitude: 6, timestamp: 2000 }));
    createRoutePoint(update({ latitude: 7, longitude: 8, timestamp: 3000 }));
    const again = createRoutePoint(update({ timestamp: 1000 }));

    expect(again).toEqual(first);
    expect(again).not.toBe(first); // a fresh object each call, not a cached one
  });

  it('exports only createRoutePoint — no policy, filter, or state API', () => {
    expect(Object.keys(factoryModule)).toEqual(['createRoutePoint']);
  });
});

describe('RoutePointFactory — exactly one RoutePoint per admitted LocationUpdate (no filtering, no density policy)', () => {
  it('maps N updates to N RoutePoints, in the same order', () => {
    const updates = [1000, 2000, 3000, 4000].map((timestamp, i) =>
      update({ latitude: i, longitude: i * 2, timestamp })
    );

    const points = updates.map(createRoutePoint);

    expect(points).toHaveLength(4);
    expect(points.map((p) => p.timestamp)).toEqual([1000, 2000, 3000, 4000]);
    expect(points.map((p) => p.latitude)).toEqual([0, 1, 2, 3]);
  });

  it('does not thin a dense stream: 1000 updates at the same place still yield 1000 RoutePoints', () => {
    const points = Array.from({ length: 1000 }, (_unused, i) => createRoutePoint(update({ timestamp: 1000 + i })));
    expect(points).toHaveLength(1000);
  });

  it('does not filter by accuracy: a very inaccurate update still produces a RoutePoint', () => {
    const point = createRoutePoint(update({ accuracy: 100000 }));
    expect(point).toEqual({ latitude: -1.2921, longitude: 36.8219, timestamp: 1700000000123 });
  });

  it('does not de-duplicate: two identical updates yield two equal, distinct RoutePoints', () => {
    const a = createRoutePoint(update());
    const b = createRoutePoint(update());

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});