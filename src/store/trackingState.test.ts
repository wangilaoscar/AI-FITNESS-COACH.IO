// trackingState.test.ts
// Tests the pure projection in trackingState.ts against its documented contract:
//   - createInitialTrackingState / reduceTrackingState, all nine locked DomainEvents;
//   - approved decisions 1-4 (no-session deltas are no-ops; lastRecord persists until replaced;
//     status is derived, not stored; terminal events leave the documented IDLE reset);
//   - reference preservation for untouched fields, immutability, totality;
//   - replay against the REAL engine, comparing the projection with the Aggregate at every event
//     boundary — including the intermediate instant between RoutePointRecorded and StatisticsUpdated.
//
// The integration tests use only objects this file constructs and passes to the engine (the same way the
// Step 11 tests do): the Aggregate's public getters and EventPublisher's public subscribe(). Nothing
// reaches into engine internals.

import * as trackingStateModule from './trackingState';
import { createInitialTrackingState, reduceTrackingState } from './trackingState';
import type { TrackingState } from './trackingState';
import { TrackingEngine } from '../core/TrackingEngine';
import { SessionAggregate } from '../core/SessionAggregate';
import { EventPublisher } from '../core/EventPublisher';
import type { DomainEvent } from '../core/EventPublisher';
import type { GPSHealth, LocationUpdate } from '../features/gps/types/gps.types';
import type {
  RoutePoint,
  SessionRecord,
  SessionStatistics,
  SessionStatus,
  TrackingSession,
  UserPreferences,
} from '../types/session.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PREFS: UserPreferences = { accuracyTier: 'balanced' };

const point = (timestamp: number, latitude = 0, longitude = 0): RoutePoint => ({ latitude, longitude, timestamp });

const stats = (overrides: Partial<SessionStatistics> = {}): SessionStatistics => ({
  distanceMeters: 0,
  currentSpeedMetersPerSecond: 0,
  averageSpeedMetersPerSecond: 0,
  maxSpeedMetersPerSecond: 0,
  elapsedActiveMs: 0,
  ...overrides,
});

const makeSession = (overrides: Partial<TrackingSession> = {}): TrackingSession => ({
  status: 'ACTIVE',
  gpsConfiguration: { opaqueField: 'opaque-config' },
  route: [point(2000, 1, 1)],
  statistics: stats({ distanceMeters: 5, elapsedActiveMs: 1000 }),
  lifecycle: { startedAt: 1000, stoppedAt: null, pauseIntervals: [] },
  ...overrides,
});

// GPSHealth / GPSConfiguration are opaque in the locked domain; these fields are deliberately meaningless.
const healthA: GPSHealth = { opaqueField: 'health-A' };
const healthB: GPSHealth = { opaqueField: 'health-B' };

const makeRecord = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  route: [point(2000, 1, 1)],
  statistics: stats({ distanceMeters: 5 }),
  lifecycle: { startedAt: 1000, stoppedAt: 3000, pauseIntervals: [] },
  gpsConfiguration: { opaqueField: 'opaque-config' },
  ...overrides,
});

const recordA = makeRecord();
const recordB = makeRecord({ statistics: stats({ distanceMeters: 99 }) });

/** A populated state: live ACTIVE session, a known health, and a previously produced record. */
const populated = (): TrackingState => ({
  session: makeSession(),
  gpsHealth: healthA,
  lastRecord: recordA,
});

/** Status is NOT stored by the projection; it is derived exactly as SessionAggregate.getCurrentStatus() does. */
const statusOf = (state: TrackingState): SessionStatus => state.session?.status ?? 'IDLE';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

const ALL_EVENTS = (): DomainEvent[] => [
  { type: 'SessionStarted', session: makeSession({ route: [] }) },
  { type: 'SessionPaused', session: makeSession({ status: 'PAUSED' }) },
  { type: 'SessionResumed', session: makeSession() },
  { type: 'SessionStopped', session: makeSession({ status: 'STOPPED' }) },
  { type: 'RoutePointRecorded', routePoint: point(3000, 2, 2) },
  { type: 'StatisticsUpdated', statistics: stats({ distanceMeters: 9, elapsedActiveMs: 2000 }) },
  { type: 'GPSHealthChanged', gpsHealth: healthB },
  { type: 'SessionRecordProduced', sessionRecord: recordB },
  { type: 'SessionDiscarded' },
];

