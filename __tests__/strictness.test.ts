import { describe, it, expect } from 'vitest';
import { strictnessThresholds, thresholdsToStrictness, STRICTNESS_PRESETS, DEFAULT_BLUR_THRESHOLDS, PRE_0_1_41_BLUR_THRESHOLDS, siteOffset, adjustedThreshold, SITE_OFFSET_MAX } from '../src/shared/constants';

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
    expect(thresholdsToStrictness({ normal: 70, reduced: 55, windDown: 50, minimal: 45 })).toEqual({ level: 3, exact: false });
  });

  it('reads the defaults from before 0.1.41 as closest to Default', () => {
    // Equally far from Gentle and Default; the tie goes to Default
    expect(thresholdsToStrictness(PRE_0_1_41_BLUR_THRESHOLDS)).toEqual({ level: 3, exact: false });
    expect(DEFAULT_BLUR_THRESHOLDS.normal).toBe(70);
  });

  it('clamps out-of-range levels', () => {
    expect(strictnessThresholds(0)).toEqual(strictnessThresholds(1));
    expect(strictnessThresholds(9)).toEqual(strictnessThresholds(5));
  });
});

describe('per-site adjustment', () => {
  it('is zero for a site with none, or with no site at all', () => {
    expect(siteOffset(undefined, 'twitter')).toBe(0);
    expect(siteOffset({ youtube: -10 }, 'twitter')).toBe(0);
    expect(siteOffset({ youtube: -10 }, undefined)).toBe(0);
  });

  it('returns the site\'s own adjustment, kept within the allowed range', () => {
    expect(siteOffset({ youtube: -10 }, 'youtube')).toBe(-10);
    expect(siteOffset({ youtube: -90 }, 'youtube')).toBe(-SITE_OFFSET_MAX);
    expect(siteOffset({ youtube: NaN }, 'youtube')).toBe(0);
  });

  it('stacks with the daily-feedback adjustment and stays between 20 and 100', () => {
    expect(adjustedThreshold(55, 0, -10)).toBe(45);
    expect(adjustedThreshold(55, 5, -10)).toBe(50);
    expect(adjustedThreshold(100, 10, -15)).toBe(95);
    expect(adjustedThreshold(30, -10, -20)).toBe(20);
    expect(adjustedThreshold(90, 10, 20)).toBe(100);
  });
});
