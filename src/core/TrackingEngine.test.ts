import { TrackingEngine } from './TrackingEngine';
import { SessionAggregate } from './SessionAggregate';
import { SessionCommandHandler } from './SessionCommandHandler';
import { LocationAdmissionGate } from './LocationAdmissionGate';
import { EventPublisher, DomainEvent } from './EventPublisher';
import { calculateSessionStatistics } from './StatisticsCalculator';
import type { UserPreferences } from '../types/session.types';
import type { GPSHealth, LocationUpdate } from '../features/gps/types/gps.types';
import * as assemblerModule from './SessionRecordAssembler';
import * as relayModule from './GPSHealthRelay';
const PREFS: UserPreferences = { accuracyTier: 'balanced' };

function locationUpdate(overrides: Partial<LocationUpdate> = {}): LocationUpdate {
  return {
    latitude: 0,
    longitude: 0,
    altitude: null,
    accuracy: 5,
    heading: null,
    speed: 3,
    timestamp: 1000,
    ...overrides,
  };
}

function setup() {
  const aggregate = new SessionAggregate();
  const eventPublisher = new EventPublisher();
  const engine = new TrackingEngine({ aggregate, eventPublisher });
  const log: DomainEvent[] = [];
  eventPublisher.subscribe((event) => log.push(event));
  return { aggregate, eventPublisher, engine, log };
}

describe('TrackingEngine (Step 11A shell) — construction', () => {
  it('can be constructed with only its required dependencies (aggregate, eventPublisher)', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();

    expect(() => new TrackingEngine({ aggregate, eventPublisher })).not.toThrow();
  });

  it('can be constructed with all dependencies explicitly supplied', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const admissionGate = new LocationAdmissionGate();
    const commandHandler = new SessionCommandHandler(aggregate);

    expect(() => new TrackingEngine({ aggregate, eventPublisher, admissionGate, commandHandler })).not.toThrow();
  });
});

describe('TrackingEngine (Step 11A shell) — dependencies are wired, not substituted', () => {
  it('wires the exact aggregate instance passed in', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher });

    expect(engine.getWiredDependencies().aggregate).toBe(aggregate);
  });

  it('wires the exact eventPublisher instance passed in', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher });

    expect(engine.getWiredDependencies().eventPublisher).toBe(eventPublisher);
  });

  it('wires the exact admissionGate instance passed in, when supplied', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const admissionGate = new LocationAdmissionGate();
    const engine = new TrackingEngine({ aggregate, eventPublisher, admissionGate });

    expect(engine.getWiredDependencies().admissionGate).toBe(admissionGate);
  });

  it('wires the exact commandHandler instance passed in, when supplied', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const commandHandler = new SessionCommandHandler(aggregate);
    const engine = new TrackingEngine({ aggregate, eventPublisher, commandHandler });

    expect(engine.getWiredDependencies().commandHandler).toBe(commandHandler);
  });

  it('constructs sensible defaults for admissionGate/commandHandler when not supplied, rather than leaving them unset', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher });

    const wired = engine.getWiredDependencies();
    expect(wired.admissionGate).toBeInstanceOf(LocationAdmissionGate);
    expect(wired.commandHandler).toBeInstanceOf(SessionCommandHandler);
  });
});

describe('TrackingEngine (Step 11A shell) — no module is bypassed', () => {
  it('the default commandHandler wraps the SAME aggregate instance the engine was given, not a separate one', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher });

    const { commandHandler } = engine.getWiredDependencies();
    commandHandler.handle({ command: 'StartSession', timestamp: 1000, gpsConfiguration: {} });

    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });

  it('constructing the engine performs no command processing, no transitions, and no session creation on its own', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    new TrackingEngine({ aggregate, eventPublisher });

    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('constructing the engine publishes no event', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const received: unknown[] = [];
    eventPublisher.subscribe((event) => received.push(event));

    new TrackingEngine({ aggregate, eventPublisher });

    expect(received).toEqual([]);
  });
});

