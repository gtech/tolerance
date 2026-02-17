import { describe, it, expect } from 'vitest';
import type { EngagementScore, ScoreFactors, PostContent } from '../src/shared/types';
import { DEFAULT_SETTINGS } from '../src/shared/types';

describe('EngagementScore type shape', () => {
  it('apiScore is required (can construct without heuristicScore)', () => {
    const score: EngagementScore = {
      postId: 'test',
      apiScore: 75,
      bucket: 'high',
      factors: {},
      timestamp: Date.now(),
    };
    expect(score.apiScore).toBe(75);
    expect((score as Record<string, unknown>).heuristicScore).toBeUndefined();
  });

  it('supports scoreFailed flag', () => {
    const score: EngagementScore = {
      postId: 'test',
      apiScore: 50,
      bucket: 'medium',
      factors: {},
      timestamp: Date.now(),
      scoreFailed: true,
    };
    expect(score.scoreFailed).toBe(true);
  });

  it('scoreFailed defaults to undefined when not set', () => {
    const score: EngagementScore = {
      postId: 'test',
      apiScore: 80,
      bucket: 'high',
      factors: {},
      timestamp: Date.now(),
    };
    expect(score.scoreFailed).toBeUndefined();
  });
});

describe('ScoreFactors', () => {
  it('only has narrative as optional field (no heuristic fields)', () => {
    const factors: ScoreFactors = {};
    expect(factors.narrative).toBeUndefined();
    expect((factors as Record<string, unknown>).engagementRatio).toBeUndefined();
    expect((factors as Record<string, unknown>).keywordFlags).toBeUndefined();
    expect((factors as Record<string, unknown>).viralVelocity).toBeUndefined();
  });

  it('supports narrative detection', () => {
    const factors: ScoreFactors = {
      narrative: {
        themeId: 'doom',
        confidence: 'high',
        matchedKeywords: [],
      },
    };
    expect(factors.narrative?.themeId).toBe('doom');
  });
});

describe('PostContent', () => {
  it('can represent a Reddit post with all fields', () => {
    const content: PostContent = {
      postId: 'abc123',
      platform: 'reddit',
      text: 'Check out this cool thing',
      title: 'Cool Thing [OC]',
      author: 'user123',
      subreddit: 'pics',
      imageUrl: 'https://i.redd.it/abc.jpg',
      thumbnailUrl: 'https://b.thumbs.redditmedia.com/abc.jpg',
      mediaType: 'image',
      timestamp: Date.now(),
    };
    expect(content.platform).toBe('reddit');
    expect(content.title).toBe('Cool Thing [OC]');
    expect(content.imageUrl).toBe('https://i.redd.it/abc.jpg');
    expect(content.mediaType).toBe('image');
  });

  it('can represent a quote tweet with quotedText', () => {
    const content: PostContent = {
      postId: 'tweet456',
      platform: 'twitter',
      text: 'This is wild',
      author: 'user1',
      subreddit: '@user1',
      quotedText: '[Quote from @other]: The original tweet text here',
      timestamp: Date.now(),
    };
    expect(content.quotedText).toContain('@other');
    expect(content.quotedText).toContain('The original tweet text here');
  });

  it('can represent a Reddit gallery post', () => {
    const content: PostContent = {
      postId: 'gallery789',
      platform: 'reddit',
      text: '',
      title: 'My photo collection',
      author: 'photographer',
      subreddit: 'photography',
      imageUrl: 'https://i.redd.it/first-image.jpg',
      mediaType: 'gallery',
      timestamp: Date.now(),
    };
    expect(content.mediaType).toBe('gallery');
    expect(content.imageUrl).toBeDefined();
  });

  it('can represent a YouTube video with only thumbnailUrl', () => {
    const content: PostContent = {
      postId: 'yt_abc',
      platform: 'youtube',
      text: 'Amazing Video Title',
      title: 'Amazing Video Title',
      author: 'SomeChannel',
      thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
      timestamp: Date.now(),
    };
    expect(content.imageUrl).toBeUndefined();
    expect(content.thumbnailUrl).toBeDefined();
  });

  it('can represent an Instagram post with image', () => {
    const content: PostContent = {
      postId: 'ig_123',
      platform: 'instagram',
      text: 'Sunset vibes #photography',
      author: 'photographer',
      imageUrl: 'https://scontent.cdninstagram.com/abc.jpg',
      mediaType: 'image',
      timestamp: Date.now(),
    };
    expect(content.platform).toBe('instagram');
    expect(content.imageUrl).toBeDefined();
  });
});

describe('DEFAULT_SETTINGS.calibration', () => {
  it('has storePostContent defaulting to false', () => {
    expect(DEFAULT_SETTINGS.calibration?.storePostContent).toBe(false);
  });

  it('has storeApiReason defaulting to true', () => {
    expect(DEFAULT_SETTINGS.calibration?.storeApiReason).toBe(true);
  });

  it('has maxEntries set to 500', () => {
    expect(DEFAULT_SETTINGS.calibration?.maxEntries).toBe(500);
  });
});
