// SessionAggregate.test.ts
// Tests the Aggregate's EXISTING public contract only (Milestone 4 + Rev 1.1):
//   - it is the sole mutable holder of the live TrackingSession;
//   - it applies verdicts the State Machine already approved — it never decides legality;
//   - every mutation is a functional replacement; every snapshot it hands out is deeply frozen;
//   - Save/Discard perform the terminal transition AND the reset to "no live session" atomically;
//   - it does not calculate statistics, create RoutePoints, validate sequencing, publish, or persist.
//
// Verdicts come from the real evaluateTransition. Hand-built verdicts appear ONLY where a
// defensive guard cannot be reached through the real State Machine.

import { SessionAggregate } from './SessionAggregate';
import { evaluateTransition } from './SessionStateMachine';
import type { SessionCommand, TransitionVerdict } from './SessionStateMachine';
import type {
  GPSConfiguration,
  RoutePoint,
  SessionStatistics,
  SessionStatus,
  TrackingSession,
} from '../types/session.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// GPSConfiguration is opaque in the locked domain model; these fields are deliberately meaningless.
// The Aggregate freezes whatever object it is given, so every call gets a fresh one.
const makeConfig = (): GPSConfiguration => ({ opaqueField: 'opaque-value' });

const point = (timestamp: number, latitude = 0, longitude = 0): RoutePoint => ({
  latitude,
  longitude,
  timestamp,
});

const makeStats = (overrides: Partial<SessionStatistics> = {}): SessionStatistics => ({
  distanceMeters: 0,
  currentSpeedMetersPerSecond: 0,
  averageSpeedMetersPerSecond: 0,
  maxSpeedMetersPerSecond: 0,
  elapsedActiveMs: 0,
  ...overrides,
});

const verdictFor = (from: SessionStatus, command: SessionCommand): TransitionVerdict =>
  evaluateTransition(from, command);

/** A hand-built verdict, used only to reach defensive guards the real State Machine can't produce. */
const craftedVerdict = (
  command: SessionCommand,
  currentState: SessionStatus,
  accepted: boolean,
  resultingState: SessionStatus | null
): TransitionVerdict => ({
  accepted,
  currentState,
  command,
  resultingState,
  reason: accepted ? null : 'crafted rejection',
});

function started(startedAt = 1000) {
  const aggregate = new SessionAggregate();
  const session = aggregate.createSession(verdictFor('IDLE', 'StartSession'), makeConfig(), startedAt);
  return { aggregate, session };
}

/** Apply a command through the real State Machine verdict for the Aggregate's current status. */
function apply(aggregate: SessionAggregate, command: Exclude<SessionCommand, 'StartSession'>, timestamp: number) {
  return aggregate.applyVerdict(verdictFor(aggregate.getCurrentStatus(), command), timestamp);
}

/** Frozen objects throw in strict mode and silently ignore writes in sloppy mode; both are "refused". */
function tryMutate(fn: () => void): void {
  try {
    fn();
  } catch {
    /* refused */
  }
}

function expectDeeplyFrozen(session: TrackingSession): void {
  expect(Object.isFrozen(session)).toBe(true);
  expect(Object.isFrozen(session.route)).toBe(true);
  for (const p of session.route) expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(session.lifecycle)).toBe(true);
  expect(Object.isFrozen(session.lifecycle.pauseIntervals)).toBe(true);
  for (const i of session.lifecycle.pauseIntervals) expect(Object.isFrozen(i)).toBe(true);
  expect(Object.isFrozen(session.statistics)).toBe(true);
  expect(Object.isFrozen(session.gpsConfiguration)).toBe(true);
}

// ---------------------------------------------------------------------------
// Initial state and public surface
// ---------------------------------------------------------------------------

