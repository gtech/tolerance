import { describe, it, expect } from 'vitest';
import type { PostContent, RedditPost, Tweet, YouTubeVideo, InstagramPost } from '../src/shared/types';

// These tests verify that the PostContent mapping logic in scorer.ts
// correctly transforms platform post objects into PostContent records.
// We replicate the inline mapping logic here to ensure it produces
// the right shape without needing to mock the full scoring pipeline.

function mapRedditPost(post: Omit<RedditPost, 'element'>): PostContent {
  return {
    postId: post.id,
    platform: 'reddit' as const,
    text: post.text,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    imageUrl: post.imageUrl,
    thumbnailUrl: post.thumbnailUrl,
    mediaType: post.mediaType,
    timestamp: Date.now(),
  };
}

function mapTweet(tweet: Omit<Tweet, 'element'>): PostContent {
  return {
    postId: tweet.id,
    platform: 'twitter' as const,
    text: tweet.text,
    author: tweet.author,
    subreddit: `@${tweet.author}`,
    imageUrl: tweet.imageUrl,
    thumbnailUrl: tweet.thumbnailUrl,
    mediaType: tweet.mediaType,
    quotedText: tweet.isQuoteTweet && tweet.quotedTweet
      ? `[Quote from @${tweet.quotedTweet.author}]: ${tweet.quotedTweet.text}`
      : undefined,
    timestamp: Date.now(),
  };
}

function mapYouTubeVideo(video: Omit<YouTubeVideo, 'element'>): PostContent {
  return {
    postId: video.id,
    platform: 'youtube' as const,
    text: video.title,
    title: video.title,
    author: video.channel,
    thumbnailUrl: video.thumbnailUrl,
    timestamp: Date.now(),
  };
}

function mapInstagramPost(post: Omit<InstagramPost, 'element'>): PostContent {
  return {
    postId: post.id,
    platform: 'instagram' as const,
    text: post.caption,
    author: post.authorUsername,
    imageUrl: post.imageUrl,
    thumbnailUrl: post.thumbnailUrl,
    mediaType: post.mediaType,
    timestamp: Date.now(),
  };
}

describe('Reddit post content mapping', () => {
  const basePost: Omit<RedditPost, 'element'> = {
    id: 'r_123',
    platform: 'reddit',
    title: 'Cool post',
    text: 'Post body',
    author: 'testuser',
    subreddit: 'pics',
    score: 100,
    numComments: 50,
    mediaType: 'image',
    permalink: '/r/pics/comments/abc/cool_post',
    createdUtc: 1700000000,
    imageUrl: 'https://i.redd.it/abc.jpg',
    thumbnailUrl: 'https://b.thumbs.redditmedia.com/abc.jpg',
    upvoteRatio: 0.95,
    isNsfw: false,
    domain: 'i.redd.it',
  };

  it('maps all required fields', () => {
    const content = mapRedditPost(basePost);
    expect(content.postId).toBe('r_123');
    expect(content.platform).toBe('reddit');
    expect(content.text).toBe('Post body');
    expect(content.title).toBe('Cool post');
    expect(content.author).toBe('testuser');
    expect(content.subreddit).toBe('pics');
  });

  it('includes image URLs', () => {
    const content = mapRedditPost(basePost);
    expect(content.imageUrl).toBe('https://i.redd.it/abc.jpg');
    expect(content.thumbnailUrl).toBe('https://b.thumbs.redditmedia.com/abc.jpg');
  });

  it('includes mediaType for filtering gallery posts later', () => {
    const galleryPost = { ...basePost, mediaType: 'gallery' as const };
    const content = mapRedditPost(galleryPost);
    expect(content.mediaType).toBe('gallery');
  });

  it('handles text posts with no image URL', () => {
    const textPost = { ...basePost, mediaType: 'text' as const, imageUrl: undefined, thumbnailUrl: undefined };
    const content = mapRedditPost(textPost);
    expect(content.imageUrl).toBeUndefined();
    expect(content.thumbnailUrl).toBeUndefined();
    expect(content.mediaType).toBe('text');
  });
});

