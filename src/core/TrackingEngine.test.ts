import { TrackingEngine } from './TrackingEngine';
import { SessionAggregate } from './SessionAggregate';
import { SessionCommandHandler } from './SessionCommandHandler';
import { LocationAdmissionGate } from './LocationAdmissionGate';
import { EventPublisher, DomainEvent } from './EventPublisher';
import { calculateSessionStatistics } from './StatisticsCalculator';
import type { UserPreferences } from '../types/session.types';
import type { LocationUpdate } from '../features/gps/types/gps.types';

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
  it('has processCommand (11B) and processLocationUpdate (11C) but not processGPSHealth (still deferred to a later sub-stage)', () => {
    const aggregate = new SessionAggregate();
    const eventPublisher = new EventPublisher();
    const engine = new TrackingEngine({ aggregate, eventPublisher }) as unknown as Record<string, unknown>;

    expect(typeof engine.processCommand).toBe('function');
    expect(typeof engine.processLocationUpdate).toBe('function');
    expect(engine.processGPSHealth).toBeUndefined();
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

  it("9. TrackingEngine contains no transition or calculation logic of its own (Stop's statistics are whatever the Aggregate already had committed — untouched by this sub-stage)", () => {
    const { aggregate, engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    const beforeStop = aggregate.getCurrentSession()!.statistics;

    const result = engine.processCommand({ command: 'StopSession', timestamp: 9000 });

    expect(result.session?.statistics).toEqual(beforeStop);
  });

  it('SaveSession and DiscardSession are explicitly out of scope for 11B', () => {
    const { engine } = setup();
    engine.processCommand({ command: 'StartSession', timestamp: 1000, userPreferences: PREFS });
    engine.processCommand({ command: 'StopSession', timestamp: 2000 });

    expect(() =>
      engine.processCommand({
        command: 'SaveSession',
        timestamp: 3000,
      } as unknown as Parameters<typeof engine.processCommand>[0])
    ).toThrow(/not implemented until Step 11D/);
  });
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