describe('SessionAggregate — initial state and public surface', () => {
  it('starts with no live session: status IDLE, session null', () => {
    const aggregate = new SessionAggregate();
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('exposes exactly the documented operations — no event, persistence, calculation, or validation API', () => {
    expect(Object.getOwnPropertyNames(SessionAggregate.prototype).sort()).toEqual([
      'addRoutePoint',
      'applyStatistics',
      'applyVerdict',
      'constructor',
      'createSession',
      'getCurrentSession',
      'getCurrentStatus',
    ]);
  });
});

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('SessionAggregate — createSession', () => {
  it('creates an ACTIVE session with an empty route, zeroed statistics, and the given startedAt', () => {
    const config = makeConfig();
    const aggregate = new SessionAggregate();

    const session = aggregate.createSession(verdictFor('IDLE', 'StartSession'), config, 1234);

    expect(session.status).toBe('ACTIVE');
    expect(session.route).toEqual([]);
    expect(session.statistics).toEqual(makeStats());
    expect(session.lifecycle).toEqual({ startedAt: 1234, stoppedAt: null, pauseIntervals: [] });
    expect(session.gpsConfiguration).toEqual({ opaqueField: 'opaque-value' });
  });

  it('makes the new session the live one: getCurrentSession returns that exact snapshot and status is ACTIVE', () => {
    const { aggregate, session } = started();
    expect(aggregate.getCurrentSession()).toBe(session);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });

  it('returns a deeply frozen snapshot', () => {
    const { session } = started();
    expectDeeplyFrozen(session);
  });

  it.each([
    ['a verdict for a different command', verdictFor('ACTIVE', 'PauseSession')],
    ['a REJECTED StartSession verdict', verdictFor('ACTIVE', 'StartSession')],
    ['a rejected verdict for another command', verdictFor('IDLE', 'PauseSession')],
    [
      'an accepted StartSession verdict whose resulting state is not ACTIVE',
      craftedVerdict('StartSession', 'IDLE', true, 'PAUSED'),
    ],
  ])('refuses %s and leaves the Aggregate with no live session', (_label, verdict) => {
    const aggregate = new SessionAggregate();

    expect(() => aggregate.createSession(verdict, makeConfig(), 1000)).toThrow(
      /requires an accepted StartSession verdict/
    );
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('enforces at most one live session: a second createSession throws and the first is untouched', () => {
    const { aggregate, session } = started();

    expect(() =>
      aggregate.createSession(verdictFor('IDLE', 'StartSession'), makeConfig(), 9999)
    ).toThrow(/already holds a live TrackingSession/);

    expect(aggregate.getCurrentSession()).toBe(session);
    expect(aggregate.getCurrentSession()!.lifecycle.startedAt).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// applyVerdict — guards
// ---------------------------------------------------------------------------

describe('SessionAggregate — applyVerdict guards (the Aggregate applies verdicts; it does not decide)', () => {
  it('refuses a StartSession verdict (createSession is the only way to start)', () => {
    const { aggregate, session } = started();
    expect(() => aggregate.applyVerdict(verdictFor('IDLE', 'StartSession'), 2000)).toThrow(/Use createSession/);
    expect(aggregate.getCurrentSession()).toBe(session);
  });

  it('refuses a rejected verdict', () => {
    const { aggregate, session } = started();
    const rejected = verdictFor('ACTIVE', 'ResumeSession'); // Resume is not valid from ACTIVE
    expect(rejected.accepted).toBe(false);

    expect(() => aggregate.applyVerdict(rejected, 2000)).toThrow(/requires an accepted verdict/);
    expect(aggregate.getCurrentSession()).toBe(session);
  });

  it('refuses any verdict when there is no live session', () => {
    const aggregate = new SessionAggregate();
    expect(() => aggregate.applyVerdict(verdictFor('ACTIVE', 'PauseSession'), 2000)).toThrow(
      /no live TrackingSession/
    );
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
  });

  it("refuses a verdict whose currentState does not match the live session's status", () => {
    const { aggregate, session } = started(); // live status: ACTIVE
    const staleVerdict = verdictFor('PAUSED', 'ResumeSession'); // accepted, but computed from PAUSED

    expect(staleVerdict.accepted).toBe(true);
    expect(() => aggregate.applyVerdict(staleVerdict, 2000)).toThrow(/does not match the live session's status/);
    expect(aggregate.getCurrentSession()).toBe(session);
  });

  it('refuses to resume when there is no open pause interval, leaving the session untouched', () => {
    const { aggregate, session } = started();
    // Unreachable through the real State Machine (Resume is only valid from PAUSED); crafted to hit the structural guard.
    const bogus = craftedVerdict('ResumeSession', 'ACTIVE', true, 'ACTIVE');

    expect(() => aggregate.applyVerdict(bogus, 2000)).toThrow(/no open pause interval/);
    expect(aggregate.getCurrentSession()).toBe(session);
  });
});

// ---------------------------------------------------------------------------
// applyVerdict — non-terminal transitions
// ---------------------------------------------------------------------------

describe('SessionAggregate — Pause / Resume / Stop', () => {
  it('PauseSession: status PAUSED and a new OPEN pause interval at the given timestamp; nothing else changes', () => {
    const { aggregate, session: before } = started();

    const paused = apply(aggregate, 'PauseSession', 2000);

    expect(paused.status).toBe('PAUSED');
    expect(paused.lifecycle.pauseIntervals).toEqual([{ pausedAt: 2000, resumedAt: null }]);
    expect(paused.lifecycle.startedAt).toBe(before.lifecycle.startedAt);
    expect(paused.lifecycle.stoppedAt).toBeNull();
    expect(paused.route).toEqual(before.route);
    expect(paused.statistics).toEqual(before.statistics);
    expect(paused.gpsConfiguration).toBe(before.gpsConfiguration);
    expect(aggregate.getCurrentStatus()).toBe('PAUSED');
    expect(aggregate.getCurrentSession()).toBe(paused);
  });

  it('ResumeSession: status ACTIVE and the OPEN interval is closed with the given timestamp', () => {
    const { aggregate } = started();
    apply(aggregate, 'PauseSession', 2000);

    const resumed = apply(aggregate, 'ResumeSession', 3500);

    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.lifecycle.pauseIntervals).toEqual([{ pausedAt: 2000, resumedAt: 3500 }]);
    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
  });

  it('supports repeated pause/resume cycles: only the latest open interval is closed; earlier ones are preserved in order', () => {
    const { aggregate } = started();
    apply(aggregate, 'PauseSession', 2000);
    apply(aggregate, 'ResumeSession', 3000);
    apply(aggregate, 'PauseSession', 4000);
    const midCycle = aggregate.getCurrentSession()!;
    expect(midCycle.lifecycle.pauseIntervals).toEqual([
      { pausedAt: 2000, resumedAt: 3000 },
      { pausedAt: 4000, resumedAt: null },
    ]);

    const resumed = apply(aggregate, 'ResumeSession', 5000);

    expect(resumed.lifecycle.pauseIntervals).toEqual([
      { pausedAt: 2000, resumedAt: 3000 },
      { pausedAt: 4000, resumedAt: 5000 },
    ]);
  });

  it('StopSession from ACTIVE: status STOPPED and stoppedAt set; the live session is retained', () => {
    const { aggregate } = started();

    const stopped = apply(aggregate, 'StopSession', 9000);

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.lifecycle.stoppedAt).toBe(9000);
    expect(stopped.lifecycle.startedAt).toBe(1000);
    expect(aggregate.getCurrentStatus()).toBe('STOPPED');
    expect(aggregate.getCurrentSession()).toBe(stopped);
  });

  it('StopSession from PAUSED is applied as approved: STOPPED with stoppedAt, and the pause intervals are left exactly as they were', () => {
    const { aggregate } = started();
    const paused = apply(aggregate, 'PauseSession', 2000);

    const stopped = apply(aggregate, 'StopSession', 9000);

    expect(stopped.status).toBe('STOPPED');
    expect(stopped.lifecycle.stoppedAt).toBe(9000);
    // The Aggregate applies only what the verdict says; it does not invent closing the open interval.
    expect(stopped.lifecycle.pauseIntervals).toEqual(paused.lifecycle.pauseIntervals);
  });

  it('does not touch route, statistics, or configuration when applying a verdict', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(1500, 1, 1));
    const stats = makeStats({ distanceMeters: 42 });
    aggregate.applyStatistics(stats);
    const before = aggregate.getCurrentSession()!;

    apply(aggregate, 'PauseSession', 2000);
    apply(aggregate, 'ResumeSession', 3000);
    const after = apply(aggregate, 'StopSession', 4000);

    expect(after.route).toEqual(before.route);
    expect(after.statistics).toEqual(stats);
    expect(after.gpsConfiguration).toBe(before.gpsConfiguration);
  });

  it('takes the resulting status from the approved verdict, not from its own logic', () => {
    const { aggregate } = started();
    const paused = aggregate.applyVerdict(verdictFor('ACTIVE', 'PauseSession'), 2000);
    expect(paused.status).toBe(verdictFor('ACTIVE', 'PauseSession').resultingState);
  });
});

// ---------------------------------------------------------------------------
// applyVerdict — terminal transitions (atomic reset)
// ---------------------------------------------------------------------------

describe('SessionAggregate — Save / Discard (terminal transition + automatic reset, atomic)', () => {
  function stoppedAggregate() {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(2000, 0, 0));
    aggregate.addRoutePoint(point(3000, 0.001, 0));
    aggregate.applyStatistics(makeStats({ distanceMeters: 111, elapsedActiveMs: 2000 }));
    const stopped = apply(aggregate, 'StopSession', 4000);
    return { aggregate, stopped };
  }

  it('SaveSession: returns a SAVED snapshot carrying the session data, and the Aggregate is already reset to IDLE', () => {
    const { aggregate, stopped } = stoppedAggregate();

    const saved = apply(aggregate, 'SaveSession', 5000);

    expect(saved.status).toBe('SAVED');
    expect(saved.route).toEqual(stopped.route);
    expect(saved.statistics).toEqual(stopped.statistics);
    expect(saved.lifecycle).toEqual(stopped.lifecycle);
    expect(saved.gpsConfiguration).toBe(stopped.gpsConfiguration);
    // Reset happened within the same call — nothing can observe the Aggregate in between.
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('DiscardSession: returns a DISCARDED snapshot, and the Aggregate is already reset to IDLE', () => {
    const { aggregate, stopped } = stoppedAggregate();

    const discarded = apply(aggregate, 'DiscardSession', 5000);

    expect(discarded.status).toBe('DISCARDED');
    expect(discarded.route).toEqual(stopped.route);
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
    expect(aggregate.getCurrentSession()).toBeNull();
  });

  it('the terminal snapshots are deeply frozen', () => {
    const a = stoppedAggregate();
    expectDeeplyFrozen(apply(a.aggregate, 'SaveSession', 5000));
    const b = stoppedAggregate();
    expectDeeplyFrozen(apply(b.aggregate, 'DiscardSession', 5000));
  });

  it('after a terminal reset, a new session can be created with nothing carried over', () => {
    const { aggregate } = stoppedAggregate();
    const saved = apply(aggregate, 'SaveSession', 5000);

    const next = aggregate.createSession(verdictFor('IDLE', 'StartSession'), makeConfig(), 7000);

    expect(next.status).toBe('ACTIVE');
    expect(next.route).toEqual([]);
    expect(next.statistics).toEqual(makeStats());
    expect(next.lifecycle).toEqual({ startedAt: 7000, stoppedAt: null, pauseIntervals: [] });
    expect(saved.route).toHaveLength(2); // the saved snapshot is unaffected by the new session
  });

  it('after a terminal reset there is no live session to apply a verdict or add a point to', () => {
    const { aggregate } = stoppedAggregate();
    apply(aggregate, 'DiscardSession', 5000);

    expect(() => aggregate.applyVerdict(verdictFor('ACTIVE', 'PauseSession'), 6000)).toThrow(/no live TrackingSession/);
    expect(() => aggregate.addRoutePoint(point(6000))).toThrow(/no live TrackingSession/);
    expect(() => aggregate.applyStatistics(makeStats())).toThrow(/no live TrackingSession/);
  });
});

// ---------------------------------------------------------------------------
// Snapshot / immutability rules
// ---------------------------------------------------------------------------

describe('SessionAggregate — snapshots are immutable and mutations are functional replacements', () => {
  it('a previously returned snapshot is never changed by later mutations', () => {
    const { aggregate, session: s1 } = started();
    const s2 = apply(aggregate, 'PauseSession', 2000);
    const s3 = apply(aggregate, 'ResumeSession', 3000);

    expect(s1.status).toBe('ACTIVE');
    expect(s1.lifecycle.pauseIntervals).toHaveLength(0);
    expect(s2.status).toBe('PAUSED');
    expect(s2.lifecycle.pauseIntervals).toEqual([{ pausedAt: 2000, resumedAt: null }]);
    expect(s3.status).toBe('ACTIVE');
    expect(new Set([s1, s2, s3]).size).toBe(3); // each mutation produced a new object
  });

  it('a caller cannot corrupt live state by writing through a returned snapshot', () => {
    const { aggregate, session } = started();
    const live = aggregate.getCurrentSession()!;

    tryMutate(() => {
      (session as unknown as { status: string }).status = 'STOPPED';
    });
    tryMutate(() => {
      (live.route as unknown as RoutePoint[]).push(point(1));
    });
    tryMutate(() => {
      (live.lifecycle as unknown as { startedAt: number }).startedAt = -1;
    });
    tryMutate(() => {
      (live.statistics as unknown as { distanceMeters: number }).distanceMeters = 999;
    });

    expect(aggregate.getCurrentStatus()).toBe('ACTIVE');
    expect(aggregate.getCurrentSession()!.route).toHaveLength(0);
    expect(aggregate.getCurrentSession()!.lifecycle.startedAt).toBe(1000);
    expect(aggregate.getCurrentSession()!.statistics.distanceMeters).toBe(0);
  });

  it('every mutation method returns a deeply frozen snapshot', () => {
    const { aggregate } = started();
    expectDeeplyFrozen(aggregate.addRoutePoint(point(2000)));
    expectDeeplyFrozen(aggregate.applyStatistics(makeStats({ distanceMeters: 5 })));
    expectDeeplyFrozen(apply(aggregate, 'PauseSession', 3000));
    expectDeeplyFrozen(apply(aggregate, 'ResumeSession', 4000));
    expectDeeplyFrozen(apply(aggregate, 'StopSession', 5000));
  });
});

// ---------------------------------------------------------------------------
// addRoutePoint
// ---------------------------------------------------------------------------

describe('SessionAggregate — addRoutePoint', () => {
  it('appends the point to the route and returns the new live snapshot', () => {
    const { aggregate, session: before } = started();

    const after = aggregate.addRoutePoint(point(2000, 1, 2));

    expect(after.route).toEqual([point(2000, 1, 2)]);
    expect(aggregate.getCurrentSession()).toBe(after);
    expect(before.route).toHaveLength(0); // the earlier snapshot is unchanged
  });

  it('preserves insertion order', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(2000, 1, 1));
    aggregate.addRoutePoint(point(3000, 2, 2));
    aggregate.addRoutePoint(point(4000, 3, 3));

    expect(aggregate.getCurrentSession()!.route.map((p) => p.timestamp)).toEqual([2000, 3000, 4000]);
  });

  it('stores a frozen COPY: the caller\'s point is neither stored by reference nor frozen', () => {
    const { aggregate } = started();
    const mine = point(2000, 1, 2);

    const stored = aggregate.addRoutePoint(mine).route[0];

    expect(stored).toEqual(mine);
    expect(stored).not.toBe(mine);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(mine)).toBe(false);
  });

  it('changes nothing but the route (no statistics calculation, status, lifecycle, or configuration change)', () => {
    const { aggregate, session: before } = started();

    const after = aggregate.addRoutePoint(point(2000, 5, 5));

    expect(after.status).toBe(before.status);
    expect(after.statistics).toEqual(before.statistics); // still zeros — the Aggregate calculates nothing
    expect(after.lifecycle).toEqual(before.lifecycle);
    expect(after.gpsConfiguration).toBe(before.gpsConfiguration);
  });

  it.each([
    ['PAUSED', (a: SessionAggregate) => apply(a, 'PauseSession', 2000)],
    ['STOPPED', (a: SessionAggregate) => apply(a, 'StopSession', 2000)],
  ])('refuses a point while the session is %s, leaving the session untouched', (status, drive) => {
    const { aggregate } = started();
    drive(aggregate);
    const before = aggregate.getCurrentSession();

    expect(() => aggregate.addRoutePoint(point(3000))).toThrow(
      new RegExp(`cannot add a RoutePoint while the session is ${status}`)
    );
    expect(aggregate.getCurrentSession()).toBe(before);
  });

  it('refuses a point when there is no live session', () => {
    const aggregate = new SessionAggregate();
    expect(() => aggregate.addRoutePoint(point(1000))).toThrow(/no live TrackingSession/);
  });

  it('refuses an EXACT duplicate appended consecutively, leaving the route unchanged', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(2000, 1, 2));
    const before = aggregate.getCurrentSession();

    expect(() => aggregate.addRoutePoint(point(2000, 1, 2))).toThrow(/exact duplicate RoutePoint/);
    expect(aggregate.getCurrentSession()).toBe(before);
    expect(aggregate.getCurrentSession()!.route).toHaveLength(1);
  });

  it('refuses ONLY exact consecutive duplicates: same place at a new time, same time at a new place, and a non-consecutive repeat are all accepted', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(2000, 1, 2)); // A
    aggregate.addRoutePoint(point(3000, 1, 2)); // same coordinates, different timestamp
    aggregate.addRoutePoint(point(3000, 9, 9)); // same timestamp, different coordinates
    aggregate.addRoutePoint(point(2000, 1, 2)); // repeat of A, but not consecutive with it

    expect(aggregate.getCurrentSession()!.route).toHaveLength(4);
  });

  it('does not re-validate sequencing or plausibility (that is the Gate\'s job): an out-of-order timestamp is stored as given', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(5000, 1, 1));

    aggregate.addRoutePoint(point(100, 2, 2));

    expect(aggregate.getCurrentSession()!.route.map((p) => p.timestamp)).toEqual([5000, 100]);
  });
});

