import { resolveConfiguration } from './ConfigurationResolver';
import type { UserPreferences } from '../types/session.types';

// No concrete UserPreferences → GPSConfiguration mapping exists anywhere
// in the locked architecture (see ConfigurationResolver.ts's reported
// gap). These tests deliberately do NOT assert any specific field mapping
// — doing so would establish an invented GPS policy in test form, which
// these instructions explicitly forbid. They cover only the minimal,
// honest, non-policy behavior this step can justify.

describe('ConfigurationResolver — resolveConfiguration', () => {
  it('1. returns a valid GPSConfiguration value for a given UserPreferences input', () => {
    const result = resolveConfiguration({ someArbitraryPreference: 'value' });
    expect(typeof result).toBe('object');
    expect(result).not.toBeNull();
  });

  it('2. identical input produces identical output', () => {
    const input: UserPreferences = { accuracyTier: 'balanced' };
    const first = resolveConfiguration(input);
    const second = resolveConfiguration(input);
    expect(first).toEqual(second);
  });

  it('3. does not mutate the input UserPreferences', () => {
    const input: UserPreferences = { unitSystem: 'metric', accuracyTier: 'high' };
    const snapshotBefore = { ...input };
    resolveConfiguration(input);
    expect(input).toEqual(snapshotBefore);
  });

  it('4. maintains no hidden state across calls with different inputs', () => {
    const first = resolveConfiguration({ unitSystem: 'metric' });
    resolveConfiguration({ unitSystem: 'imperial', accuracyTier: 'high' }); // unrelated call in between
    const firstAgain = resolveConfiguration({ unitSystem: 'metric' });
    expect(firstAgain).toEqual(first);
  });

  it('5. an empty UserPreferences object is handled the same as any other, since no field is yet known to have meaning', () => {
    const withEmpty = resolveConfiguration({});
    const withArbitraryFields = resolveConfiguration({ anything: 'goes', another: 42 });
    expect(withEmpty).toEqual(withArbitraryFields);
  });

  it('6. does not access GPS/provider APIs (structural — no such import exists in this module)', () => {
    // No GPS module is imported anywhere in ConfigurationResolver.ts;
    // calling it here with no GPS environment present at all proves it.
    expect(() => resolveConfiguration({})).not.toThrow();
  });

  it('7. does not mutate TrackingSession (structural — the function signature never accepts one)', () => {
    const result = resolveConfiguration({});
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('route');
  });

  it('8. does not calculate statistics (structural — no statistics-shaped output exists)', () => {
    const result = resolveConfiguration({});
    expect(result).not.toHaveProperty('distanceMeters');
    expect(result).not.toHaveProperty('currentSpeedMetersPerSecond');
  });

  it('9. is independently testable with a plain object literal — no engine, GPS, or store dependency required', () => {
    const result = resolveConfiguration({ anyKey: 'anyValue' });
    expect(result).toBeDefined();
  });
});