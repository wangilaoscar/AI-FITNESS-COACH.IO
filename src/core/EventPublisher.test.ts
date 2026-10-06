import { EventPublisher, DomainEvent, DomainEventListener } from './EventPublisher';
import type { TrackingSession, RoutePoint, SessionStatistics } from '../types/session.types';

const SESSION: TrackingSession = {
  status: 'ACTIVE',
  gpsConfiguration: {},
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

const ROUTE_POINT: RoutePoint = { latitude: 1, longitude: 1, timestamp: 1000 };
const STATS: SessionStatistics = {
  distanceMeters: 10,
  currentSpeedMetersPerSecond: 1,
  averageSpeedMetersPerSecond: 1,
  maxSpeedMetersPerSecond: 1,
  elapsedActiveMs: 10000,
};

function startedEvent(): DomainEvent {
  return { type: 'SessionStarted', session: SESSION };
}
function pausedEvent(): DomainEvent {
  return { type: 'SessionPaused', session: SESSION };
}
function routePointEvent(): DomainEvent {
  return { type: 'RoutePointRecorded', routePoint: ROUTE_POINT };
}
function statisticsEvent(): DomainEvent {
  return { type: 'StatisticsUpdated', statistics: STATS };
}
function discardedEvent(): DomainEvent {
  return { type: 'SessionDiscarded' };
}

describe('EventPublisher — basic delivery', () => {
  it('1. a subscriber receives a published event', () => {
    const publisher = new EventPublisher();
    const listener = jest.fn();
    publisher.subscribe(listener);

    const event = startedEvent();
    publisher.publish(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('2. multiple subscribers receive the same event', () => {
    const publisher = new EventPublisher();
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    publisher.subscribe(listenerA);
    publisher.subscribe(listenerB);

    const event = pausedEvent();
    publisher.publish(event);

    expect(listenerA).toHaveBeenCalledWith(event);
    expect(listenerB).toHaveBeenCalledWith(event);
  });
});

describe('EventPublisher — ordering', () => {
  it('3. events are delivered in submission order to a single subscriber', () => {
    const publisher = new EventPublisher();
    const received: string[] = [];
    publisher.subscribe((event) => received.push(event.type));

    publisher.publish(startedEvent());
    publisher.publish(pausedEvent());
    publisher.publish(routePointEvent());

    expect(received).toEqual(['SessionStarted', 'SessionPaused', 'RoutePointRecorded']);
  });

  it('4. multiple events are delivered in the same order to every subscriber', () => {
    const publisher = new EventPublisher();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    publisher.subscribe((event) => receivedA.push(event.type));
    publisher.subscribe((event) => receivedB.push(event.type));

    publisher.publish(startedEvent());
    publisher.publish(statisticsEvent());
    publisher.publish(discardedEvent());

    const expected = ['SessionStarted', 'StatisticsUpdated', 'SessionDiscarded'];
    expect(receivedA).toEqual(expected);
    expect(receivedB).toEqual(expected);
  });
});

describe('EventPublisher — subscription', () => {
  it('5. unsubscribed listeners stop receiving future events', () => {
    const publisher = new EventPublisher();
    const listener = jest.fn();
    publisher.subscribe(listener);
    publisher.publish(startedEvent());
    expect(listener).toHaveBeenCalledTimes(1);

    publisher.unsubscribe(listener);
    publisher.publish(pausedEvent());

    expect(listener).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('6. removing one subscriber does not remove other subscribers', () => {
    const publisher = new EventPublisher();
    const listenerA = jest.fn();
    const listenerB = jest.fn();
    publisher.subscribe(listenerA);
    publisher.subscribe(listenerB);

    publisher.unsubscribe(listenerA);
    publisher.publish(startedEvent());

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });
});

describe('EventPublisher — immutability', () => {
  it('7. the Publisher does not mutate the event', () => {
    const publisher = new EventPublisher();
    const event = startedEvent();
    const snapshot = JSON.parse(JSON.stringify(event));

    publisher.publish(event);

    expect(event).toEqual(snapshot);
  });

  it('8. the event payload/snapshot is delivered unchanged, and the event itself is frozen on delivery', () => {
    const publisher = new EventPublisher();
    let receivedEvent: DomainEvent | undefined;
    publisher.subscribe((event) => {
      receivedEvent = event;
    });

    const event = statisticsEvent();
    publisher.publish(event);

    expect(receivedEvent).toEqual(event);
    expect(Object.isFrozen(receivedEvent)).toBe(true);
  });
});

describe('EventPublisher — no engine state or business logic', () => {
  it('9. the Publisher maintains no TrackingSession state', () => {
    const publisher = new EventPublisher();
    publisher.publish(startedEvent());
    publisher.publish(discardedEvent());
    expect((publisher as unknown as { currentSession?: unknown }).currentSession).toBeUndefined();
  });

  it('10. the Publisher performs no calculations or business decisions', () => {
    const publisher = new EventPublisher();
    let received: DomainEvent | undefined;
    publisher.subscribe((event) => (received = event));

    const event = routePointEvent();
    publisher.publish(event);

    expect(received).toEqual(event);
  });

  it('11. publishing does not invoke any State Machine transition (no such dependency exists)', () => {
    const publisher = new EventPublisher();
    expect(() => publisher.publish(startedEvent())).not.toThrow();
  });

  it('12. publishing does not invoke Aggregate mutation (no such dependency exists)', () => {
    const publisher = new EventPublisher();
    expect(() => publisher.publish(pausedEvent())).not.toThrow();
  });

  it('13. the Publisher is independently testable without UI, GPS, or Storage', () => {
    const publisher = new EventPublisher();
    const listener = jest.fn();
    publisher.subscribe(listener);
    publisher.publish(statisticsEvent());
    expect(listener).toHaveBeenCalled();
  });
});

describe('EventPublisher — no duplicate delivery on register/unregister cycles', () => {
  it('14. a normal subscribe → publish → unsubscribe → subscribe → publish cycle never double-delivers', () => {
    const publisher = new EventPublisher();
    const listener = jest.fn();

    publisher.subscribe(listener);
    publisher.publish(startedEvent());
    publisher.unsubscribe(listener);

    publisher.subscribe(listener);
    publisher.publish(pausedEvent());

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenNthCalledWith(1, startedEvent());
    expect(listener).toHaveBeenNthCalledWith(2, pausedEvent());
  });
});

describe('EventPublisher — determinism', () => {
  it('15. repeated publish of the same event behaves deterministically', () => {
    const publisher = new EventPublisher();
    const received: DomainEvent[] = [];
    publisher.subscribe((event) => received.push(event));

    const event = routePointEvent();
    publisher.publish(event);
    publisher.publish(event);

    expect(received).toEqual([event, event]);
    expect(received.length).toBe(2);
  });
});

describe('EventPublisher — subscriber-failure behavior (flagged design decision)', () => {
  it('propagates a throwing listener\'s exception synchronously out of publish()', () => {
    const publisher = new EventPublisher();
    const throwingListener: DomainEventListener = () => {
      throw new Error('listener failure');
    };
    publisher.subscribe(throwingListener);

    expect(() => publisher.publish(startedEvent())).toThrow('listener failure');
  });

  it('a listener registered after a throwing listener does NOT receive that event (no fault isolation — documented, not invented silently)', () => {
    const publisher = new EventPublisher();
    const afterListener = jest.fn();
    publisher.subscribe(() => {
      throw new Error('boom');
    });
    publisher.subscribe(afterListener);

    expect(() => publisher.publish(startedEvent())).toThrow('boom');
    expect(afterListener).not.toHaveBeenCalled();
  });

  it('a listener registered before a throwing listener still received the event before the throw', () => {
    const publisher = new EventPublisher();
    const beforeListener = jest.fn();
    publisher.subscribe(beforeListener);
    publisher.subscribe(() => {
      throw new Error('boom');
    });

    expect(() => publisher.publish(startedEvent())).toThrow('boom');
    expect(beforeListener).toHaveBeenCalledTimes(1);
  });
});