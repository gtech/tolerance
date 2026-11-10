import { describe, it, expect } from 'vitest';
import {
  addToDay, checkPost, evaluateDay, lastFinishedDay, tallyPosts, HEALTH_KEEP_DAYS,
  type HealthHistory, type HealthPlatform,
} from '../src/shared/scrape-health';

// The scraper health check. Its first job is to have caught what November 2026's YouTube
// class rename did, so those cases are here as they were found.

const video = (over: Record<string, unknown> = {}) => ({
  id: 'abc12345678', title: 'How indexes work', channel: 'IndexNerd', viewCount: 36000, duration: '12:34', thumbnailUrl: 'https://i.ytimg.com/x.jpg', ...over,
});

describe('checkPost', () => {
  it('finds everything on a well-scraped YouTube video', () => {
    expect(checkPost('youtube', video())).toEqual({ title: true, channel: true, length: true, views: true, thumbnail: true });
  });

  it('sees what the class rename broke: no length, no views, no sidebar channel', () => {
    const broken = checkPost('youtube', video({ duration: undefined, viewCount: 0, channel: '' }));
    expect(broken).toMatchObject({ title: true, channel: false, length: false, views: false });
  });

  it('does not expect a length or view count on a Short, a live stream or an ad', () => {
    expect(checkPost('youtube', video({ isShort: true, channel: '', duration: undefined, viewCount: 0 })))
      .toMatchObject({ channel: null, length: null, views: null });
    expect(checkPost('youtube', video({ isLive: true, duration: 'LIVE' }))).toMatchObject({ length: null, views: null, channel: true });
    expect(checkPost('youtube', video({ title: '[Sponsored] Buy now', duration: 'Sponsored', viewCount: 0, channel: 'AdCorp' })))
      .toMatchObject({ title: true, channel: true, length: null, views: null });
  });

  it('counts a title that is only a marker as missing', () => {
    expect(checkPost('youtube', video({ title: '[Sponsored] ' })).title).toBe(false);
  });

  it('checks the other sites\' essentials', () => {
    expect(checkPost('reddit', { title: 'A headline', subreddit: 'news', permalink: '/r/news/1' })).toEqual({ title: true, subreddit: true, link: true });
    expect(checkPost('reddit', { title: '', subreddit: 'news', permalink: '' })).toEqual({ title: false, subreddit: true, link: false });
    expect(checkPost('twitter', { author: 'someone', text: '', mediaType: 'image' })).toEqual({ author: true, content: true });
    expect(checkPost('twitter', { author: '', text: '', mediaType: 'text' })).toEqual({ author: false, content: false });
    expect(checkPost('instagram', { id: 'DAbC_12', authorUsername: 'someone', caption: 'Hi' })).toEqual({ author: true, content: true, stableId: true });
    expect(checkPost('instagram', { id: '3141592653', authorUsername: '', caption: '' })).toEqual({ author: false, content: false, stableId: false });
    expect(checkPost('facebook', { id: 'fb_hash_k3j2', authorDisplayName: 'Page', caption: '' , imageUrl: 'https://x/y.jpg' })).toEqual({ author: true, content: true, stableId: false });
  });
});

describe('tallyPosts', () => {
  it('counts found against seen, leaving out what does not apply', () => {
    const t = tallyPosts('youtube', [video(), video({ channel: '' }), video({ isShort: true, channel: '' })]);
    expect(t.posts).toBe(3);
    expect(t.fields.channel).toEqual({ seen: 2, found: 1 });   // the Short isn't expected to have one
    expect(t.fields.length).toEqual({ seen: 2, found: 2 });
    expect(t.fields.title).toEqual({ seen: 3, found: 3 });
  });
});

describe('addToDay', () => {
  it('adds up counts from separate batches and tabs', () => {
    let h: HealthHistory = {};
    h = addToDay(h, '2026-11-10', 'youtube', { loads: 1 });
    h = addToDay(h, '2026-11-10', 'youtube', tallyPosts('youtube', [video(), video()]));
    h = addToDay(h, '2026-11-10', 'youtube', tallyPosts('youtube', [video({ duration: undefined })]));
    h = addToDay(h, '2026-11-10', 'reddit', { loads: 2 });
    expect(h['2026-11-10'].youtube).toMatchObject({ loads: 1, posts: 3 });
    expect(h['2026-11-10'].youtube!.fields.length).toEqual({ seen: 3, found: 2 });
    expect(h['2026-11-10'].reddit).toMatchObject({ loads: 2, posts: 0 });
  });

  it('does not change the history it was given, and keeps only the latest days', () => {
    const start: HealthHistory = {};
    let h = start;
    for (let d = 1; d <= HEALTH_KEEP_DAYS + 5; d++) h = addToDay(h, `2026-10-${String(d).padStart(2, '0')}`, 'reddit', { loads: 1 });
    expect(start).toEqual({});
    expect(Object.keys(h)).toHaveLength(HEALTH_KEEP_DAYS);
    expect(Object.keys(h)[0]).toBe('2026-10-06');
  });
});

