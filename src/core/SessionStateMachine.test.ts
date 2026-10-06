import {
  evaluateTransition,
  resolveAutomaticTransition,
  SessionCommand,
} from './SessionStateMachine';
import type { SessionStatus } from '../types/session.types';

const ALL_STATES: readonly SessionStatus[] = [
  'IDLE',
  'ACTIVE',
  'PAUSED',
  'STOPPED',
  'SAVED',
  'DISCARDED',
];

const ALL_COMMANDS: readonly SessionCommand[] = [
  'StartSession',
  'PauseSession',
  'ResumeSession',
  'StopSession',
  'SaveSession',
  'DiscardSession',
];

const EXPECTED_VALID: ReadonlyArray<{
  from: SessionStatus;
  command: SessionCommand;
  to: SessionStatus;
}> = [
  { from: 'IDLE', command: 'StartSession', to: 'ACTIVE' },
  { from: 'ACTIVE', command: 'PauseSession', to: 'PAUSED' },
  { from: 'PAUSED', command: 'ResumeSession', to: 'ACTIVE' },
  { from: 'ACTIVE', command: 'StopSession', to: 'STOPPED' },
  { from: 'PAUSED', command: 'StopSession', to: 'STOPPED' },
  { from: 'STOPPED', command: 'SaveSession', to: 'SAVED' },
  { from: 'STOPPED', command: 'DiscardSession', to: 'DISCARDED' },
];

function isExpectedValid(from: SessionStatus, command: SessionCommand): boolean {
  return EXPECTED_VALID.some((entry) => entry.from === from && entry.command === command);
}

describe('SessionStateMachine', () => {
  it.each(EXPECTED_VALID)('accepts $command from $from to $to', ({ from, command, to }) => {
    const verdict = evaluateTransition(from, command);
    expect(verdict).toEqual({
      accepted: true,
      currentState: from,
      command,
      resultingState: to,
      reason: null,
    });
  });

  it('rejects every invalid command/state combination', () => {
    for (const state of ALL_STATES) {
      for (const command of ALL_COMMANDS) {
        if (isExpectedValid(state, command)) continue;
        expect(evaluateTransition(state, command).accepted).toBe(false);
      }
    }
  });

  it('resets terminal states to IDLE', () => {
    expect(resolveAutomaticTransition('SAVED')).toBe('IDLE');
    expect(resolveAutomaticTransition('DISCARDED')).toBe('IDLE');
  });

  it('has no automatic transition for non-terminal states', () => {
    for (const state of ['IDLE', 'ACTIVE', 'PAUSED', 'STOPPED'] as const) {
      expect(resolveAutomaticTransition(state)).toBeNull();
    }
  });
});