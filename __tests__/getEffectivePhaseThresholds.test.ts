import { describe, it, expect } from 'vitest';
import { getEffectivePhaseThresholds } from '../src/background/storage';

const base = { normal: 15, reduced: 45, windDown: 75 };

describe('getEffectivePhaseThresholds', () => {
  it('returns unchanged thresholds with multiplier 1.0', () => {
    expect(getEffectivePhaseThresholds(base, 1.0)).toEqual({
      normal: 15,
      reduced: 45,
      windDown: 75,
    });
  });

  it('halves thresholds with multiplier 2.0 (faster progression)', () => {
    expect(getEffectivePhaseThresholds(base, 2.0)).toEqual({
      normal: 8,    // 15/2 = 7.5 → rounds to 8
      reduced: 23,  // 45/2 = 22.5 → rounds to 23
      windDown: 38, // 75/2 = 37.5 → rounds to 38
    });
  });

  it('doubles thresholds with multiplier 0.5 (slower progression)', () => {
    expect(getEffectivePhaseThresholds(base, 0.5)).toEqual({
      normal: 30,
      reduced: 90,
      windDown: 150,
    });
  });

  it('rounds correctly (Math.round behavior)', () => {
    // 15 / 2 = 7.5 → 8 (Math.round rounds .5 up)
    const result = getEffectivePhaseThresholds(base, 2.0);
    expect(result.normal).toBe(8);
  });
});
