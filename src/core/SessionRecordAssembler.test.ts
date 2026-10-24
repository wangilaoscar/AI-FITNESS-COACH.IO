// SessionRecordAssembler.test.ts
// Tests the Assembler's EXISTING public contract only (Milestone 4 + Rev 1.1):
//   - it converts a SAVED TrackingSession into an immutable SessionRecord — and ONLY a SAVED one
//     (a record is produced only after a valid Save succeeds; STOPPED is not enough);
//   - the record has exactly the four approved fields: route, statistics, lifecycle, gpsConfiguration;
//   - it is pure assembly: no calculation, no RoutePoint creation, no cloning, no mutation of the source;
//   - it produces the record in memory only: no persistence, no storage, no events.
//
// Real SAVED / STOPPED / DISCARDED snapshots come from the real SessionAggregate + State Machine.

import * as assemblerModule from './SessionRecordAssembler';
import { assembleSessionRecord } from './SessionRecordAssembler';
import { SessionAggregate } from './SessionAggregate';
import { evaluateTransition } from './SessionStateMachine';
import type { SessionCommand } from './SessionStateMachine';
import type { SessionStatus, TrackingSession } from '../types/session.types';

// ---------------------------------------------------------------------------
// Helpers — build genuine snapshots through the real lifecycle
// ---------------------------------------------------------------------------

function drive(aggregate: SessionAggregate, command: Exclude<SessionCommand, 'StartSession'>, timestamp: number) {
  return aggregate.applyVerdict(evaluateTransition(aggregate.getCurrentStatus(), command), timestamp);
}

/** A realistic session: points, a pause/resume cycle, final statistics. Returns the STOPPED snapshot and the aggregate. */
function stoppedSession() {
  const aggregate = new SessionAggregate();
  aggregate.createSession(evaluateTransition('IDLE', 'StartSession'), { opaqueField: 'opaque-value' }, 1000);
  aggregate.addRoutePoint({ latitude: 0, longitude: 0, timestamp: 2000 });
  aggregate.addRoutePoint({ latitude: 0.001, longitude: 0, timestamp: 3000 });
  drive(aggregate, 'PauseSession', 3500);
  drive(aggregate, 'ResumeSession', 4000);
  aggregate.applyStatistics({
    distanceMeters: 111.2,
    currentSpeedMetersPerSecond: 4,
    averageSpeedMetersPerSecond: 3,
    maxSpeedMetersPerSecond: 5,
    elapsedActiveMs: 2500,
  });
  const stopped = drive(aggregate, 'StopSession', 5000);
  return { aggregate, stopped };
}

function savedSession(): TrackingSession {
  const { aggregate } = stoppedSession();
  return drive(aggregate, 'SaveSession', 6000);
}

function discardedSession(): TrackingSession {
  const { aggregate } = stoppedSession();
  return drive(aggregate, 'DiscardSession', 6000);
}

/** A plain, hand-built session — proves the Assembler depends only on the TrackingSession shape, not on the Aggregate. */
function plainSession(status: SessionStatus): TrackingSession {
  return {
    status,
    gpsConfiguration: { opaqueField: 'opaque-value' },
    route: [{ latitude: 1, longitude: 2, timestamp: 3 }],
    statistics: {
      distanceMeters: 1,
      currentSpeedMetersPerSecond: 2,
      averageSpeedMetersPerSecond: 3,
      maxSpeedMetersPerSecond: 4,
      elapsedActiveMs: 5,
    },
    lifecycle: { startedAt: 1, stoppedAt: 2, pauseIntervals: [] },
  };
}

// ---------------------------------------------------------------------------
// Acceptance — SAVED only
// ---------------------------------------------------------------------------

describe('SessionRecordAssembler — accepts only SAVED snapshots', () => {
  it('assembles a record from a SAVED snapshot', () => {
    expect(() => assembleSessionRecord(savedSession())).not.toThrow();
  });

  it.each(['IDLE', 'ACTIVE', 'PAUSED', 'STOPPED', 'DISCARDED'] as const)(
    'rejects a %s session, naming the status it received',
    (status) => {
      expect(() => assembleSessionRecord(plainSession(status))).toThrow(
        new RegExp(`requires a SAVED session \\(received status: ${status}\\)`)
      );
    }
  );

  it('rejects the real STOPPED snapshot: a record is not produced before Save succeeds', () => {
    const { stopped } = stoppedSession();
    expect(stopped.status).toBe('STOPPED');
    expect(() => assembleSessionRecord(stopped)).toThrow(/requires a SAVED session/);
  });

  it('rejects the real DISCARDED snapshot: a discarded session never becomes a record', () => {
    const discarded = discardedSession();
    expect(discarded.status).toBe('DISCARDED');
    expect(() => assembleSessionRecord(discarded)).toThrow(/requires a SAVED session/);
  });
});

// ---------------------------------------------------------------------------
// Shape — exactly the four approved fields
// ---------------------------------------------------------------------------

