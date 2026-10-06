// SessionStateMachine.ts
// Purpose: Guards valid session status transitions.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Reads the current session status only.
//   - Evaluates command legality against the locked transition table.
//   - Returns a transition verdict — it never applies one.
//   - Never mutates or holds TrackingSession data (the Session Aggregate does).
//   - Never calculates statistics, processes GPS, creates a RoutePoint or a
//     SessionRecord, persists anything, or publishes a domain event.
//   - Has no knowledge of UI, Navigation, Zustand, React, Expo, or Storage.
//
// This module is pure and deterministic: same inputs always produce the same
// verdict, with no side effects.

/**
 * The six statuses a TrackingSession can be in, per the locked Session State
 * Machine (Milestone 4 §5 / Revision 1.1).
 */
import type { SessionStatus } from '../types/session.types';

/**
 * The six commands the Tracking Engine accepts, per the locked command
 * vocabulary (Milestone 4 Revision 1.1 §2).
 */
export type SessionCommand =
  | 'StartSession'
  | 'PauseSession'
  | 'ResumeSession'
  | 'StopSession'
  | 'SaveSession'
  | 'DiscardSession';

/**
 * The result of evaluating one command against the current status.
 *
 * `resultingState` and `reason` are mutually exclusive: an accepted verdict
 * always has a `resultingState` and a null `reason`; a rejected verdict
 * always has a null `resultingState` and a `reason`.
 */
export interface TransitionVerdict {
  readonly accepted: boolean;
  readonly currentState: SessionStatus;
  readonly command: SessionCommand;
  readonly resultingState: SessionStatus | null;
  readonly reason: string | null;
}

/**
 * The locked transition table: for each command, which source state(s) it
 * is legal from, and what state it produces.
 *
 * This table is the single source of truth for legality — nothing else in
 * this module (or anywhere else) should encode transition rules.
 */
const COMMAND_RULES: Record<
  SessionCommand,
  { readonly validFrom: readonly SessionStatus[]; readonly to: SessionStatus }
> = {
  StartSession: { validFrom: ['IDLE'], to: 'ACTIVE' },
  PauseSession: { validFrom: ['ACTIVE'], to: 'PAUSED' },
  ResumeSession: { validFrom: ['PAUSED'], to: 'ACTIVE' },
  StopSession: { validFrom: ['ACTIVE', 'PAUSED'], to: 'STOPPED' },
  SaveSession: { validFrom: ['STOPPED'], to: 'SAVED' },
  DiscardSession: { validFrom: ['STOPPED'], to: 'DISCARDED' },
};

/**
 * The locked automatic-reset table: SAVED and DISCARDED are terminal for a
 * given TrackingSession instance, but the engine as a whole automatically
 * becomes ready for a new session afterward (Milestone 4 §5 / Revision 1.1
 * §5, atomicity invariant). This is not a user command — it is a rule the
 * state machine still owns, since it is still a statement of which
 * transitions are legal, just not command-triggered.
 */
const AUTOMATIC_RESET: Partial<Record<SessionStatus, SessionStatus>> = {
  SAVED: 'IDLE',
  DISCARDED: 'IDLE',
};

/**
 * Evaluate whether `command` is legal from `currentState`.
 *
 * Returns a verdict only — this function has no side effects and does not
 * touch any TrackingSession. Applying an accepted verdict is exclusively
 * the Session Aggregate's responsibility (a later implementation step).
 */
export function evaluateTransition(
  currentState: SessionStatus,
  command: SessionCommand
): TransitionVerdict {
  const rule = COMMAND_RULES[command];

  if (rule.validFrom.includes(currentState)) {
    return {
      accepted: true,
      currentState,
      command,
      resultingState: rule.to,
      reason: null,
    };
  }

  return {
    accepted: false,
    currentState,
    command,
    resultingState: null,
    reason: `${command} is not valid from ${currentState}`,
  };
}

/**
 * Resolve the automatic follow-on transition for a terminal state, if any.
 *
 * Returns the state the engine should reset to (currently always `IDLE`,
 * for `SAVED` and `DISCARDED`), or `null` if `currentState` has no automatic
 * transition. Like `evaluateTransition`, this only reports what the next
 * state would be — it does not apply it.
 */
export function resolveAutomaticTransition(
  currentState: SessionStatus
): SessionStatus | null {
  return AUTOMATIC_RESET[currentState] ?? null;
}