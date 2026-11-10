import { describe, it, expect } from 'vitest';
import { holdSecondsFor, REVEAL_WINDOW_MS, HOLD_BASE_SECONDS, HOLD_MAX_SECONDS } from '../src/shared/hold-utils';

const now = 1_000_000_000_000;

describe('hold-to-reveal duration', () => {
  it('starts at the base hold', () => {
    expect(holdSecondsFor([], now)).toBe(HOLD_BASE_SECONDS);
  });

  it('gets longer with each recent reveal', () => {
    expect(holdSecondsFor([now - 1000], now)).toBe(4);
    expect(holdSecondsFor([now - 3000, now - 2000, now - 1000], now)).toBe(8);
  });

  it('caps at the maximum', () => {
    expect(holdSecondsFor(Array.from({ length: 20 }, (_, i) => now - i * 1000), now)).toBe(HOLD_MAX_SECONDS);
  });

  it('forgets reveals older than the window', () => {
    expect(holdSecondsFor([now - REVEAL_WINDOW_MS - 1, now - REVEAL_WINDOW_MS - 5000], now)).toBe(HOLD_BASE_SECONDS);
  });
});