// ---------------------------------------------------------------------------
// createInitialTrackingState
// ---------------------------------------------------------------------------

describe('createInitialTrackingState', () => {
  it('with no live session: session, gpsHealth, and lastRecord are all null (derived status IDLE)', () => {
    const state = createInitialTrackingState(null);

    expect(state).toEqual({ session: null, gpsHealth: null, lastRecord: null });
    expect(statusOf(state)).toBe('IDLE');
  });

  it('with a live session: stores that exact snapshot by reference; gpsHealth and lastRecord start null', () => {
    const live = makeSession({ status: 'PAUSED' });

    const state = createInitialTrackingState(live);

    expect(state.session).toBe(live);
    expect(state.gpsHealth).toBeNull();
    expect(state.lastRecord).toBeNull();
    expect(statusOf(state)).toBe('PAUSED');
  });

  it('returns exactly the three contract fields', () => {
    expect(Object.keys(createInitialTrackingState(null)).sort()).toEqual(['gpsHealth', 'lastRecord', 'session']);
  });
});

// ---------------------------------------------------------------------------
// reduceTrackingState — each of the nine events, with reference preservation
// ---------------------------------------------------------------------------

describe('reduceTrackingState — session snapshot events replace the session and touch nothing else', () => {
  it.each(['SessionStarted', 'SessionPaused', 'SessionResumed', 'SessionStopped'] as const)(
    '%s: session becomes the event snapshot (same reference); gpsHealth and lastRecord keep their references',
    (type) => {
      const before = populated();
      const snapshot = makeSession({ status: 'PAUSED', route: [point(9000, 3, 3)] });

      const after = reduceTrackingState(before, { type, session: snapshot });

      expect(after.session).toBe(snapshot);
      expect(after.gpsHealth).toBe(before.gpsHealth);
      expect(after.lastRecord).toBe(before.lastRecord);
    }
  );

  it('derived status follows the snapshot: Started/Resumed → ACTIVE, Paused → PAUSED, Stopped → STOPPED', () => {
    const base = createInitialTrackingState(null);
    const derive = (type: 'SessionStarted' | 'SessionPaused' | 'SessionResumed' | 'SessionStopped', status: SessionStatus) =>
      statusOf(reduceTrackingState(base, { type, session: makeSession({ status }) }));

    expect(derive('SessionStarted', 'ACTIVE')).toBe('ACTIVE');
    expect(derive('SessionPaused', 'PAUSED')).toBe('PAUSED');
    expect(derive('SessionResumed', 'ACTIVE')).toBe('ACTIVE');
    expect(derive('SessionStopped', 'STOPPED')).toBe('STOPPED');
  });
});

describe('reduceTrackingState — RoutePointRecorded', () => {
  it('appends the point to the live route in order, as a NEW array; the old route is untouched', () => {
    const before = populated();
    const oldRoute = before.session!.route;
    const newPoint = point(3000, 2, 2);

    const after = reduceTrackingState(before, { type: 'RoutePointRecorded', routePoint: newPoint });

    expect(after.session!.route).toEqual([point(2000, 1, 1), newPoint]);
    expect(after.session!.route[1]).toBe(newPoint);
    expect(after.session!.route).not.toBe(oldRoute);
    expect(oldRoute).toHaveLength(1);
  });

  it('preserves every other reference: the session\'s status/config/statistics/lifecycle, gpsHealth, and lastRecord', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'RoutePointRecorded', routePoint: point(3000) });

    expect(after.session).not.toBe(before.session);
    expect(after.session!.status).toBe(before.session!.status);
    expect(after.session!.gpsConfiguration).toBe(before.session!.gpsConfiguration);
    expect(after.session!.statistics).toBe(before.session!.statistics);
    expect(after.session!.lifecycle).toBe(before.session!.lifecycle);
    expect(after.gpsHealth).toBe(before.gpsHealth);
    expect(after.lastRecord).toBe(before.lastRecord);
  });
});

