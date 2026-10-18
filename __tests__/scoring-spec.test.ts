import { describe, it, expect } from 'vitest';
import { buildBatchPrompt, buildMediaPrompt, buildSinglePrompt, MEDIA_POST_ID, parseDims, pickPostResult, readScore, scoreFromDims } from '../src/shared/scoring-spec';

describe('scoring spec prompts', () => {
  it('labels each platform correctly', () => {
    const prompt = buildBatchPrompt([
      { id: 'a', platform: 'reddit', text: 'Title A', source: 'aww', likes: 5, comments: 2 },
      { id: 'b', platform: 'twitter', text: 'Tweet B', source: '@x', likes: null, comments: 0 },
      { id: 'c', platform: 'youtube', text: 'Video C', source: 'MIT OpenCourseWare' },
      { id: 'd', platform: 'facebook', text: 'Post D', source: 'Aunt Linda', likes: 3, comments: 1 },
    ]);
    expect(prompt).toContain('Title: "Title A"\nSubreddit: r/aww\nUpvotes: 5, Comments: 2');
    expect(prompt).toContain('Tweet: "Tweet B"\nAuthor: @x\nLikes: (not yet visible), Comments: 0');
    expect(prompt).toContain('Video title: "Video C"\nChannel: MIT OpenCourseWare');
    expect(prompt).not.toMatch(/Channel: MIT OpenCourseWare\n(Likes|Upvotes)/);
    expect(prompt).toContain('Post: "Post D"\nAuthor: Aunt Linda');
    expect(prompt).not.toContain('r/Aunt Linda');
    expect(prompt).toContain('{"results": [');
  });

  it('adds media notes and narrative themes only when relevant', () => {
    const plain = buildSinglePrompt({ platform: 'twitter', text: 'hi', source: '@x' });
    expect(plain).not.toContain('thumbnail');
    expect(plain).not.toContain('narratives');

    const video = buildSinglePrompt(
      { platform: 'twitter', text: '', source: '@x', media: 'video' },
      [{ name: 'AI doom', description: 'AI will end us' }]
    );
    expect(video).toContain('(No tweet)');
    expect(video).toContain('thumbnail');
    expect(video).toContain('1. "AI doom": AI will end us');
    expect(video).toContain('"narratives"');
  });
});

describe('parseDims', () => {
  it('reads and clamps all four ratings', () => {
    expect(parseDims({ hook: 7, effort: 0, pull: 11, value: 2.6 })).toEqual({ hook: 7, effort: 1, pull: 10, value: 3 });
  });
  it('returns undefined when any rating is missing', () => {
    expect(parseDims({ hook: 7, effort: 2, pull: 5 })).toBeUndefined();
    expect(parseDims({ score: 5 })).toBeUndefined();
    expect(parseDims(null)).toBeUndefined();
  });
});

describe('scoreFromDims', () => {
  it('ranks a quick hit above substantive content', () => {
    expect(scoreFromDims({ hook: 8, effort: 2, pull: 8, value: 2 })).toBeGreaterThanOrEqual(8);
    expect(scoreFromDims({ hook: 3, effort: 8, pull: 3, value: 8 })).toBeLessThanOrEqual(3);
  });
});

describe('readScore', () => {
  it('uses the model score, clamped, including numeric strings', () => {
    expect(readScore({ score: 7 })).toBe(7);
    expect(readScore({ score: 0 })).toBe(1);
    expect(readScore({ score: 14 })).toBe(10);
    expect(readScore({ score: '6' })).toBe(6);
  });
  it('falls back to the sub-ratings when the score is missing (Gemini drops it for whole batches)', () => {
    const item = { id: 'x', hook: 8, effort: 2, pull: 7, value: 4, reason: 'Classic comedy, instantly funny.' };
    const s = readScore(item);
    expect(s).toBe(scoreFromDims({ hook: 8, effort: 2, pull: 7, value: 4 }));
    expect(Number.isFinite(s)).toBe(true);
  });
  it('returns undefined rather than NaN when nothing is usable', () => {
    expect(readScore({ reason: 'no numbers' })).toBeUndefined();
    expect(readScore({ score: 'seven' })).toBeUndefined();
    expect(readScore({ score: '' })).toBeUndefined();
    expect(readScore(null)).toBeUndefined();
  });
});

describe('media posts', () => {
  const post = { platform: 'twitter' as const, text: 'look at this chart', source: '@a', media: 'image' as const };

  it('scores a media post alongside the calibration posts, with the image marked as its own', () => {
    const prompt = buildMediaPrompt(post);
    expect(prompt).toContain(`ID: ${MEDIA_POST_ID}`);
    expect(prompt).toContain('ID: calibration-');
    expect(prompt).toContain(`attached image belongs only to post ID ${MEDIA_POST_ID}`);
    expect(buildMediaPrompt(post, [], false)).not.toContain('attached image');
  });

  it("picks the scored post's item, skipping calibration items", () => {
    const reply = { results: [
      { id: 'calibration-1', score: 2 },
      { id: MEDIA_POST_ID, score: 4, reason: 'chart' },
      { id: 'calibration-2', score: 9 },
    ] };
    expect(pickPostResult(reply)).toEqual({ id: MEDIA_POST_ID, score: 4, reason: 'chart' });
    expect(pickPostResult([{ id: 'calibration-1', score: 2 }, { score: 5 }])).toEqual({ score: 5 });
  });

  it('passes single-object replies through', () => {
    expect(pickPostResult({ score: 6, reason: 'x' })).toEqual({ score: 6, reason: 'x' });
  });
});