// ---------------------------------------------------------------------------
// applyStatistics
// ---------------------------------------------------------------------------

describe('SessionAggregate — applyStatistics', () => {
  it('stores the supplied statistics as given — no calculation happens in the Aggregate', () => {
    const { aggregate } = started();
    const supplied = makeStats({
      distanceMeters: 123.4,
      currentSpeedMetersPerSecond: 5,
      averageSpeedMetersPerSecond: 4,
      maxSpeedMetersPerSecond: 9,
      elapsedActiveMs: 77,
    });

    const updated = aggregate.applyStatistics(supplied);

    // An empty route with non-zero distance is accepted verbatim: nothing is derived or reconciled.
    expect(updated.statistics).toEqual({
      distanceMeters: 123.4,
      currentSpeedMetersPerSecond: 5,
      averageSpeedMetersPerSecond: 4,
      maxSpeedMetersPerSecond: 9,
      elapsedActiveMs: 77,
    });
    expect(updated.route).toHaveLength(0);
    expect(aggregate.getCurrentSession()).toBe(updated);
  });

  it('replaces only statistics: status, route, lifecycle, and configuration are unchanged', () => {
    const { aggregate } = started();
    aggregate.addRoutePoint(point(2000, 1, 1));
    const before = aggregate.getCurrentSession()!;

    const after = aggregate.applyStatistics(makeStats({ distanceMeters: 10 }));

    expect(after.status).toBe(before.status);
    expect(after.route).toEqual(before.route);
    expect(after.lifecycle).toEqual(before.lifecycle);
    expect(after.gpsConfiguration).toBe(before.gpsConfiguration);
    expect(before.statistics.distanceMeters).toBe(0); // earlier snapshot untouched
  });

  it.each([
    ['ACTIVE', (_a: SessionAggregate) => undefined],
    ['PAUSED', (a: SessionAggregate) => apply(a, 'PauseSession', 2000)],
    ['STOPPED', (a: SessionAggregate) => apply(a, 'StopSession', 2000)],
  ])('is accepted while the session is %s (it keeps the status and applies the statistics)', (status, drive) => {
    const { aggregate } = started();
    drive(aggregate);

    const updated = aggregate.applyStatistics(makeStats({ elapsedActiveMs: 555 }));

    expect(updated.status).toBe(status);
    expect(updated.statistics.elapsedActiveMs).toBe(555);
  });

  it('refuses when there is no live session', () => {
    const aggregate = new SessionAggregate();
    expect(() => aggregate.applyStatistics(makeStats())).toThrow(/no live TrackingSession/);
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle with the real State Machine
// ---------------------------------------------------------------------------

describe('SessionAggregate — documented lifecycle end to end', () => {
  it('IDLE → ACTIVE → PAUSED → ACTIVE → STOPPED → SAVED → IDLE', () => {
    const aggregate = new SessionAggregate();
    const seen: SessionStatus[] = [aggregate.getCurrentStatus()];

    aggregate.createSession(verdictFor('IDLE', 'StartSession'), makeConfig(), 1000);
    seen.push(aggregate.getCurrentStatus());
    apply(aggregate, 'PauseSession', 2000);
    seen.push(aggregate.getCurrentStatus());
    apply(aggregate, 'ResumeSession', 3000);
    seen.push(aggregate.getCurrentStatus());
    apply(aggregate, 'StopSession', 4000);
    seen.push(aggregate.getCurrentStatus());
    const saved = apply(aggregate, 'SaveSession', 5000);
    seen.push(aggregate.getCurrentStatus());

    expect(seen).toEqual(['IDLE', 'ACTIVE', 'PAUSED', 'ACTIVE', 'STOPPED', 'IDLE']);
    expect(saved.status).toBe('SAVED');
    expect(saved.lifecycle).toEqual({
      startedAt: 1000,
      stoppedAt: 4000,
      pauseIntervals: [{ pausedAt: 2000, resumedAt: 3000 }],
    });
  });

  it('IDLE → ACTIVE → STOPPED → DISCARDED → IDLE', () => {
    const { aggregate } = started();
    apply(aggregate, 'StopSession', 2000);

    const discarded = apply(aggregate, 'DiscardSession', 3000);

    expect(discarded.status).toBe('DISCARDED');
    expect(aggregate.getCurrentStatus()).toBe('IDLE');
  });
});