describe('reduceTrackingState — StatisticsUpdated', () => {
  it('replaces the live statistics with the event\'s object (same reference)', () => {
    const before = populated();
    const next = stats({ distanceMeters: 42, elapsedActiveMs: 2000 });

    const after = reduceTrackingState(before, { type: 'StatisticsUpdated', statistics: next });

    expect(after.session!.statistics).toBe(next);
  });

  it('preserves every other reference, including the route array itself', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'StatisticsUpdated', statistics: stats({ distanceMeters: 1 }) });

    expect(after.session!.route).toBe(before.session!.route);
    expect(after.session!.status).toBe(before.session!.status);
    expect(after.session!.gpsConfiguration).toBe(before.session!.gpsConfiguration);
    expect(after.session!.lifecycle).toBe(before.session!.lifecycle);
    expect(after.gpsHealth).toBe(before.gpsHealth);
    expect(after.lastRecord).toBe(before.lastRecord);
  });
});

describe('reduceTrackingState — GPSHealthChanged', () => {
  it('replaces gpsHealth with the event\'s object (same reference, never copied or interpreted)', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'GPSHealthChanged', gpsHealth: healthB });

    expect(after.gpsHealth).toBe(healthB);
  });

  it('never touches the session or lastRecord (their references are preserved)', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'GPSHealthChanged', gpsHealth: healthB });

    expect(after.session).toBe(before.session);
    expect(after.lastRecord).toBe(before.lastRecord);
  });

  it('is applied whether or not a session is live', () => {
    const idle = createInitialTrackingState(null);

    const after = reduceTrackingState(idle, { type: 'GPSHealthChanged', gpsHealth: healthB });

    expect(after.gpsHealth).toBe(healthB);
    expect(after.session).toBeNull();
  });
});

describe('reduceTrackingState — terminal events (decision 4: consistent with the documented reset to IDLE)', () => {
  it('SessionRecordProduced: session becomes null and lastRecord becomes the event\'s record (same reference); gpsHealth preserved', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'SessionRecordProduced', sessionRecord: recordB });

    expect(after.session).toBeNull();
    expect(after.lastRecord).toBe(recordB);
    expect(after.gpsHealth).toBe(before.gpsHealth);
  });

  it('SessionDiscarded: session becomes null; gpsHealth and lastRecord preserved', () => {
    const before = populated();

    const after = reduceTrackingState(before, { type: 'SessionDiscarded' });

    expect(after.session).toBeNull();
    expect(after.gpsHealth).toBe(before.gpsHealth);
    expect(after.lastRecord).toBe(before.lastRecord);
  });

  it.each(['ACTIVE', 'PAUSED', 'STOPPED'] as const)(
    'from a %s session, both terminal events leave derived status IDLE',
    (status) => {
      const before: TrackingState = { ...populated(), session: makeSession({ status }) };

      expect(statusOf(reduceTrackingState(before, { type: 'SessionRecordProduced', sessionRecord: recordB }))).toBe('IDLE');
      expect(statusOf(reduceTrackingState(before, { type: 'SessionDiscarded' }))).toBe('IDLE');
    }
  );
});

// ---------------------------------------------------------------------------
// Approved decisions 1 and 2
// ---------------------------------------------------------------------------

describe('decision 1 — route/statistics deltas with no live session return the existing state unchanged', () => {
  const noSession = (): TrackingState => ({ session: null, gpsHealth: healthA, lastRecord: recordA });

  it('RoutePointRecorded with no live session returns the very same state reference', () => {
    const state = noSession();
    expect(reduceTrackingState(state, { type: 'RoutePointRecorded', routePoint: point(3000) })).toBe(state);
  });

  it('StatisticsUpdated with no live session returns the very same state reference', () => {
    const state = noSession();
    expect(reduceTrackingState(state, { type: 'StatisticsUpdated', statistics: stats({ distanceMeters: 1 }) })).toBe(state);
  });

  it('neither throws, including on the initial IDLE state', () => {
    const idle = createInitialTrackingState(null);
    expect(() => reduceTrackingState(idle, { type: 'RoutePointRecorded', routePoint: point(1) })).not.toThrow();
    expect(() => reduceTrackingState(idle, { type: 'StatisticsUpdated', statistics: stats() })).not.toThrow();
  });
});

