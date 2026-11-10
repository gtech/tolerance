import { describe, it, expect } from 'vitest';
import { activeRubric, buildBatchPrompt, buildMediaPrompt, buildSinglePrompt, IMAGE_DESCRIPTION_MAX, MEDIA_POST_ID, parseDims, pickPostResult, readImageDescription, readScore, RUBRIC, rubricHash, scoreFromDims, SPONSORED_PREFIX } from '../src/shared/scoring-spec';

describe('ad note', () => {
  const posts = (['reddit', 'twitter', 'youtube', 'instagram', 'facebook'] as const)
    .map(platform => ({ id: 'a', platform, text: 'Post', source: 'Brand' }));

  it('is in prompts for every platform, even with a custom rubric', () => {
    for (const post of posts) {
      expect(buildBatchPrompt([post])).toContain('Advertisements:');
      expect(buildSinglePrompt(post)).toContain('Advertisements:');
      expect(buildMediaPrompt(post)).toContain('Advertisements:');
      expect(buildBatchPrompt([post], [], undefined, 'My rubric')).toContain('Advertisements:');
    }
  });

  it('tells the model how sponsored posts are labeled', () => {
    expect(buildBatchPrompt([posts[0]])).toContain(SPONSORED_PREFIX.trim());
  });

  it('can be turned off', () => {
    for (const post of posts) {
      expect(buildBatchPrompt([post], [], undefined, RUBRIC, false)).not.toContain('Advertisements:');
      expect(buildSinglePrompt(post, [], RUBRIC, false)).not.toContain('Advertisements:');
      expect(buildMediaPrompt(post, [], true, RUBRIC, false)).not.toContain('Advertisements:');
    }
  });
});

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

  it('asks for a description of the image only when one is attached, whatever the rubric', () => {
    expect(buildMediaPrompt(post)).toContain('also include "image"');
    expect(buildMediaPrompt(post, [], true, 'My own rubric.')).toContain('also include "image"');
    expect(buildMediaPrompt(post, [], false)).not.toContain('"image"');
  });

  it('reads the description from a reply, tidied and capped', () => {
    expect(readImageDescription({ score: 7, image: '  A bar chart of\n rainfall by month. ' })).toBe('A bar chart of rainfall by month.');
    expect(readImageDescription({ score: 7, image: 'x'.repeat(1000) })).toHaveLength(IMAGE_DESCRIPTION_MAX);
    for (const none of [{ score: 7 }, { image: '' }, { image: '   ' }, { image: 42 }, { image: null }, null, 'text']) {
      expect(readImageDescription(none)).toBeUndefined();
    }
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

describe('editable rubric', () => {
  const custom = 'Rate how much the post is about cats. 1 = no cats, 10 = all cats.';

  it('falls back to the default for an unset or blank rubric', () => {
    expect(activeRubric(undefined)).toBe(RUBRIC);
    expect(activeRubric('  \n ')).toBe(RUBRIC);
    expect(activeRubric(`  ${custom}\n`)).toBe(custom);
  });

  it('hashes only edited rubrics, so existing scores stay valid', () => {
    expect(rubricHash(RUBRIC)).toBeUndefined();
    expect(rubricHash(`${RUBRIC}\n`)).toBeUndefined();
    expect(rubricHash(custom)).toMatch(/^[0-9a-f]{8}$/);
    expect(rubricHash(custom)).toBe(rubricHash(custom));
    expect(rubricHash(custom)).not.toBe(rubricHash(`${custom} Dogs count half.`));
  });

  it('puts the given rubric in every prompt, keeping the output format', () => {
    const post = { id: 'a', platform: 'twitter' as const, text: 'hi', source: '@x' };
    for (const prompt of [
      buildSinglePrompt(post, [], custom),
      buildBatchPrompt([post], [], undefined, custom),
      buildMediaPrompt({ ...post, media: 'image' }, [], true, custom),
    ]) {
      expect(prompt).toContain(custom);
      expect(prompt).not.toContain('Measure CHEAP PAYOFF');
      expect(prompt).toContain('"hook": <1-10>');
    }
    expect(buildBatchPrompt([post])).toContain('Measure CHEAP PAYOFF');
  });
});
