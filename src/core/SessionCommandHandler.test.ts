import { SessionCommandHandler, SessionAggregatePort, SessionStateMachinePort } from './SessionCommandHandler';
import type { TransitionVerdict, SessionCommand } from './SessionStateMachine';
import type { GPSConfiguration, SessionStatus, TrackingSession } from '../types/session.types';

const CONFIG: GPSConfiguration = { accuracyTier: 'balanced' };

const FAKE_SESSION: TrackingSession = {
  status: 'ACTIVE',
  gpsConfiguration: CONFIG,
  route: [],
  statistics: {
    distanceMeters: 0,
    currentSpeedMetersPerSecond: 0,
    averageSpeedMetersPerSecond: 0,
    maxSpeedMetersPerSecond: 0,
    elapsedActiveMs: 0,
  },
  lifecycle: { startedAt: 1000, stoppedAt: null, pauseIntervals: [] },
};

function acceptedVerdict(
  currentState: SessionStatus,
  command: SessionCommand,
  resultingState: SessionStatus
): TransitionVerdict {
  return { accepted: true, currentState, command, resultingState, reason: null };
}

function rejectedVerdict(currentState: SessionStatus, command: SessionCommand): TransitionVerdict {
  return {
    accepted: false,
    currentState,
    command,
    resultingState: null,
    reason: `${command} is not valid from ${currentState}`,
  };
}

/**
 * A shared call-order tracker used by tests 8 and 9 to prove the Handler
 * consults the State Machine before the Aggregate, and processes commands
 * in the order `handle` is invoked.
 */
function buildTrackedMocks(currentStatus: SessionStatus, verdictFor: (state: SessionStatus, command: SessionCommand) => TransitionVerdict) {
  const callOrder: string[] = [];

  const stateMachine: SessionStateMachinePort = {
    evaluateTransition: jest.fn((state: SessionStatus, command: SessionCommand) => {
      callOrder.push(`stateMachine:${command}`);
      return verdictFor(state, command);
    }),
  };

  const aggregate: SessionAggregatePort = {
    getCurrentStatus: jest.fn(() => currentStatus),
    createSession: jest.fn((verdict: TransitionVerdict) => {
      callOrder.push(`aggregate.createSession:${verdict.command}`);
      return FAKE_SESSION;
    }),
    applyVerdict: jest.fn((verdict: TransitionVerdict) => {
      callOrder.push(`aggregate.applyVerdict:${verdict.command}`);
      return FAKE_SESSION;
    }),
  };

  return { stateMachine, aggregate, callOrder };
}