describe('decision 2 — lastRecord persists until a later SessionRecordProduced replaces it', () => {
  it('is preserved by every event except SessionRecordProduced', () => {
    for (const event of ALL_EVENTS()) {
      if (event.type === 'SessionRecordProduced') continue;
      expect(reduceTrackingState(populated(), event).lastRecord).toBe(recordA);
    }
  });

  it('is NOT cleared when a new session starts or when a session is discarded', () => {
    let state: TrackingState = { session: null, gpsHealth: null, lastRecord: recordA };

    state = reduceTrackingState(state, { type: 'SessionStarted', session: makeSession({ route: [] }) });
    expect(state.lastRecord).toBe(recordA);

    state = reduceTrackingState(state, { type: 'SessionDiscarded' });
    expect(state.lastRecord).toBe(recordA);
  });

  it('is replaced by a later SessionRecordProduced', () => {
    const after = reduceTrackingState(populated(), { type: 'SessionRecordProduced', sessionRecord: recordB });
    expect(after.lastRecord).toBe(recordB);
    expect(after.lastRecord).not.toBe(recordA);
  });
});

// ---------------------------------------------------------------------------
// Immutability and totality
// ---------------------------------------------------------------------------

describe('reduceTrackingState — immutability', () => {
  it.each(ALL_EVENTS().map((event) => [event.type, event] as const))(
    '%s: a deeply frozen state and event are accepted, and the input state is unchanged afterwards',
    (_type, event) => {
      const frozenState = deepFreeze(populated());
      const frozenEvent = deepFreeze(event);
      const snapshotBefore = JSON.stringify(frozenState);

      let after: TrackingState | undefined;
      expect(() => {
        after = reduceTrackingState(frozenState, frozenEvent);
      }).not.toThrow();

      expect(JSON.stringify(frozenState)).toBe(snapshotBefore);
      expect(after).not.toBe(frozenState); // an effectful event yields a new state object
    }
  );

  it('does not freeze, copy, or alter the event payloads it stores', () => {
    const snapshot = makeSession();
    const health: GPSHealth = { opaqueField: 'unfrozen' };

    const after = reduceTrackingState(
      reduceTrackingState(createInitialTrackingState(null), { type: 'SessionStarted', session: snapshot }),
      { type: 'GPSHealthChanged', gpsHealth: health }
    );

    expect(after.session).toBe(snapshot);
    expect(after.gpsHealth).toBe(health);
    expect(Object.isFrozen(health)).toBe(false);
  });
});

describe('reduceTrackingState — totality', () => {
  const sessions: Array<TrackingSession | null> = [
    null,
    makeSession({ status: 'ACTIVE' }),
    makeSession({ status: 'PAUSED' }),
    makeSession({ status: 'STOPPED' }),
  ];
  const states: TrackingState[] = [];
  for (const session of sessions)
    for (const gpsHealth of [null, healthA])
      for (const lastRecord of [null, recordA]) states.push({ session, gpsHealth, lastRecord });

  it('never throws, and always returns a state with exactly the three contract fields, for every event on every state shape', () => {
    expect(states).toHaveLength(16);
    for (const state of states) {
      for (const event of ALL_EVENTS()) {
        let result: TrackingState | undefined;
        expect(() => {
          result = reduceTrackingState(state, event);
        }).not.toThrow();
        expect(Object.keys(result!).sort()).toEqual(['gpsHealth', 'lastRecord', 'session']);
      }
    }
  });

  it('defensively leaves the state unchanged for an out-of-contract event value (the function stays total)', () => {
    const state = populated();
    const bogus = { type: 'NotARealEvent' } as unknown as DomainEvent;

    expect(reduceTrackingState(state, bogus)).toBe(state);
  });
});

