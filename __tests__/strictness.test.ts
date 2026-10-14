import { describe, it, expect } from 'vitest';
import { strictnessThresholds, thresholdsToStrictness, STRICTNESS_PRESETS, DEFAULT_BLUR_THRESHOLDS } from '../src/shared/constants';

describe('strictness presets', () => {
  it('middle level is the calibrated defaults', () => {
    expect(strictnessThresholds(3)).toEqual(DEFAULT_BLUR_THRESHOLDS);
  });

  it('stricter levels never blur less in any phase', () => {
    for (let level = 2; level <= STRICTNESS_PRESETS.length; level++) {
      const looser = strictnessThresholds(level - 1);
      const stricter = strictnessThresholds(level);
      for (const key of ['normal', 'reduced', 'windDown', 'minimal'] as const) {
        expect(stricter[key]).toBeLessThanOrEqual(looser[key]);
      }
    }
  });

  it('each preset tightens across the session', () => {
    for (const { thresholds: t } of STRICTNESS_PRESETS) {
      expect(t.normal).toBeGreaterThanOrEqual(t.reduced);
      expect(t.reduced).toBeGreaterThanOrEqual(t.windDown);
      expect(t.windDown).toBeGreaterThanOrEqual(t.minimal);
    }
  });

  it('round-trips presets and flags fine-tuned values as inexact', () => {
    for (let level = 1; level <= 5; level++) {
      expect(thresholdsToStrictness(strictnessThresholds(level))).toEqual({ level, exact: true });
    }
    expect(thresholdsToStrictness({ normal: 100, reduced: 75, windDown: 60, minimal: 40 })).toEqual({ level: 3, exact: false });
  });

  it('clamps out-of-range levels', () => {
    expect(strictnessThresholds(0)).toEqual(strictnessThresholds(1));
    expect(strictnessThresholds(9)).toEqual(strictnessThresholds(5));
  });
});