describe('TrackingEngine (Step 11A shell) — no duplicated business logic', () => {
  it('exposes command, location, and GPS health processing entry points', () => {
    const { engine } = setup();

    expect(typeof engine.processCommand).toBe('function');
    expect(typeof engine.processLocationUpdate).toBe('function');
    expect(typeof engine.processGPSHealth).toBe('function');
  });

  it('this module contains no transition-table, calculation, or admission logic of its own (structural — proven by delegating entirely to real module instances with no override)', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher });

    expect(engine.getWiredDependencies().commandHandler).toBeInstanceOf(SessionCommandHandler);
    expect(engine.getWiredDependencies().admissionGate).toBeInstanceOf(LocationAdmissionGate);
  });
});

describe('TrackingEngine (Step 11B) — command flow', () => {
  it('1. StartSession succeeds and publishes SessionStarted after state mutation', () => {
    const { aggregate, engine, log } = setup();
    const result = engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });

    expect(result.accepted).toBe(true);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
    expect(log).toEqual([{ type: 'SessionStarted', session: result.session }]);
  });

  it('2. PauseSession succeeds and publishes SessionPaused after mutation', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    log.length = 0;

    const result = engine.processCommand({ command: 'PauseSession', timestamp: 2000 });

    expect(aggregate.getCurrentStatus()).toBe('PAUSED');
    expect(log).toEqual([{ type: 'SessionPaused', session: result.session }]);
  });

  it('3. ResumeSession succeeds and publishes SessionResumed after mutation', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processCommand({ command: 'PauseSession', timestamp: 2000 });
    log.length = 0;

    const result = engine.processCommand({ command: 'ResumeSession', timestamp: 3000 });

    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
    expect(log).toEqual([{ type: 'SessionResumed', session: result.session }]);
  });

  it('4. StopSession succeeds and publishes SessionStopped after mutation', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    log.length = 0;

    const result = engine.processCommand({ command: 'StopSession', timestamp: 5000 });

    expect(aggregate.getCurrentStatus()).toBe('STOPPED');
    expect(result.session?.lifecycle.stoppedAt).toBe(5000);
    expect(log).toEqual([{ type: 'SessionStopped', session: result.session }]);
  });

  it('5. an invalid command produces no event and does not mutate the session', () => {
    const { aggregate, engine, log } = setup();
    const result = engine.processCommand({ command: 'PauseSession', timestamp: 1000 });

    expect(result.accepted).toBe(false);
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
    expect(log).toEqual([]);
  });

  it('6. event order follows command processing order', () => {
    const { engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processCommand({ command: 'PauseSession', timestamp: 2000 });
    engine.processCommand({ command: 'ResumeSession', timestamp: 3000 });
    engine.processCommand({ command: 'StopSession', timestamp: 4000 });

    expect(log.map((e) => e.type)).toEqual([
      'SessionStarted',
      'SessionPaused',
      'SessionResumed',
      'SessionStopped',
    ]);
  });

  it('7. the engine uses its already-wired CommandHandler, Aggregate, and EventPublisher instances (no new ones constructed internally per call)', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const commandHandler = new SessionCommandHandler(aggregate);
    const engine = new TrackingEngine({ aggregate, eventPublisher, commandHandler });

    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });

    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
    expect(engine.getWiredDependencies().commandHandler).toBe(commandHandler);
    expect(engine.getWiredDependencies().aggregate).toBe(aggregate);
    expect(engine.getWiredDependencies().eventPublisher).toBe(eventPublisher);
  });

  it('8. command processing never bypasses the Handler (an illegal transition is still cleanly rejected, proving the Handler/State Machine were actually consulted)', () => {
    const { engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    const result = engine.processCommand({ command: 'StartSession', timestamp: 1500, userPreferences: PREFS });

    expect(result.accepted).toBe(false);
    expect(result.verdict.reason).not.toBeNull();
  });

    it("9. TrackingEngine contains no calculation logic of its own (superseded in 11D: Stop's statistics are finalized by StatisticsCalculator — they equal an independent Calculator call on the committed data)", () => {
    const { engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });

    const result = engine.processCommand({ command: 'StopSession', timestamp: 9000 });

    expect(result.session?.statistics).toEqual(
      calculateSessionStatistics({ routePoints: result.session!.route, lifecycle: result.session!.lifecycle })
    );
  });
  // ...existing code...
    it("9. TrackingEngine contains no calculation logic of its own (superseded in 11D: Stop's statistics are finalized by StatisticsCalculator — they equal an independent Calculator call on the committed data)", () => {
    const { engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });

    const result = engine.processCommand({ command: 'StopSession', timestamp: 9000 });

    expect(result.session?.statistics).toEqual(
      calculateSessionStatistics({ routePoints: result.session!.route, lifecycle: result.session!.lifecycle })
    );
  });
});

