import { describe, it, expect } from 'vitest';
import { buildBatchPrompt, buildSinglePrompt, parseDims, scoreFromDims } from '../src/shared/scoring-spec';

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