describe('trackingState module surface', () => {
  it('exports only the two pure functions — no subscription, store, or side-effect API', () => {
    expect(Object.keys(trackingStateModule).sort()).toEqual(['createInitialTrackingState', 'reduceTrackingState']);
  });
});

// ---------------------------------------------------------------------------
// Replay against the REAL engine — state compared at EVERY event boundary
// ---------------------------------------------------------------------------

const loc = (latitude: number, timestamp: number): LocationUpdate => ({
  latitude,
  longitude: 0,
  altitude: null,
  accuracy: 5,
  heading: null,
  speed: 3,
  timestamp,
});

interface Boundary {
  readonly event: DomainEvent;
  readonly projected: TrackingState;
  readonly aggregateSession: TrackingSession | null;
  readonly aggregateStatus: SessionStatus;
}

/**
 * A real engine plus a projection listener. `join()` performs the recommended atomic
 * "read the Aggregate, then subscribe" in one synchronous block; every delivered event is
 * folded through the reducer and recorded together with what the Aggregate holds AT THAT INSTANT.
 */
function harness() {
  const aggregate = new SessionAggregate();
  const eventPublisher = new EventPublisher();
  const engine = new TrackingEngine({ aggregate, eventPublisher });
  const boundaries: Boundary[] = [];
  let projected = createInitialTrackingState(null);

  const listener = (event: DomainEvent): void => {
    projected = reduceTrackingState(projected, event);
    boundaries.push({
      event,
      projected,
      aggregateSession: aggregate.getCurrentSession(),
      aggregateStatus: aggregate.getCurrentStatus(),
    });
  };

  return {
    aggregate,
    engine,
    boundaries,
    current: () => projected,
    join: () => {
      projected = createInitialTrackingState(aggregate.getCurrentSession());
      eventPublisher.subscribe(listener);
    },
  };
}

const SNAPSHOT_EVENTS = ['SessionStarted', 'SessionPaused', 'SessionResumed', 'SessionStopped'];

/** The projection must equal the Aggregate at every boundary — by value, and by reference for snapshot events. */
function expectEveryBoundaryMirrorsAggregate(boundaries: Boundary[]): void {
  for (const boundary of boundaries) {
    expect(statusOf(boundary.projected)).toBe(boundary.aggregateStatus);
    expect(boundary.projected.session).toEqual(boundary.aggregateSession);
    if (SNAPSHOT_EVENTS.includes(boundary.event.type)) {
      expect(boundary.projected.session).toBe(boundary.aggregateSession);
    }
  }
}

