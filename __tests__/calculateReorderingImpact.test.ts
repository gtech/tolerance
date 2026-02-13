import { describe, it, expect } from 'vitest';
import { calculateReorderingImpact } from '../src/background/scheduler';
import type { EngagementScore } from '../src/shared/types';

function makeScore(id: string, bucket: 'low' | 'medium' | 'high'): [string, EngagementScore] {
  return [id, {
    postId: id,
    heuristicScore: 50,
    heuristicConfidence: 'medium',
    bucket,
    factors: { engagementRatio: 0, commentDensity: 0, keywordFlags: [], viralVelocity: 0 },
    timestamp: Date.now(),
  }];
}

describe('calculateReorderingImpact', () => {
  it('returns zeros when order is the same', () => {
    const order = ['a', 'b', 'c'];
    const scores = new Map([makeScore('a', 'high'), makeScore('b', 'medium'), makeScore('c', 'low')]);
    const result = calculateReorderingImpact(order, order, scores);
    expect(result).toEqual({
      postsReordered: 0,
      highEngagementMovedDown: 0,
      averagePositionChange: 0,
    });
  });

  it('counts a high-bucket post moved down', () => {
    const original = ['a', 'b', 'c'];
    const reordered = ['b', 'c', 'a']; // 'a' moved from 0 to 2
    const scores = new Map([makeScore('a', 'high'), makeScore('b', 'medium'), makeScore('c', 'low')]);
    const result = calculateReorderingImpact(original, reordered, scores);
    expect(result.highEngagementMovedDown).toBe(1);
    expect(result.postsReordered).toBe(3); // all moved
  });

  it('does NOT count a high-bucket post moved up in highEngagementMovedDown', () => {
    const original = ['a', 'b', 'c'];
    const reordered = ['c', 'a', 'b']; // 'a' moved from 0 to 1 (down), 'c' moved from 2 to 0 (up)
    const scores = new Map([makeScore('a', 'low'), makeScore('b', 'low'), makeScore('c', 'high')]);
    const result = calculateReorderingImpact(original, reordered, scores);
    // 'c' is high and moved UP (2→0), should NOT count
    expect(result.highEngagementMovedDown).toBe(0);
  });

  it('returns zeros for empty arrays', () => {
    const scores = new Map<string, EngagementScore>();
    const result = calculateReorderingImpact([], [], scores);
    expect(result).toEqual({
      postsReordered: 0,
      highEngagementMovedDown: 0,
      averagePositionChange: 0,
    });
  });

  it('skips posts in original that are missing from new order', () => {
    const original = ['a', 'b', 'c'];
    const reordered = ['b', 'c']; // 'a' is missing
    const scores = new Map([makeScore('a', 'high'), makeScore('b', 'medium'), makeScore('c', 'low')]);
    const result = calculateReorderingImpact(original, reordered, scores);
    // 'a' is missing from new → skipped (newPos === undefined)
    // 'b' moved 1→0, 'c' moved 2→1
    expect(result.postsReordered).toBe(2);
    expect(result.highEngagementMovedDown).toBe(0);
  });
});
