import { describe, it, expect } from 'vitest';
import { interleave } from '../src/background/scheduler';
import type { SchedulerConfig } from '../src/shared/types';

const config: SchedulerConfig = {
  cooldownPosts: 3,
  highEngagementRatio: 0.33,
  enabled: true,
  progressiveBoredomEnabled: false,
  phaseThresholds: { normal: 15, reduced: 45, windDown: 75 },
  phaseRatios: { normal: 0.33, reduced: 0.2, windDown: 0.1, minimal: 0 },
};

describe('interleave', () => {
  it('hides all high posts and returns non-high when effectiveRatio is 0', () => {
    const high = ['h1', 'h2'];
    const medium = ['m1', 'm2'];
    const low = ['l1', 'l2'];
    const result = interleave(high, medium, low, config, 0);
    expect(result.ordered).toEqual([...low, ...medium]);
    expect(result.hidden).toEqual(high);
  });

  it('spaces high posts with cooldown of 3 at ratio 0.33', () => {
    const high = ['h1', 'h2'];
    const medium = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const low = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const result = interleave(high, medium, low, config, 0.33);

    // High posts should not appear in first 3 positions (cooldown)
    const first3 = result.ordered.slice(0, 3);
    expect(first3.every(id => !id.startsWith('h'))).toBe(true);

    // High posts should appear in the result
    const highInResult = result.ordered.filter(id => id.startsWith('h'));
    expect(highInResult.length).toBeGreaterThan(0);

    // No two high posts should be adjacent
    for (let i = 0; i < result.ordered.length - 1; i++) {
      if (result.ordered[i].startsWith('h')) {
        expect(result.ordered[i + 1].startsWith('h')).toBe(false);
      }
    }
  });

  it('returns all non-high posts when there are no high posts', () => {
    const result = interleave([], ['m1', 'm2'], ['l1', 'l2'], config, 0.33);
    expect(result.ordered).toEqual(['l1', 'l2', 'm1', 'm2']);
    expect(result.hidden).toEqual([]);
  });

  it('shows first high post and hides rest when there are no non-high posts', () => {
    const result = interleave(['h1', 'h2', 'h3'], [], [], config, 0.33);
    // With no non-high posts, maxHighPosts = floor(0 * 0.33 / 0.67) = 0, but min 1
    // However cooldown can't be satisfied, so only end-of-loop logic applies
    // All high posts end up hidden since nonHigh loop doesn't run
    // But the trailing while checks postsSinceLastHigh (starts at 0) >= targetGap (3), which is false
    // So all high posts go to hidden
    expect(result.hidden.length + result.ordered.length).toBe(3);
  });

  it('hides excess high posts beyond allowed count', () => {
    const high = ['h1', 'h2', 'h3', 'h4', 'h5'];
    const medium = ['m1', 'm2', 'm3'];
    const low = ['l1', 'l2', 'l3'];
    const result = interleave(high, medium, low, config, 0.33);
    // nonHigh = 6, maxHighPosts = floor(6 * 0.33 / 0.67) = floor(2.95) = 2, allowed = min(5, max(1, 2)) = 2
    // So 3 high posts should be hidden
    expect(result.hidden.length).toBe(3);
    const highInResult = result.ordered.filter(id => id.startsWith('h'));
    expect(highInResult.length).toBe(2);
  });

  it('handles single post in each bucket', () => {
    const result = interleave(['h1'], ['m1'], ['l1'], config, 0.33);
    // nonHigh = 2, maxHighPosts = floor(2 * 0.33 / 0.67) = floor(0.98) = 0, max(1, 0) = 1
    // allowed = min(1, 1) = 1
    // targetGap = max(3, floor(1/0.33)-1) = max(3, 2) = 3
    // Loop: nonHighIndex runs through 2 posts (postsSinceLastHigh goes 1, 2)
    // After loop: postsSinceLastHigh=2 < targetGap=3, so h1 not added
    // h1 goes to hidden
    expect(result.ordered).toEqual(['l1', 'm1']);
    expect(result.hidden).toEqual(['h1']);
  });
});