describe('SessionCommandHandler — per-command delegation', () => {
  it('1. StartSession delegates to the State Machine and to Aggregate.createSession', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('IDLE', 'StartSession', 'ACTIVE')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'IDLE'),
      createSession: jest.fn(() => FAKE_SESSION),
      applyVerdict: jest.fn(),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'StartSession', timestamp: 1000, gpsConfiguration: CONFIG });

    expect(stateMachine.evaluateTransition).toHaveBeenCalledWith('IDLE', 'StartSession');
    expect(aggregate.createSession).toHaveBeenCalledWith(
      acceptedVerdict('IDLE', 'StartSession', 'ACTIVE'),
      CONFIG,
      1000
    );
    expect(aggregate.applyVerdict).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
    expect(result.session).toBe(FAKE_SESSION);
  });

  it('2. PauseSession delegates to the State Machine and to Aggregate.applyVerdict', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('ACTIVE', 'PauseSession', 'PAUSED')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'ACTIVE'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(() => FAKE_SESSION),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'PauseSession', timestamp: 2000 });

    expect(stateMachine.evaluateTransition).toHaveBeenCalledWith('ACTIVE', 'PauseSession');
    expect(aggregate.applyVerdict).toHaveBeenCalledWith(
      acceptedVerdict('ACTIVE', 'PauseSession', 'PAUSED'),
      2000
    );
    expect(aggregate.createSession).not.toHaveBeenCalled();
    expect(result.accepted).toBe(true);
  });

  it('3. ResumeSession delegates to the State Machine and to Aggregate.applyVerdict', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('PAUSED', 'ResumeSession', 'ACTIVE')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'PAUSED'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(() => FAKE_SESSION),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    handler.handle({ command: 'ResumeSession', timestamp: 2500 });

    expect(stateMachine.evaluateTransition).toHaveBeenCalledWith('PAUSED', 'ResumeSession');
    expect(aggregate.applyVerdict).toHaveBeenCalledWith(
      acceptedVerdict('PAUSED', 'ResumeSession', 'ACTIVE'),
      2500
    );
  });

  it('4. StopSession delegates to the State Machine and to Aggregate.applyVerdict', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('ACTIVE', 'StopSession', 'STOPPED')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'ACTIVE'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(() => FAKE_SESSION),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    handler.handle({ command: 'StopSession', timestamp: 9000 });

    expect(aggregate.applyVerdict).toHaveBeenCalledWith(
      acceptedVerdict('ACTIVE', 'StopSession', 'STOPPED'),
      9000
    );
  });

  it('5. SaveSession delegates to the State Machine and to Aggregate.applyVerdict (no terminal logic duplicated in the Handler)', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('STOPPED', 'SaveSession', 'SAVED')),
    };
    const finalSession: TrackingSession = { ...FAKE_SESSION, status: 'SAVED' };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'STOPPED'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(() => finalSession),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'SaveSession', timestamp: 9500 });

    expect(aggregate.applyVerdict).toHaveBeenCalledWith(
      acceptedVerdict('STOPPED', 'SaveSession', 'SAVED'),
      9500
    );
    expect(result.session).toBe(finalSession);
    expect(result.session?.status).toBe('SAVED');
  });

  it('6. DiscardSession delegates to the State Machine and to Aggregate.applyVerdict (no terminal logic duplicated in the Handler)', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => acceptedVerdict('STOPPED', 'DiscardSession', 'DISCARDED')),
    };
    const finalSession: TrackingSession = { ...FAKE_SESSION, status: 'DISCARDED' };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'STOPPED'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(() => finalSession),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'DiscardSession', timestamp: 9500 });

    expect(aggregate.applyVerdict).toHaveBeenCalledWith(
      acceptedVerdict('STOPPED', 'DiscardSession', 'DISCARDED'),
      9500
    );
    expect(result.session).toBe(finalSession);
    expect(result.session?.status).toBe('DISCARDED');
  });
});

describe('SessionCommandHandler — rejection handling', () => {
  it('7. a rejected transition does NOT call Aggregate mutation', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => rejectedVerdict('IDLE', 'PauseSession')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'IDLE'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'PauseSession', timestamp: 1000 });

    expect(aggregate.createSession).not.toHaveBeenCalled();
    expect(aggregate.applyVerdict).not.toHaveBeenCalled();
    expect(result.accepted).toBe(false);
    expect(result.session).toBeNull();
    expect(result.verdict.reason).not.toBeNull();
  });

  it('rejects a StartSession attempt without touching Aggregate.createSession', () => {
    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: jest.fn(() => rejectedVerdict('ACTIVE', 'StartSession')),
    };
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'ACTIVE'),
      createSession: jest.fn(),
      applyVerdict: jest.fn(),
    };
    const handler = new SessionCommandHandler(aggregate, stateMachine);

    const result = handler.handle({ command: 'StartSession', timestamp: 1000, gpsConfiguration: CONFIG });

    expect(aggregate.createSession).not.toHaveBeenCalled();
    expect(result.accepted).toBe(false);
    expect(result.session).toBeNull();
  });
});

