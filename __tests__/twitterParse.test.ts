import { describe, it, expect } from 'vitest';
import { parseEngagementLabel, snowflakeSeconds } from '../src/shared/twitter-parse';
import { CELL_SELECTOR, TWEET_CELL_SELECTORS, TWEET_SELECTOR } from '../src/content/twitter/dom';

// Twitter's site as rebuilt in November 2026: no data-testid, no <time>.

describe('snowflakeSeconds', () => {
  it('reads the time a post was made from its ID', () => {
    // A well-known reference: ID 1541815603606036480 was created 2022-06-28T16:07:40Z
    expect(snowflakeSeconds('1541815603606036480')).toBe(Date.UTC(2022, 5, 28, 16, 7, 40) / 1000);
  });

  it('says nothing for IDs from before the scheme, or for junk', () => {
    expect(snowflakeSeconds('20')).toBeUndefined();
    expect(snowflakeSeconds('')).toBeUndefined();
    expect(snowflakeSeconds('abc')).toBeUndefined();
  });
});

describe('parseEngagementLabel', () => {
  it('reads every count from the label on the row of buttons', () => {
    expect(parseEngagementLabel('1728 replies, 6502 reposts, 53414 likes, 10818 bookmarks, 53893379 views'))
      .toEqual({ replies: 1728, reposts: 6502, likes: 53414, bookmarks: 10818, views: 53893379 });
  });

  it('reads singular forms and leaves out what the label leaves out', () => {
    expect(parseEngagementLabel('1 reply, 10 reposts, 296 likes, 78 bookmarks, 464526 views'))
      .toEqual({ replies: 1, reposts: 10, likes: 296, bookmarks: 78, views: 464526 });
    expect(parseEngagementLabel('4 replies, 3 likes, 324 views')).toEqual({ replies: 4, likes: 3, views: 324 });
    expect(parseEngagementLabel('1 like, 1 view')).toEqual({ likes: 1, views: 1 });
  });

  it('copes with thousands separators and with no label at all', () => {
    expect(parseEngagementLabel('1,728 replies')).toEqual({ replies: 1728 });
    expect(parseEngagementLabel(null)).toEqual({});
    expect(parseEngagementLabel('Seek slider')).toEqual({});
  });
});

describe('post selectors', () => {
  it('cover both the old layout and the rebuilt one', () => {
    expect(CELL_SELECTOR).toContain('[data-testid="cellInnerDiv"]');
    expect(CELL_SELECTOR).toContain('div[role="link"][data-href*="/status/"]');
    expect(TWEET_SELECTOR).toContain('article[data-testid="tweet"]');
    expect(TWEET_CELL_SELECTORS).toHaveLength(2);
  });

  it('never treat a quoted post as a post of its own', () => {
    expect(CELL_SELECTOR).toContain(':not(article *)');
  });
});
