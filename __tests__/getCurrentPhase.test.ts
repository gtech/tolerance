import { describe, it, expect } from 'vitest';
import { getCurrentPhase } from '../src/background/storage';

const defaults = { normal: 15, reduced: 45, windDown: 75 };

describe('getCurrentPhase', () => {
  it('returns "normal" at 0 minutes', () => {
    expect(getCurrentPhase(0, defaults)).toBe('normal');
  });

  it('returns "normal" at 14.9 minutes', () => {
    expect(getCurrentPhase(14.9, defaults)).toBe('normal');
  });

  it('returns "reduced" at exactly 15 minutes', () => {
    expect(getCurrentPhase(15, defaults)).toBe('reduced');
  });

  it('returns "reduced" at 44.9 minutes', () => {
    expect(getCurrentPhase(44.9, defaults)).toBe('reduced');
  });

  it('returns "wind-down" at exactly 45 minutes', () => {
    expect(getCurrentPhase(45, defaults)).toBe('wind-down');
  });

  it('returns "wind-down" at 74.9 minutes', () => {
    expect(getCurrentPhase(74.9, defaults)).toBe('wind-down');
  });

  it('returns "minimal" at exactly 75 minutes', () => {
    expect(getCurrentPhase(75, defaults)).toBe('minimal');
  });

  it('returns "minimal" at 200 minutes', () => {
    expect(getCurrentPhase(200, defaults)).toBe('minimal');
  });
});
