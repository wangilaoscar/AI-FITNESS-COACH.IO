// EventPublisher.ts
// Purpose: Delivers already-created domain events to subscribers.
//
// Architectural contract (Milestone 4 + Revision 1.1 — locked):
//   - A delivery mechanism only. Never decides whether an event should be
//     generated, never calculates or derives event data, never mutates
//     TrackingSession, never executes a business rule.
//   - Does not know which module (State Machine, Aggregate, Statistics
//     Calculator, GPS Health Relay) produced an event — it only ever
//     receives an already-committed DomainEvent value and delivers it.
//   - Preserves submission order: publish(E1); publish(E2) always
//     delivers E1 to every subscriber before E2 is delivered to any.
//   - Delivers synchronously — no queue, no async buffering, no
//     parallel subscriber execution.
//   - Has no session lifecycle of its own and no knowledge of
//     IDLE/ACTIVE/PAUSED/STOPPED/SAVED/DISCARDED.
//
// SUBSCRIBER-FAILURE BEHAVIOR (reported, not silently decided):
// Nothing in the locked architecture specifies what happens if a
// subscriber throws. No retry, queue, or async infrastructure is
// permitted, so the smallest deterministic choice is: publish() does not
// catch subscriber errors. Listeners are invoked in registration order in
// a plain loop; if one throws, the exception propagates synchronously out
// of publish(), and any listeners after the throwing one do NOT receive
// that event. This is a flagged design decision, not a locked one — if
// fault isolation between subscribers (one failing listener should not
// block delivery to the rest) is actually desired, that is an explicit
// architectural choice to make later, not one this step invents.
//
// PAYLOAD SHAPES (reported): SessionStarted/Paused/Resumed/Stopped all
// carry a full TrackingSession snapshot (matching exactly what
// SessionAggregate already returns from createSession/applyVerdict — no
// new shape invented). RoutePointRecorded carries a RoutePoint;
// StatisticsUpdated carries a SessionStatistics; both are existing,
// concrete domain types. GPSHealthChanged and SessionRecordProduced
// carry GPSHealth and SessionRecord respectively — neither had a concrete
// shape anywhere in the repository before this step, so both were added
// as intentionally opaque types (src/features/gps/types/gps.types.ts and
// src/types/session.types.ts), following the exact precedent already set
// for GPSConfiguration and UserPreferences (Steps 2 and 7). No business
// field was invented for either. SessionDiscarded carries no payload at
// all, matching its locked description as "confirmation only — no data."

import type { GPSHealth } from '../features/gps/types/gps.types';
import type { RoutePoint, SessionRecord, SessionStatistics, TrackingSession } from '../types/session.types';

export interface SessionStartedEvent {
  readonly type: 'SessionStarted';
  readonly session: TrackingSession;
}
export interface SessionPausedEvent {
  readonly type: 'SessionPaused';
  readonly session: TrackingSession;
}
export interface SessionResumedEvent {
  readonly type: 'SessionResumed';
  readonly session: TrackingSession;
}
export interface SessionStoppedEvent {
  readonly type: 'SessionStopped';
  readonly session: TrackingSession;
}
export interface RoutePointRecordedEvent {
  readonly type: 'RoutePointRecorded';
  readonly routePoint: RoutePoint;
}
export interface StatisticsUpdatedEvent {
  readonly type: 'StatisticsUpdated';
  readonly statistics: SessionStatistics;
}
export interface GPSHealthChangedEvent {
  readonly type: 'GPSHealthChanged';
  readonly gpsHealth: GPSHealth;
}
export interface SessionRecordProducedEvent {
  readonly type: 'SessionRecordProduced';
  readonly sessionRecord: SessionRecord;
}
export interface SessionDiscardedEvent {
  readonly type: 'SessionDiscarded';
}

/**
 * The nine locked domain events (Milestone 4 Revision 1.1 §3/§8), exactly
 * as named there — no event added, renamed, or removed.
 */
export type DomainEvent =
  | SessionStartedEvent
  | SessionPausedEvent
  | SessionResumedEvent
  | SessionStoppedEvent
  | RoutePointRecordedEvent
  | StatisticsUpdatedEvent
  | GPSHealthChangedEvent
  | SessionRecordProducedEvent
  | SessionDiscardedEvent;

export type DomainEventListener = (event: DomainEvent) => void;

export class EventPublisher {
  private listeners: DomainEventListener[] = [];

  /**
   * Register a listener. The same function reference may be subscribed
   * more than once; each call to subscribe() requires its own matching
   * call to unsubscribe() to remove that specific registration (standard
   * emitter semantics — not deduplicated).
   */
  subscribe(listener: DomainEventListener): void {
    this.listeners.push(listener);
  }

  /**
   * Remove the first matching registration of `listener`, if any. Other
   * registrations (of the same or different listeners) are unaffected.
   */
  unsubscribe(listener: DomainEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Deliver `event` to every currently-subscribed listener, synchronously,
   * in registration order. The event itself is frozen defensively before
   * delivery (consistent with the freezing convention already established
   * by SessionAggregate and RoutePointFactory) — this module never
   * constructs or alters the payload inside it.
   *
   * See the subscriber-failure note above: a throwing listener's
   * exception propagates out of this call, and any listeners registered
   * after it do not receive this event.
   */
  publish(event: DomainEvent): void {
    Object.freeze(event);
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }
}