// SessionCommandHandler.ts
// Purpose: The sole external entry point for session commands.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - Accepts the six canonical commands.
//   - Delegates the transition decision to the Session State Machine.
//   - Delegates the actual mutation to the Session Aggregate.
//   - Contains no transition rules of its own.
//   - Never mutates TrackingSession directly.
//   - Never calculates statistics, performs GPS logic, persists a
//     SessionRecord, renders UI, or publishes an event independently of
//     the committed engine result.
//   - Preserves serialized command arrival order.
//
// The State Machine decides. The Session Aggregate applies. The Handler
// only routes between the two — it holds no business logic itself.
//
// Dependencies are injected via narrow "port" interfaces (the minimum
// surface this Handler actually calls), not the concrete classes/functions
// imported directly. This is what lets a test substitute a mock State
// Machine or a mock Aggregate to isolate the Handler's own routing logic
// from theirs, without a service locator — the real implementations are
// simply the default constructor arguments, fully visible at the call site.

import { evaluateTransition } from './SessionStateMachine';
import type { SessionCommand, TransitionVerdict } from './SessionStateMachine';
import type { GPSConfiguration, SessionStatus, TrackingSession } from '../types/session.types';

/**
 * The one State Machine capability the Handler actually uses. Kept
 * intentionally narrower than the full SessionStateMachine module — the
 * Handler has no use for `resolveAutomaticTransition`, since the automatic
 * SAVED/DISCARDED → IDLE reset is already handled entirely inside
 * SessionAggregate.applyVerdict (Step 2); duplicating awareness of it here
 * would be a speculative, unused abstraction.
 */
export interface SessionStateMachinePort {
  evaluateTransition(currentState: SessionStatus, command: SessionCommand): TransitionVerdict;
}

/**
 * The three Aggregate capabilities the Handler actually uses. The real
 * `SessionAggregate` class already satisfies this shape structurally — no
 * change to SessionAggregate.ts was needed or made.
 */
export interface SessionAggregatePort {
  getCurrentStatus(): SessionStatus;
  createSession(
    verdict: TransitionVerdict,
    gpsConfiguration: GPSConfiguration,
    startedAt: number
  ): TrackingSession;
  applyVerdict(verdict: TransitionVerdict, timestamp: number): TrackingSession;
}

/**
 * The input to one command. `StartSession` alone requires a
 * `GPSConfiguration` — the Handler does not resolve one itself (that is a
 * future Configuration Resolver's job); it only forwards an already-resolved
 * value supplied by the caller. TypeScript enforces this shape: the
 * `gpsConfiguration` field cannot be provided for, or omitted from, the
 * wrong command variant.
 */
export type SessionCommandInput =
  | { readonly command: 'StartSession'; readonly timestamp: number; readonly gpsConfiguration: GPSConfiguration }
  | { readonly command: 'PauseSession'; readonly timestamp: number }
  | { readonly command: 'ResumeSession'; readonly timestamp: number }
  | { readonly command: 'StopSession'; readonly timestamp: number }
  | { readonly command: 'SaveSession'; readonly timestamp: number }
  | { readonly command: 'DiscardSession'; readonly timestamp: number };

/**
 * The outcome of handling one command. `session` is null exactly when the
 * command was rejected — no Aggregate call was made and nothing changed.
 * When accepted, `session` is whatever the Aggregate returned: for
 * SaveSession/DiscardSession this is the final SAVED/DISCARDED snapshot
 * (the Aggregate has already reset its own internal state to "no live
 * session" by the time this value is returned — see SessionAggregate §6).
 */
export interface SessionCommandResult {
  readonly accepted: boolean;
  readonly command: SessionCommand;
  readonly verdict: TransitionVerdict;
  readonly session: TrackingSession | null;
}

const defaultStateMachine: SessionStateMachinePort = { evaluateTransition };

export class SessionCommandHandler {
  constructor(
    private readonly aggregate: SessionAggregatePort,
    private readonly stateMachine: SessionStateMachinePort = defaultStateMachine
  ) {}

  /**
   * Handle one command to completion before returning. Calling this
   * method synchronously, once per incoming command, in the order commands
   * arrive, is what preserves arrival order — no queue or async mechanism
   * is introduced, since none is required: JS's run-to-completion semantics
   * for synchronous code already guarantee one call finishes before the
   * next begins.
   */
  handle(input: SessionCommandInput): SessionCommandResult {
    const currentState = this.aggregate.getCurrentStatus();
    const verdict = this.stateMachine.evaluateTransition(currentState, input.command);

    if (!verdict.accepted) {
      return { accepted: false, command: input.command, verdict, session: null };
    }

    const session: TrackingSession =
      input.command === 'StartSession'
        ? this.aggregate.createSession(verdict, input.gpsConfiguration, input.timestamp)
        : this.aggregate.applyVerdict(verdict, input.timestamp);

    return { accepted: true, command: input.command, verdict, session };
  }
}