// A day on which `rate` of `n` posts had the field found
function day(platform: HealthPlatform, field: string, n: number, rate: number, loads = 3): HealthHistory[string] {
  return { [platform]: { loads, posts: n, fields: { [field]: { seen: n, found: Math.round(n * rate) } } } };
}

describe('evaluateDay', () => {
  it('is quiet when everything is found', () => {
    const h: HealthHistory = { '2026-11-09': day('youtube', 'length', 100, 0.98), '2026-11-10': day('youtube', 'length', 100, 0.97) };
    expect(evaluateDay(h, '2026-11-10')).toEqual([]);
  });

  it('raises a field that is found on almost no posts, with no history needed', () => {
    const alerts = evaluateDay({ '2026-11-10': day('youtube', 'length', 88, 0) }, '2026-11-10');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ platform: 'youtube', field: 'length', kind: 'low', rate: 0, seen: 88 });
    expect(alerts[0].message).toBe('YouTube: length found on only 0% of 88 posts.');
  });

  it('raises a sharp fall against the days before, even when still above the floor', () => {
    const h: HealthHistory = {
      '2026-11-08': day('twitter', 'author', 100, 1), '2026-11-09': day('twitter', 'author', 100, 0.98),
      '2026-11-10': day('twitter', 'author', 60, 0.85),
    };
    expect(evaluateDay(h, '2026-11-10')).toEqual([]);   // 85% is a wobble, not a break
    h['2026-11-10'] = day('twitter', 'author', 60, 0.6);
    const alerts = evaluateDay(h, '2026-11-10');
    expect(alerts[0]).toMatchObject({ field: 'author', kind: 'drop' });
    expect(alerts[0].message).toBe('X: author found on 60% of 60 posts, down from 99%.');
  });

  it('watches a field with no floor only for a fall', () => {
    // Facebook posts often have no stable id, so a steady 30% is normal
    const steady: HealthHistory = { '2026-11-09': day('facebook', 'stableId', 80, 0.3), '2026-11-10': day('facebook', 'stableId', 80, 0.28) };
    expect(evaluateDay(steady, '2026-11-10')).toEqual([]);
    const fell: HealthHistory = { '2026-11-09': day('facebook', 'stableId', 80, 0.9), '2026-11-10': day('facebook', 'stableId', 80, 0.2) };
    expect(evaluateDay(fell, '2026-11-10')[0]).toMatchObject({ field: 'stableId', kind: 'drop' });
  });

  it('says nothing on too few posts', () => {
    expect(evaluateDay({ '2026-11-10': day('youtube', 'length', 12, 0) }, '2026-11-10')).toEqual([]);
  });

  it('does not call a thin history "usual"', () => {
    const h: HealthHistory = { '2026-11-09': day('instagram', 'stableId', 10, 1), '2026-11-10': day('instagram', 'stableId', 40, 0.4) };
    expect(evaluateDay(h, '2026-11-10')).toEqual([]);
  });

  it('raises a site where feed pages were opened and no posts were found', () => {
    const h: HealthHistory = { '2026-11-10': { instagram: { loads: 4, posts: 0, fields: {} } } };
    const alerts = evaluateDay(h, '2026-11-10');
    expect(alerts).toEqual([expect.objectContaining({ platform: 'instagram', field: null, kind: 'no-posts', seen: 4 })]);
    expect(alerts[0].message).toContain('no posts found on 4 feed pages');
    // One or two page loads with nothing is an empty feed or a quick visit
    h['2026-11-10'] = { instagram: { loads: 2, posts: 0, fields: {} } };
    expect(evaluateDay(h, '2026-11-10')).toEqual([]);
  });

  it('reports each site and field separately, and ignores sites not visited', () => {
    const h: HealthHistory = {
      '2026-11-10': {
        youtube: { loads: 5, posts: 150, fields: { length: { seen: 88, found: 0 }, views: { seen: 88, found: 0 }, channel: { seen: 140, found: 80 }, title: { seen: 150, found: 150 } } },
        reddit: { loads: 2, posts: 60, fields: { title: { seen: 60, found: 60 } } },
      },
    };
    expect(evaluateDay(h, '2026-11-10').map(a => `${a.platform}.${a.field}`).sort()).toEqual(['youtube.channel', 'youtube.length', 'youtube.views']);
  });

  it('only compares with the week before', () => {
    const h: HealthHistory = { '2026-10-01': day('reddit', 'title', 200, 1), '2026-11-10': day('reddit', 'title', 50, 0.85) };
    for (let d = 2; d <= 9; d++) h[`2026-11-0${d}`] = day('reddit', 'title', 5, 0.85);
    // The good day a month ago has fallen out of the window, and the recent days are too thin to be "usual"
    expect(evaluateDay(h, '2026-11-10')).toEqual([]);
  });
});

describe('lastFinishedDay', () => {
  it('is the latest day with counts before today', () => {
    const h: HealthHistory = { '2026-11-08': {}, '2026-11-09': {}, '2026-11-10': {} };
    expect(lastFinishedDay(h, '2026-11-10')).toBe('2026-11-09');
    expect(lastFinishedDay(h, '2026-11-12')).toBe('2026-11-10');
    expect(lastFinishedDay({ '2026-11-10': {} }, '2026-11-10')).toBeUndefined();
  });
});
