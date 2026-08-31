import { describe, it, expect } from 'vitest';
import { mergeDwellIntoImpressions, mergeScrollBuckets } from '../src/shared/attention-utils';
import type { PostImpression, DwellUpdate, ScrollBucket } from '../src/shared/types';

function impression(postId: string, overrides: Partial<PostImpression> = {}): PostImpression {
  return {
    timestamp: 1000,
    postId,
    score: 50,
    bucket: 'medium',
    position: 0,
    originalPosition: 0,
    subreddit: '',
    wasReordered: false,
    ...overrides,
  };
}

describe('mergeDwellIntoImpressions', () => {
  it('accumulates dwell and enters across flushes', () => {
    const posts = [impression('a')];
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 3000, enters: 1, maxContinuousMs: 3000 }]);
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 2000, enters: 2, maxContinuousMs: 1500 }]);

    expect(posts[0].dwellMs).toBe(5000);
    expect(posts[0].viewportEnters).toBe(3);
  });

  it('keeps the max continuous dwell across flush windows', () => {
    // A segment spanning two flush windows reports growing lengths; max() must win
    const posts = [impression('a')];
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 10000, enters: 1, maxContinuousMs: 10000 }]);
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 5000, enters: 0, maxContinuousMs: 15000 }]);
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 1000, enters: 1, maxContinuousMs: 1000 }]);

    expect(posts[0].maxContinuousDwellMs).toBe(15000);
  });

  it('merges into the most recent impression when a post appears twice', () => {
    const posts = [impression('a', { timestamp: 1000 }), impression('a', { timestamp: 2000 })];
    mergeDwellIntoImpressions(posts, [{ postId: 'a', dwellMs: 1000, enters: 1, maxContinuousMs: 1000 }]);

    expect(posts[0].dwellMs).toBeUndefined();
    expect(posts[1].dwellMs).toBe(1000);
  });

  it('returns the number of matched updates and skips unknown posts', () => {
    const posts = [impression('a')];
    const updates: DwellUpdate[] = [
      { postId: 'a', dwellMs: 100, enters: 1, maxContinuousMs: 100 },
      { postId: 'ghost', dwellMs: 100, enters: 1, maxContinuousMs: 100 },
    ];
    expect(mergeDwellIntoImpressions(posts, updates)).toBe(1);
  });
});

describe('mergeScrollBuckets', () => {
  const bucket = (minute: number, overrides: Partial<ScrollBucket> = {}): ScrollBucket => ({
    minute,
    scrolledPx: 100,
    maxVelocityPxS: 500,
    scrollActiveMs: 200,
    ...overrides,
  });

  it('combines buckets for the same minute', () => {
    const merged = mergeScrollBuckets(
      [bucket(1, { scrolledPx: 100, maxVelocityPxS: 500, scrollActiveMs: 200 })],
      [bucket(1, { scrolledPx: 50, maxVelocityPxS: 900, scrollActiveMs: 100 })]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ minute: 1, scrolledPx: 150, maxVelocityPxS: 900, scrollActiveMs: 300 });
  });

  it('keeps distinct minutes sorted', () => {
    const merged = mergeScrollBuckets([bucket(5)], [bucket(2), bucket(7)]);
    expect(merged.map(b => b.minute)).toEqual([2, 5, 7]);
  });

  it('does not mutate its inputs', () => {
    const existing = [bucket(1)];
    mergeScrollBuckets(existing, [bucket(1, { scrolledPx: 999 })]);
    expect(existing[0].scrolledPx).toBe(100);
  });
});