describe('replay against the real engine — projection equals the Aggregate at every event boundary', () => {
  function runFullScenario(h: ReturnType<typeof harness>) {
    const { engine } = h;
    // ---- Session 1: Start → move → GPS health → Pause (rejected fix) → Resume → move → Stop → Save
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(loc(0, 2000));
    engine.processLocationUpdate(loc(0.001, 3000));
    engine.processGPSHealth(healthA);
    engine.processCommand({ command: 'PauseSession', timestamp: 4000 });
    engine.processLocationUpdate(loc(0.0015, 4500)); // PAUSED → rejected: no event, no boundary
    engine.processCommand({ command: 'ResumeSession', timestamp: 5000 });
    engine.processLocationUpdate(loc(0.002, 6000));
    engine.processCommand({ command: 'StopSession', timestamp: 7000 });
    engine.processCommand({ command: 'SaveSession', timestamp: 8000 });
    engine.processGPSHealth(healthB); // while IDLE
    // ---- Session 2 (earlier timestamps — the Gate was reset): Start → move → Stop → Discard
    engine.processCommand({ command: 'StartSession', timestamp: 100, userPreferences: PREFS });
    engine.processLocationUpdate(loc(5, 200));
    engine.processCommand({ command: 'StopSession', timestamp: 300 });
    engine.processCommand({ command: 'DiscardSession', timestamp: 400 });
  }

  const EXPECTED_SEQUENCE = [
    'SessionStarted',
    'RoutePointRecorded', 'StatisticsUpdated',
    'RoutePointRecorded', 'StatisticsUpdated',
    'GPSHealthChanged',
    'SessionPaused',
    'SessionResumed',
    'RoutePointRecorded', 'StatisticsUpdated',
    'SessionStopped',
    'SessionRecordProduced',
    'GPSHealthChanged',
    'SessionStarted',
    'RoutePointRecorded', 'StatisticsUpdated',
    'SessionStopped',
    'SessionDiscarded',
  ];

  it('the scenario publishes exactly the expected event sequence (guards against a vacuous replay)', () => {
    const h = harness();
    h.join();
    runFullScenario(h);

    expect(h.boundaries.map((b) => b.event.type)).toEqual(EXPECTED_SEQUENCE);
  });

  it('at EVERY boundary: derived status, and the session, equal what the Aggregate holds at that instant', () => {
    const h = harness();
    h.join();
    runFullScenario(h);

    expectEveryBoundaryMirrorsAggregate(h.boundaries);
  });

  it('the intermediate instant between RoutePointRecorded and StatisticsUpdated matches the Aggregate: new point present, statistics still the previous ones', () => {
    const h = harness();
    h.join();
    runFullScenario(h);
    const [afterFirstStats, midpoint, afterSecondStats] = [h.boundaries[2], h.boundaries[3], h.boundaries[4]];

    // Sequence check: boundary 3 is the 2nd RoutePointRecorded, boundary 4 its StatisticsUpdated.
    expect(midpoint.event.type).toBe('RoutePointRecorded');
    expect(afterSecondStats.event.type).toBe('StatisticsUpdated');

    // After the 1st point's statistics: elapsed = 2000 - 1000.
    expect(afterFirstStats.projected.session!.statistics.elapsedActiveMs).toBe(1000);

    // MIDPOINT — projection and Aggregate agree: 2 route points, statistics still the previous ones.
    expect(midpoint.projected.session!.route).toHaveLength(2);
    expect(midpoint.projected.session!.statistics).toBe(afterFirstStats.projected.session!.statistics);
    expect(midpoint.projected.session!.statistics.elapsedActiveMs).toBe(1000);
    expect(midpoint.aggregateSession!.route).toHaveLength(2);
    expect(midpoint.aggregateSession!.statistics.elapsedActiveMs).toBe(1000);
    expect(midpoint.projected.session).toEqual(midpoint.aggregateSession);

    // After StatisticsUpdated — statistics advance (3000 - 1000) while the route array is untouched (same reference).
    expect(afterSecondStats.projected.session!.statistics.elapsedActiveMs).toBe(2000);
    expect(afterSecondStats.projected.session!.route).toBe(midpoint.projected.session!.route);
    expect(afterSecondStats.projected.session).toEqual(afterSecondStats.aggregateSession);
  });

  it('GPS health is tracked independently of the session, by reference, in any status', () => {
    const h = harness();
    h.join();
    runFullScenario(h);
    const healthWhileActive = h.boundaries[5]; // GPSHealthChanged mid-session
    const healthWhileIdle = h.boundaries[12]; // GPSHealthChanged after Save

    expect(healthWhileActive.event.type).toBe('GPSHealthChanged');
    expect(healthWhileActive.projected.gpsHealth).toBe(healthA);
    expect(healthWhileActive.projected.session).toBe(h.boundaries[4].projected.session); // session untouched

    expect(healthWhileIdle.event.type).toBe('GPSHealthChanged');
    expect(healthWhileIdle.projected.gpsHealth).toBe(healthB);
    expect(healthWhileIdle.projected.session).toBeNull();
    expect(statusOf(healthWhileIdle.projected)).toBe('IDLE');
  });

  it('terminal events leave the documented reset to IDLE; lastRecord is set by Save and persists through the next session and its Discard', () => {
    const h = harness();
    h.join();
    runFullScenario(h);
    const saved = h.boundaries[11];
    const discarded = h.boundaries[17];
    const secondSessionStart = h.boundaries[13];

    expect(saved.event.type).toBe('SessionRecordProduced');
    const producedRecord = (saved.event as Extract<DomainEvent, { type: 'SessionRecordProduced' }>).sessionRecord;
    expect(saved.projected.session).toBeNull();
    expect(saved.aggregateSession).toBeNull();
    expect(saved.aggregateStatus).toBe('IDLE');
    expect(saved.projected.lastRecord).toBe(producedRecord);
    expect(producedRecord.route.map((p) => p.timestamp)).toEqual([2000, 3000, 6000]);

    expect(secondSessionStart.event.type).toBe('SessionStarted');
    expect(secondSessionStart.projected.lastRecord).toBe(producedRecord); // decision 2: a new session does not clear it

    expect(discarded.event.type).toBe('SessionDiscarded');
    expect(discarded.projected.session).toBeNull();
    expect(discarded.aggregateStatus).toBe('IDLE');
    expect(discarded.projected.lastRecord).toBe(producedRecord); // decision 2: Discard does not clear it
    expect(statusOf(discarded.projected)).toBe('IDLE');
  });

  it('the Stop boundary carries the finalized statistics (elapsed to stoppedAt, paused time excluded) exactly as the Aggregate holds them', () => {
    const h = harness();
    h.join();
    runFullScenario(h);
    const stopped = h.boundaries[10];

    expect(stopped.event.type).toBe('SessionStopped');
    expect(stopped.projected.session!.status).toBe('STOPPED');
    // (7000 - 1000) active span minus the 4000→5000 pause = 5000
    expect(stopped.projected.session!.statistics.elapsedActiveMs).toBe(5000);
    expect(stopped.projected.session).toBe(stopped.aggregateSession);
  });
});