describe('SessionCommandHandler — does not bypass the State Machine', () => {
  it('8. always consults the State Machine before ever calling the Aggregate, for every command type', () => {
    const commands: Array<{ status: SessionStatus; command: SessionCommand }> = [
      { status: 'IDLE', command: 'StartSession' },
      { status: 'ACTIVE', command: 'PauseSession' },
      { status: 'PAUSED', command: 'ResumeSession' },
      { status: 'ACTIVE', command: 'StopSession' },
      { status: 'STOPPED', command: 'SaveSession' },
      { status: 'STOPPED', command: 'DiscardSession' },
    ];

    for (const { status, command } of commands) {
      const resultingState: SessionStatus =
        command === 'StartSession'
          ? 'ACTIVE'
          : command === 'PauseSession'
          ? 'PAUSED'
          : command === 'ResumeSession'
          ? 'ACTIVE'
          : command === 'StopSession'
          ? 'STOPPED'
          : command === 'SaveSession'
          ? 'SAVED'
          : 'DISCARDED';

      const { stateMachine, aggregate, callOrder } = buildTrackedMocks(status, () =>
        acceptedVerdict(status, command, resultingState)
      );
      const handler = new SessionCommandHandler(aggregate, stateMachine);

      if (command === 'StartSession') {
        handler.handle({ command, timestamp: 1, gpsConfiguration: CONFIG });
      } else {
        handler.handle({ command, timestamp: 1 });
      }

      expect(stateMachine.evaluateTransition).toHaveBeenCalledTimes(1);
      // The State Machine must be consulted BEFORE any Aggregate mutation call:
      const stateMachineIndex = callOrder.findIndex((c) => c.startsWith('stateMachine:'));
      const aggregateIndex = callOrder.findIndex((c) => c.startsWith('aggregate.'));
      expect(stateMachineIndex).toBe(0);
      expect(aggregateIndex).toBe(1);
    }
  });
});

describe('SessionCommandHandler — arrival order', () => {
  it('9. processes commands in the exact order handle() is invoked', () => {
    // A minimal in-memory fake that mirrors real Aggregate/StateMachine
    // behavior just enough to prove sequencing, without re-testing their
    // own business rules.
    let status: SessionStatus = 'IDLE';
    const invocationLog: string[] = [];

    const stateMachine: SessionStateMachinePort = {
      evaluateTransition: (currentState, command) => {
        invocationLog.push(`evaluate:${command}`);
        const map: Record<SessionCommand, SessionStatus> = {
          StartSession: 'ACTIVE',
          PauseSession: 'PAUSED',
          ResumeSession: 'ACTIVE',
          StopSession: 'STOPPED',
          SaveSession: 'SAVED',
          DiscardSession: 'DISCARDED',
        };
        return acceptedVerdict(currentState, command, map[command]);
      },
    };

    const aggregate: SessionAggregatePort = {
      getCurrentStatus: () => status,
      createSession: (verdict) => {
        invocationLog.push(`create:${verdict.command}`);
        status = verdict.resultingState as SessionStatus;
        return { ...FAKE_SESSION, status };
      },
      applyVerdict: (verdict) => {
        invocationLog.push(`apply:${verdict.command}`);
        status = verdict.resultingState as SessionStatus;
        return { ...FAKE_SESSION, status };
      },
    };

    const handler = new SessionCommandHandler(aggregate, stateMachine);

    handler.handle({ command: 'StartSession', timestamp: 1, gpsConfiguration: CONFIG });
    handler.handle({ command: 'PauseSession', timestamp: 2 });
    handler.handle({ command: 'ResumeSession', timestamp: 3 });
    handler.handle({ command: 'StopSession', timestamp: 4 });
    handler.handle({ command: 'SaveSession', timestamp: 5 });

    expect(invocationLog).toEqual([
      'evaluate:StartSession',
      'create:StartSession',
      'evaluate:PauseSession',
      'apply:PauseSession',
      'evaluate:ResumeSession',
      'apply:ResumeSession',
      'evaluate:StopSession',
      'apply:StopSession',
      'evaluate:SaveSession',
      'apply:SaveSession',
    ]);
  });

  it('uses the real evaluateTransition by default when no state machine is injected', () => {
    const aggregate: SessionAggregatePort = {
      getCurrentStatus: jest.fn(() => 'IDLE'),
      createSession: jest.fn(() => FAKE_SESSION),
      applyVerdict: jest.fn(),
    };
    const handler = new SessionCommandHandler(aggregate); // no stateMachine argument

    const result = handler.handle({ command: 'StartSession', timestamp: 1, gpsConfiguration: CONFIG });

    expect(result.accepted).toBe(true);
    expect(aggregate.createSession).toHaveBeenCalled();
  });
});