describe('TrackingEngine (Step 11C) — location flow', () => {
  // ...existing code...
});
describe('TrackingEngine (Step 11C) — location flow', () => {
  it('an admitted LocationUpdate follows the full pipeline: Gate → Factory → Aggregate → Calculator → Aggregate → Publisher', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    log.length = 0;

    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000 }));
    engine.processLocationUpdate(locationUpdate({ latitude: 0.001, longitude: 0, timestamp: 2000 }));

    expect(aggregate.getCurrentSession()?.route.length).toBe(2);
    expect(log.map((e) => e.type)).toEqual([
      'RoutePointRecorded',
      'StatisticsUpdated',
      'RoutePointRecorded',
      'StatisticsUpdated',
    ]);
  });

  it('a rejected LocationUpdate produces no mutation and no event', () => {
    const { aggregate, engine, log } = setup();
    engine.processLocationUpdate(locationUpdate());

    expect(aggregate.getCurrentSession()).toBeNull();
    expect(log).toEqual([]);
  });

  it('RoutePointRecorded always precedes StatisticsUpdated', () => {
    const { engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    log.length = 0;
    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000 }));

    expect(log[0].type).toBe('RoutePointRecorded');
    expect(log[1].type).toBe('StatisticsUpdated');
  });

  it('statistics reflect the newly committed RoutePoint (matches an independent StatisticsCalculator call on the same committed data)', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000 }));
    engine.processLocationUpdate(locationUpdate({ latitude: 0.001, longitude: 0, timestamp: 2000 }));

    const session = aggregate.getCurrentSession()!;
    const independentlyComputed = calculateSessionStatistics({
      routePoints: session.route,
      lifecycle: session.lifecycle,
    });
    const publishedStats = log.filter((e) => e.type === 'StatisticsUpdated').pop();
    expect(publishedStats).toEqual({ type: 'StatisticsUpdated', statistics: independentlyComputed });
    expect(session.statistics).toEqual(independentlyComputed);
  });

  it('LocationUpdate.speed is not used — varying it changes nothing', () => {
    const runA = setup();
    runA.engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    runA.engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000, speed: 1 }));
    runA.engine.processLocationUpdate(locationUpdate({ latitude: 0.001, longitude: 0, timestamp: 2000, speed: 1 }));

    const runB = setup();
    runB.engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    runB.engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000, speed: 999 }));
    runB.engine.processLocationUpdate(locationUpdate({ latitude: 0.001, longitude: 0, timestamp: 2000, speed: -50 }));

    expect(runA.aggregate.getCurrentSession()?.statistics).toEqual(runB.aggregate.getCurrentSession()?.statistics);
  });

  it('a LocationUpdate while PAUSED is rejected', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processCommand({ command: 'PauseSession', timestamp: 2000 });
    log.length = 0;

    engine.processLocationUpdate(locationUpdate({ latitude: 9, longitude: 9, timestamp: 2500 }));

    expect(aggregate.getCurrentSession()?.route.length).toBe(0);
    expect(log).toEqual([]);
  });

  it('a LocationUpdate before Start is rejected', () => {
    const { aggregate, engine, log } = setup();
    engine.processLocationUpdate(locationUpdate({ timestamp: 500 }));

    expect(aggregate.getCurrentSession()).toBeNull();
    expect(log).toEqual([]);
  });

  it('a LocationUpdate after Stop is rejected', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 1000 }));
    engine.processCommand({ command: 'StopSession', timestamp: 2000 });
    log.length = 0;

    engine.processLocationUpdate(locationUpdate({ latitude: 1, longitude: 1, timestamp: 2500 }));

    expect(aggregate.getCurrentSession()?.route.length).toBe(1);
    expect(log).toEqual([]);
  });
});
// ---------------------------------------------------------------------------
// Step 11D — terminal flows (Stop finalization, Save, Discard) + GPS health
// ---------------------------------------------------------------------------