describe('replay against the real engine — joining mid-session (read the Aggregate, then subscribe, synchronously)', () => {
  it('a late joiner starts equal to the Aggregate and then mirrors it at every subsequent boundary', () => {
    const h = harness();
    h.engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    h.engine.processLocationUpdate(loc(0, 2000));
    h.engine.processGPSHealth(healthA); // published BEFORE the join — nobody was listening

    h.join(); // atomic: read, then subscribe

    expect(h.current().session).toBe(h.aggregate.getCurrentSession());
    expect(statusOf(h.current())).toBe(h.aggregate.getCurrentStatus());

    h.engine.processLocationUpdate(loc(0.001, 3000));
    h.engine.processCommand({ command: 'PauseSession', timestamp: 4000 });
    h.engine.processCommand({ command: 'ResumeSession', timestamp: 5000 });
    h.engine.processCommand({ command: 'StopSession', timestamp: 6000 });
    h.engine.processCommand({ command: 'SaveSession', timestamp: 7000 });

    expect(h.boundaries.map((b) => b.event.type)).toEqual([
      'RoutePointRecorded', 'StatisticsUpdated',
      'SessionPaused', 'SessionResumed', 'SessionStopped', 'SessionRecordProduced',
    ]);
    expectEveryBoundaryMirrorsAggregate(h.boundaries);
    expect(statusOf(h.current())).toBe('IDLE');
    expect(h.current().session).toBeNull();
  });

  it('documented limitation: GPS health published before joining is unrecoverable (no contract retains it); the record produced after joining is captured', () => {
    const h = harness();
    h.engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    h.engine.processGPSHealth(healthA); // before the join

    h.join();

    expect(h.current().gpsHealth).toBeNull();
    expect(h.current().lastRecord).toBeNull();

    h.engine.processCommand({ command: 'StopSession', timestamp: 2000 });
    h.engine.processCommand({ command: 'SaveSession', timestamp: 3000 });

    expect(h.current().lastRecord).not.toBeNull();
    expect(h.current().session).toBeNull();
  });

  it('joining while IDLE yields the same projection as joining before the first command', () => {
    const early = harness();
    early.join();
    const late = harness();
    late.join(); // IDLE aggregate: nothing yet happened

    for (const h of [early, late]) {
      h.engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
      h.engine.processLocationUpdate(loc(0, 2000));
    }

    expect(late.current()).toEqual(early.current());
  });
});