describe('SessionRecordAssembler — exactly the four approved fields', () => {
  it('produces a record with route, statistics, lifecycle, and gpsConfiguration — and nothing else', () => {
    const record = assembleSessionRecord(savedSession());
    expect(Object.keys(record).sort()).toEqual(['gpsConfiguration', 'lifecycle', 'route', 'statistics']);
  });

  it('carries no `status` — a saved record has no ongoing status', () => {
    const record = assembleSessionRecord(savedSession());
    expect(record).not.toHaveProperty('status');
  });

  it('carries the session\'s own values, unchanged and uncalculated', () => {
    const session = savedSession();

    const record = assembleSessionRecord(session);

    expect(record.route).toEqual([
      { latitude: 0, longitude: 0, timestamp: 2000 },
      { latitude: 0.001, longitude: 0, timestamp: 3000 },
    ]);
    expect(record.statistics).toEqual({
      distanceMeters: 111.2,
      currentSpeedMetersPerSecond: 4,
      averageSpeedMetersPerSecond: 3,
      maxSpeedMetersPerSecond: 5,
      elapsedActiveMs: 2500,
    });
    expect(record.lifecycle).toEqual({
      startedAt: 1000,
      stoppedAt: 5000,
      pauseIntervals: [{ pausedAt: 3500, resumedAt: 4000 }],
    });
    expect(record.gpsConfiguration).toEqual({ opaqueField: 'opaque-value' });
  });

  it('reuses the session\'s route, statistics, lifecycle, and gpsConfiguration directly — no cloning, no recalculation', () => {
    const session = savedSession();

    const record = assembleSessionRecord(session);

    expect(record.route).toBe(session.route);
    expect(record.statistics).toBe(session.statistics);
    expect(record.lifecycle).toBe(session.lifecycle);
    expect(record.gpsConfiguration).toBe(session.gpsConfiguration);
  });

  it('uses the statistics exactly as committed, even when they are inconsistent with the route (it never recalculates)', () => {
    const session = plainSession('SAVED'); // 1 route point but distanceMeters 1, elapsed 5: arbitrary on purpose
    const record = assembleSessionRecord(session);
    expect(record.statistics).toBe(session.statistics);
  });

  it('works on a plain TrackingSession object — it depends on the session shape, not on the Aggregate', () => {
    const session = plainSession('SAVED');
    const record = assembleSessionRecord(session);
    expect(record).toEqual({
      route: session.route,
      statistics: session.statistics,
      lifecycle: session.lifecycle,
      gpsConfiguration: session.gpsConfiguration,
    });
  });
});

// ---------------------------------------------------------------------------
// Immutability and non-mutation
// ---------------------------------------------------------------------------

describe('SessionRecordAssembler — immutable record, untouched source', () => {
  it('freezes the record wrapper: field replacement and extra fields are refused', () => {
    const record = assembleSessionRecord(savedSession());
    const before = { ...record };

    expect(Object.isFrozen(record)).toBe(true);
    try {
      (record as unknown as { route: unknown }).route = [];
      (record as unknown as { extra: number }).extra = 1;
    } catch {
      /* strict mode throws on frozen objects; either way the write is refused */
    }

    expect({ ...record }).toEqual(before);
    expect(record).not.toHaveProperty('extra');
  });

  it('keeps nested values frozen when the SAVED snapshot came from the Aggregate (they were frozen there)', () => {
    const record = assembleSessionRecord(savedSession());
    expect(Object.isFrozen(record.route)).toBe(true);
    expect(Object.isFrozen(record.statistics)).toBe(true);
    expect(Object.isFrozen(record.lifecycle)).toBe(true);
    expect(Object.isFrozen(record.gpsConfiguration)).toBe(true);
  });

  it('never mutates the source session (it neither re-freezes nor alters a plain session)', () => {
    const session = plainSession('SAVED');
    const copy = JSON.parse(JSON.stringify(session));

    assembleSessionRecord(session);

    expect(session).toEqual(copy);
    expect(Object.isFrozen(session)).toBe(false);
    expect(Object.isFrozen(session.route)).toBe(false);
    expect(session.status).toBe('SAVED');
  });

  it('returns a new record object on every call — never the session itself', () => {
    const session = savedSession();

    const a = assembleSessionRecord(session);
    const b = assembleSessionRecord(session);

    expect(a).not.toBe(session as unknown);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// No persistence, no side effects
// ---------------------------------------------------------------------------

describe('SessionRecordAssembler — in-memory only: no persistence, no events', () => {
  it('returns the record synchronously (not a Promise or thenable)', () => {
    const record = assembleSessionRecord(savedSession());
    expect(record).not.toBeInstanceOf(Promise);
    expect((record as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('exports only assembleSessionRecord — no save, persist, repository, or publish API', () => {
    expect(Object.keys(assemblerModule)).toEqual(['assembleSessionRecord']);
  });

  it('takes the session as its only input: no repository, publisher, or other dependency is injectable', () => {
    expect(assembleSessionRecord.length).toBe(1);
  });
});