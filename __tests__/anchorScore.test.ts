import { describe, it, expect } from 'vitest';
import { anchorCacheId, foldAnchorScore } from '../src/shared/anchor-utils';
import { EngagementScore, TweetAnchor } from '../src/shared/types';

function makeScore(postId: string, apiScore: number, apiReason?: string): EngagementScore {
  return { postId, apiScore, apiReason, bucket: 'low', factors: {}, timestamp: Date.now(), scoreFailed: false };
}

const quote: TweetAnchor = { kind: 'quote', author: 'baiter', text: 'Hot take: everyone is wrong' };

describe('anchorCacheId', () => {
  it('uses the status ID for thread parents', () => {
    expect(anchorCacheId({ kind: 'reply', id: '123', author: 'x', text: 'y' })).toBe('123');
  });

  it('is stable for the same quote and case-insensitive on author', () => {
    expect(anchorCacheId(quote)).toBe(anchorCacheId({ ...quote, author: 'Baiter' }));
    expect(anchorCacheId(quote)).toMatch(/^anchor:baiter:/);
  });

  it('differs for different quote text', () => {
    expect(anchorCacheId(quote)).not.toBe(anchorCacheId({ ...quote, text: 'Another take' }));
  });
});

describe('foldAnchorScore', () => {
  it('raises a thoughtful reply to the bait score and explains why', () => {
    const score = makeScore('1', 20, 'thoughtful analysis');
    foldAnchorScore(score, quote, makeScore('a', 85, 'opinion farming'));
    expect(score.apiScore).toBe(85);
    expect(score.bucket).toBe('high');
    expect(score.apiReason).toBe("Quotes @baiter's bait: opinion farming");
    expect(score.anchor).toMatchObject({ kind: 'quote', author: 'baiter', score: 85, ownScore: 20 });
  });

  it('labels replies as replies', () => {
    const score = makeScore('1', 20);
    foldAnchorScore(score, { kind: 'reply', id: '9', author: 'baiter', text: 't' }, makeScore('9', 70, 'rage bait'));
    expect(score.apiReason).toBe("Replies to @baiter's bait: rage bait");
  });

  it('leaves the score alone when the anchor is calmer than the post', () => {
    const score = makeScore('1', 60, 'own reason');
    foldAnchorScore(score, quote, makeScore('a', 30));
    expect(score.apiScore).toBe(60);
    expect(score.apiReason).toBe('own reason');
    expect(score.anchor).toBeUndefined();
  });

  it('ignores failed anchor scores', () => {
    const score = makeScore('1', 20);
    foldAnchorScore(score, quote, { ...makeScore('a', 50), scoreFailed: true });
    expect(score.apiScore).toBe(20);
  });
});
