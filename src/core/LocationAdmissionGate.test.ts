import { LocationAdmissionGate } from './LocationAdmissionGate';
import type { SessionStatus } from '../types/session.types';
import type { LocationUpdate } from '../features/gps/types/gps.types';

function fix(overrides: Partial<LocationUpdate> = {}): LocationUpdate {
  return {
    latitude: 1,
    longitude: 1,
    altitude: null,
    accuracy: 5,
    heading: null,
    speed: 3,
    timestamp: 1000,
    ...overrides,
  };
}

describe('LocationAdmissionGate — session-context eligibility', () => {
  it('1. admits a valid LocationUpdate while the session is ACTIVE', () => {
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(result.admitted).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('2. rejects the observation while the session is PAUSED', () => {
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'PAUSED');
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('PAUSED');
  });

  it('3. rejects the observation for every non-active session status', () => {
    const gate = new LocationAdmissionGate();
    const nonActiveStatuses: SessionStatus[] = ['IDLE', 'STOPPED', 'SAVED', 'DISCARDED'];
    for (const status of nonActiveStatuses) {
      const result = gate.evaluate(fix({ timestamp: 1000 }), status);
      expect(result.admitted).toBe(false);
      expect(result.reason).toContain(status);
    }
  });
});

describe('LocationAdmissionGate — timestamp sequencing', () => {
  it('4. admits the first valid timestamp', () => {
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 5000 }), 'ACTIVE');
    expect(result.admitted).toBe(true);
  });

  it('5. admits a later timestamp following an accepted one', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    const result = gate.evaluate(fix({ timestamp: 2000 }), 'ACTIVE');
    expect(result.admitted).toBe(true);
  });

  it('6. rejects an earlier timestamp than the last accepted one', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 2000 }), 'ACTIVE');
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('does not advance');
  });

  it('7. rejects an equal timestamp deterministically (locked policy: equal counts as non-advancing)', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain('does not advance');

    // Deterministic: repeating the exact same equal-timestamp attempt
    // always produces the same rejection, never a flip to acceptance.
    const repeat = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(repeat.admitted).toBe(false);
  });

  it('8. a rejected timestamp does not corrupt or advance the Gate\'s sequencing state', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE'); // accepted, lastAccepted = 1000
    gate.evaluate(fix({ timestamp: 700 }), 'ACTIVE'); // rejected (earlier)

    // If the rejection had corrupted state to 700, this would wrongly admit.
    // If state were untouched (still 1000), 1500 must be admitted.
    const result = gate.evaluate(fix({ timestamp: 1500 }), 'ACTIVE');
    expect(result.admitted).toBe(true);

    // And a value between the rejected one and the real last-accepted one
    // must still correctly be rejected, proving 700 was never adopted:
    const stillRejected = gate.evaluate(fix({ timestamp: 900 }), 'ACTIVE');
    expect(stillRejected.admitted).toBe(false);
  });

  it('9. a valid observation is admitted correctly after a rejected observation (session-status rejection)', () => {
    const gate = new LocationAdmissionGate();
    const rejected = gate.evaluate(fix({ timestamp: 1000 }), 'PAUSED');
    expect(rejected.admitted).toBe(false);

    // The PAUSED rejection must not have touched sequencing state either —
    // 1000 must still be admissible once the session is ACTIVE.
    const admitted = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(admitted.admitted).toBe(true);
  });
});

describe('LocationAdmissionGate — GPS boundary discipline', () => {
  it('10. enforces no GPS accuracy threshold — an extremely poor accuracy value is still admitted', () => {
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 1000, accuracy: 999999 }), 'ACTIVE');
    expect(result.admitted).toBe(true);
  });

  it('11. never uses LocationUpdate.speed to determine admission', () => {
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 1000, speed: -99999 }), 'ACTIVE');
    expect(result.admitted).toBe(true);

    const gate2 = new LocationAdmissionGate();
    const result2 = gate2.evaluate(fix({ timestamp: 1000, speed: null }), 'ACTIVE');
    expect(result2.admitted).toBe(true);
  });
});

describe('LocationAdmissionGate — does not mutate TrackingSession', () => {
  it('12. the evaluate() signature accepts only a LocationUpdate and a plain SessionStatus string — there is no TrackingSession for it to mutate', () => {
    // Structural guarantee, exactly as with SessionStateMachine's purity
    // test: evaluate() never receives a TrackingSession object at all, so
    // mutating one is not something this method is even capable of.
    const gate = new LocationAdmissionGate();
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(typeof result.admitted).toBe('boolean');
  });
});

describe('LocationAdmissionGate — reset() (flagged design decision, see accompanying report)', () => {
  it('resets sequencing so a new session context is judged independently of a previous one', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 5000 }), 'ACTIVE');

    gate.reset();

    // Without reset, 1000 (earlier than 5000) would be rejected. After
    // reset, it is treated as the first observation of a new context.
    const result = gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    expect(result.admitted).toBe(true);
  });

  it('does NOT need reset() across a Pause/Resume — sequencing intentionally persists', () => {
    const gate = new LocationAdmissionGate();
    gate.evaluate(fix({ timestamp: 1000 }), 'ACTIVE');
    // Simulate a Pause/Resume cycle: no reset() call in between.
    const afterResume = gate.evaluate(fix({ timestamp: 1500 }), 'ACTIVE');
    expect(afterResume.admitted).toBe(true);

    // A timestamp from "before the pause" arriving late must still be rejected:
    const stale = gate.evaluate(fix({ timestamp: 999 }), 'ACTIVE');
    expect(stale.admitted).toBe(false);
  });
});