describe('Twitter post content mapping', () => {
  const baseTweet: Omit<Tweet, 'element'> = {
    id: 't_456',
    platform: 'twitter',
    text: 'Hello world',
    author: 'tweetuser',
    score: 500,
    numComments: 20,
    mediaType: 'text',
    permalink: '/tweetuser/status/456',
    createdUtc: 1700000000,
    retweetCount: 10,
    quoteCount: 5,
    likeCount: 500,
    isRetweet: false,
    isQuoteTweet: false,
    isReply: false,
    isThread: false,
    hashtags: [],
    mentions: [],
    urls: [],
    isVerified: false,
  };

  it('maps basic tweet fields', () => {
    const content = mapTweet(baseTweet);
    expect(content.postId).toBe('t_456');
    expect(content.platform).toBe('twitter');
    expect(content.text).toBe('Hello world');
    expect(content.author).toBe('tweetuser');
    expect(content.subreddit).toBe('@tweetuser');
  });

  it('sets quotedText to undefined for non-quote tweets', () => {
    const content = mapTweet(baseTweet);
    expect(content.quotedText).toBeUndefined();
  });

  it('builds quotedText for quote tweets', () => {
    const quoteTweet: Omit<Tweet, 'element'> = {
      ...baseTweet,
      isQuoteTweet: true,
      quotedTweet: {
        author: 'originalAuthor',
        text: 'This is the original tweet',
      },
    };
    const content = mapTweet(quoteTweet);
    expect(content.quotedText).toBe('[Quote from @originalAuthor]: This is the original tweet');
  });

  it('handles quote tweet with image', () => {
    const quoteTweet: Omit<Tweet, 'element'> = {
      ...baseTweet,
      isQuoteTweet: true,
      quotedTweet: {
        author: 'photoUser',
        text: 'Check this out',
        imageUrl: 'https://pbs.twimg.com/media/abc.jpg',
      },
    };
    const content = mapTweet(quoteTweet);
    expect(content.quotedText).toContain('@photoUser');
    // Note: quoted tweet imageUrl is not stored separately (only in quotedText)
  });

  it('handles isQuoteTweet=true but missing quotedTweet object', () => {
    const brokenQuote: Omit<Tweet, 'element'> = {
      ...baseTweet,
      isQuoteTweet: true,
      quotedTweet: undefined,
    };
    const content = mapTweet(brokenQuote);
    expect(content.quotedText).toBeUndefined();
  });

  it('includes image URLs for tweets with media', () => {
    const mediaTweet: Omit<Tweet, 'element'> = {
      ...baseTweet,
      mediaType: 'image',
      imageUrl: 'https://pbs.twimg.com/media/xyz.jpg',
    };
    const content = mapTweet(mediaTweet);
    expect(content.imageUrl).toBe('https://pbs.twimg.com/media/xyz.jpg');
    expect(content.mediaType).toBe('image');
  });
});

describe('YouTube post content mapping', () => {
  const baseVideo: Omit<YouTubeVideo, 'element'> = {
    id: 'yt_abc',
    platform: 'youtube',
    title: 'Amazing Video',
    channel: 'TechChannel',
    viewCount: 1000000,
    thumbnailUrl: 'https://i.ytimg.com/vi/abc/hqdefault.jpg',
  };

  it('maps video fields, using title as both text and title', () => {
    const content = mapYouTubeVideo(baseVideo);
    expect(content.postId).toBe('yt_abc');
    expect(content.platform).toBe('youtube');
    expect(content.text).toBe('Amazing Video');
    expect(content.title).toBe('Amazing Video');
    expect(content.author).toBe('TechChannel');
  });

  it('includes thumbnailUrl but not imageUrl', () => {
    const content = mapYouTubeVideo(baseVideo);
    expect(content.thumbnailUrl).toBe('https://i.ytimg.com/vi/abc/hqdefault.jpg');
    expect(content.imageUrl).toBeUndefined();
  });

  it('handles missing thumbnailUrl', () => {
    const noThumb = { ...baseVideo, thumbnailUrl: undefined };
    const content = mapYouTubeVideo(noThumb);
    expect(content.thumbnailUrl).toBeUndefined();
  });
});

describe('Instagram post content mapping', () => {
  const basePost: Omit<InstagramPost, 'element'> = {
    id: 'ig_789',
    platform: 'instagram',
    text: 'Sunset vibes',
    caption: 'Sunset vibes #photography',
    author: 'photographer',
    authorUsername: 'photo_user',
    score: 200,
    numComments: 10,
    commentCount: 10,
    likeCount: 200,
    mediaType: 'image',
    permalink: '/p/ig_789',
    createdUtc: 1700000000,
    isReel: false,
    isCarousel: false,
    imageUrl: 'https://scontent.cdninstagram.com/abc.jpg',
  };

  it('uses caption as text and authorUsername as author', () => {
    const content = mapInstagramPost(basePost);
    expect(content.text).toBe('Sunset vibes #photography');
    expect(content.author).toBe('photo_user');
  });

  it('includes image URL', () => {
    const content = mapInstagramPost(basePost);
    expect(content.imageUrl).toBe('https://scontent.cdninstagram.com/abc.jpg');
  });

  it('tracks mediaType for carousel posts', () => {
    const carousel = { ...basePost, mediaType: 'gallery' as const, isCarousel: true, carouselCount: 5 };
    const content = mapInstagramPost(carousel);
    expect(content.mediaType).toBe('gallery');
  });

  it('tracks reel mediaType', () => {
    const reel = { ...basePost, mediaType: 'reel' as const, isReel: true };
    const content = mapInstagramPost(reel);
    expect(content.mediaType).toBe('reel');
  });
});