function eventOf<T extends DomainEvent['type']>(log: DomainEvent[], type: T): Extract<DomainEvent, { type: T }> {
  const found = log.find((event) => event.type === type);
  if (found === undefined) throw new Error(`No ${type} event was published.`);
  return found as Extract<DomainEvent, { type: T }>;
}

/** Start at t=1000, record two admitted points (t=2000, t=3000). */
function startAndMove(engine: TrackingEngine): void {
  engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
  engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 2000 }));
  engine.processLocationUpdate(locationUpdate({ latitude: 0.001, longitude: 0, timestamp: 3000 }));
}

describe('TrackingEngine (Step 11D) — A) stop finalization', () => {
  it('recomputes final statistics from the committed STOPPED session before SessionStopped is published', () => {
    const { aggregate, eventPublisher, engine, log } = setup();
    startAndMove(engine);
    const liveStatistics = aggregate.getCurrentSession()!.statistics;
    log.length = 0;

    let committedAtPublish: ReturnType<SessionAggregate['getCurrentSession']> = null;
    eventPublisher.subscribe((event) => {
      if (event.type === 'SessionStopped') committedAtPublish = aggregate.getCurrentSession();
    });

    const result = engine.processCommand({ command: 'StopSession', timestamp: 10000 });
    const stopped = eventOf(log, 'SessionStopped');

    const expected = calculateSessionStatistics({
      routePoints: stopped.session.route,
      lifecycle: stopped.session.lifecycle,
    });
    expect(stopped.session.status).toBe('STOPPED');
    expect(stopped.session.statistics).toEqual(expected);
    // Live statistics ended at the last point (t=3000); final ones run to stoppedAt (t=10000).
    expect(liveStatistics.elapsedActiveMs).toBe(2000);
    expect(stopped.session.statistics.elapsedActiveMs).toBe(9000);
    // Committed to the Aggregate BEFORE the event was delivered, and the event carries that exact snapshot.
    expect(committedAtPublish).toBe(stopped.session);
    expect(aggregate.getCurrentSession()).toBe(stopped.session);
    expect(result.session).toBe(stopped.session);
  });

  it('publishes SessionStopped only — no extra StatisticsUpdated or RoutePointRecorded', () => {
    const { engine, log } = setup();
    startAndMove(engine);
    log.length = 0;

    engine.processCommand({ command: 'StopSession', timestamp: 10000 });

    expect(log.map((event) => event.type)).toEqual(['SessionStopped']);
  });

  it('a Stop with no RoutePoints is still finalized through the Calculator (elapsed runs to stoppedAt)', () => {
    const { engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    log.length = 0;

    engine.processCommand({ command: 'StopSession', timestamp: 9000 });
    const stopped = eventOf(log, 'SessionStopped');

    expect(stopped.session.statistics.elapsedActiveMs).toBe(8000);
    expect(stopped.session.statistics.distanceMeters).toBe(0);
  });

  it('a rejected StopSession publishes nothing and leaves the Aggregate untouched', () => {
    const { aggregate, engine, log } = setup();

    const result = engine.processCommand({ command: 'StopSession', timestamp: 5000 });

    expect(result.accepted).toBe(false);
    expect(result.session).toBeNull();
    expect(log).toEqual([]);
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });
});

describe('TrackingEngine (Step 11D) — B) save', () => {
  afterEach(() => jest.restoreAllMocks());

  function stopped() {
    const ctx = setup();
    startAndMove(ctx.engine);
    ctx.engine.processCommand({ command: 'StopSession', timestamp: 10000 });
    ctx.log.length = 0;
    return ctx;
  }

  it('assembles the SessionRecord from the SAVED snapshot (never STOPPED) and publishes SessionRecordProduced', () => {
    const { engine, log } = stopped();
    const spy = jest.spyOn(assemblerModule, 'assembleSessionRecord');

    const result = engine.processCommand({ command: 'SaveSession', timestamp: 11000 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].status).toBe('SAVED');
    expect(spy.mock.calls[0][0]).toBe(result.session);
    expect(log.map((event) => event.type)).toEqual(['SessionRecordProduced']);

    const record = eventOf(log, 'SessionRecordProduced').sessionRecord;
    expect(record.route).toBe(result.session!.route);
    expect(record.statistics).toBe(result.session!.statistics);
    expect(record.lifecycle).toBe(result.session!.lifecycle);
    expect(record.gpsConfiguration).toBe(result.session!.gpsConfiguration);
    expect(record.statistics.elapsedActiveMs).toBe(9000); // the final statistics committed at Stop
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('leaves the engine and Aggregate in IDLE (the Aggregate\'s existing atomic reset)', () => {
    const { aggregate, engine, log } = stopped();

    const result = engine.processCommand({ command: 'SaveSession', timestamp: 11000 });

    expect(result.accepted).toBe(true);
    expect(result.session?.status).toBe('SAVED');
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();

    log.length = 0;
    engine.processLocationUpdate(locationUpdate({ timestamp: 20000 }));
    expect(log).toEqual([]); // no live session to record into

    const restart = engine.processCommand({ command: 'StartSession', timestamp: 30000, userPreferences: PREFS });
    expect(restart.accepted).toBe(true);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });

  it('a SaveSession that is not legal (session still ACTIVE) assembles nothing and publishes nothing', () => {
    const { aggregate, engine, log } = setup();
    startAndMove(engine);
    log.length = 0;
    const spy = jest.spyOn(assemblerModule, 'assembleSessionRecord');

    const result = engine.processCommand({ command: 'SaveSession', timestamp: 4000 });

    expect(result.accepted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });
});

describe('TrackingEngine (Step 11D) — C) discard', () => {
  afterEach(() => jest.restoreAllMocks());

  function stopped() {
    const ctx = setup();
    startAndMove(ctx.engine);
    ctx.engine.processCommand({ command: 'StopSession', timestamp: 10000 });
    ctx.log.length = 0;
    return ctx;
  }

  it('publishes SessionDiscarded (confirmation only) and assembles no SessionRecord', () => {
    const { engine, log } = stopped();
    const spy = jest.spyOn(assemblerModule, 'assembleSessionRecord');

    engine.processCommand({ command: 'DiscardSession', timestamp: 11000 });

    expect(log).toEqual([{ type: 'SessionDiscarded' }]);
    expect(log.some((event) => event.type === 'SessionRecordProduced')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns the DISCARDED snapshot and leaves the engine/Aggregate in IDLE (existing atomic reset)', () => {
    const { aggregate, engine } = stopped();

    const result = engine.processCommand({ command: 'DiscardSession', timestamp: 11000 });

    expect(result.accepted).toBe(true);
    expect(result.session?.status).toBe('DISCARDED');
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('a DiscardSession that is not legal (session still ACTIVE) publishes nothing', () => {
    const { aggregate, engine, log } = setup();
    startAndMove(engine);
    log.length = 0;

    const result = engine.processCommand({ command: 'DiscardSession', timestamp: 4000 });

    expect(result.accepted).toBe(false);
    expect(log).toEqual([]);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });
});

describe('TrackingEngine (Step 11D) — D) GPS health', () => {
  afterEach(() => jest.restoreAllMocks());

  // Deliberately meaningless fields: GPSHealth is opaque, and these tests must not invent a shape for it.
  const health: GPSHealth = Object.freeze({ opaqueField: 'opaque-value', nested: Object.freeze({ n: 1 }) });

  it('passes GPSHealth through GPSHealthRelay unchanged and publishes GPSHealthChanged', () => {
    const { engine, log } = setup();
    const spy = jest.spyOn(relayModule, 'relayGPSHealth');

    engine.processGPSHealth(health);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(health);
    expect(log).toHaveLength(1);
    expect(eventOf(log, 'GPSHealthChanged').gpsHealth).toBe(health); // same reference — not copied or altered
  });

  it('never reads or mutates the TrackingSession', () => {
    const { aggregate, engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    const before = aggregate.getCurrentSession();

    engine.processGPSHealth(health);

    expect(aggregate.getCurrentSession()).toBe(before);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });

  it('adds no interpretation: not gated by session status and not de-duplicated', () => {
    const { aggregate, engine, log } = setup();

    engine.processGPSHealth(health);
    engine.processGPSHealth(health);

    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(log.map((event) => event.type)).toEqual(['GPSHealthChanged', 'GPSHealthChanged']);
    expect(eventOf(log, 'GPSHealthChanged').gpsHealth).toBe(health);
  });
});
describe('TrackingEngine (Step 11D) — admission gate reset at StartSession (regression)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a new session whose timestamps are EARLIER than the previous session\'s last accepted timestamp is still admitted', () => {
    const { aggregate, engine, log } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 50000 }));
    engine.processCommand({ command: 'StopSession', timestamp: 60000 });
    engine.processCommand({ command: 'DiscardSession', timestamp: 61000 });
    expect(aggregate.getCurrentStatus()).toBe('IDLE');

    engine.processCommand({ command: 'StartSession', timestamp: 100, userPreferences: PREFS });
    log.length = 0;
    engine.processLocationUpdate(locationUpdate({ latitude: 0, longitude: 0, timestamp: 200 })); // 200 < 50000

    expect(aggregate.getCurrentSession()?.route.length).toBe(1);
    expect(log.map((event) => event.type)).toEqual(['RoutePointRecorded', 'StatisticsUpdated']);
  });

  it('also holds after Save (not just Discard)', () => {
    const { aggregate, engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ timestamp: 50000 }));
    engine.processCommand({ command: 'StopSession', timestamp: 60000 });
    engine.processCommand({ command: 'SaveSession', timestamp: 61000 });

    engine.processCommand({ command: 'StartSession', timestamp: 100, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ timestamp: 200 }));

    expect(aggregate.getCurrentSession()?.route.length).toBe(1);
  });

  it('resets the Gate BEFORE SessionStarted is published', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const admissionGate = new LocationAdmissionGate();
    const resetSpy = jest.spyOn(admissionGate, 'reset');
    const engine = new TrackingEngine({ aggregate, eventPublisher, admissionGate });
    const listener = jest.fn();
    eventPublisher.subscribe(listener);

    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'SessionStarted' }));
    expect(resetSpy.mock.invocationCallOrder[0]).toBeLessThan(listener.mock.invocationCallOrder[0]);
  });

  it('a REJECTED StartSession does not reset the Gate (a live session\'s sequencing is preserved)', () => {
    const { aggregate, engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ timestamp: 5000 }));

    const second = engine.processCommand({ command: 'StartSession', timestamp: 6000, userPreferences: PREFS });
    expect(second.accepted).toBe(false); // already ACTIVE

    engine.processLocationUpdate(locationUpdate({ latitude: 0.001, timestamp: 4000 })); // not later than 5000
    expect(aggregate.getCurrentSession()?.route.length).toBe(1);
  });

  it('Pause → Resume within one session does NOT reset sequencing (only a new session does)', () => {
    const { aggregate, engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processLocationUpdate(locationUpdate({ timestamp: 5000 }));
    engine.processCommand({ command: 'PauseSession', timestamp: 6000 });
    engine.processCommand({ command: 'ResumeSession', timestamp: 7000 });

    engine.processLocationUpdate(locationUpdate({ latitude: 0.001, timestamp: 4000 })); // earlier than 5000

    expect(aggregate.getCurrentSession()?.route.length).toBe(1);
  });
});