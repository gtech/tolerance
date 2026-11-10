// Scraper health: noticing when a site changes its markup and a scraper quietly stops
// reading something.
//
// Nothing breaks visibly when that happens. In November 2026 YouTube renamed its card
// classes and the scraper stopped reading every video's length and view count, and every
// sidebar video's channel; it was found only by inspecting an export by hand. Sites will
// keep changing, by accident or on purpose, so the extension keeps count instead: for
// each post a scraper returns, which of the things it should have found did it find?
//
// Each day's counts are compared with a floor and with the days before. The result is a
// list of alerts in a fixed shape (site, field, rate, usual rate, sample size) meant to
// be read by a person today and by an automated fixer later.
//
// Pure functions only: the content scripts feed it posts, the background stores the
// counts and runs the daily check.

export type HealthPlatform = 'reddit' | 'twitter' | 'youtube' | 'instagram' | 'facebook';

export interface FieldTally { seen: number; found: number }
export interface PlatformDay {
  loads: number;   // feed pages opened
  posts: number;   // posts the scraper returned
  fields: Record<string, FieldTally>;
}
export type HealthDay = Partial<Record<HealthPlatform, PlatformDay>>;
export type HealthHistory = Record<string, HealthDay>;   // keyed by day, YYYY-MM-DD

export interface HealthAlert {
  platform: HealthPlatform;
  field: string | null;                 // null: the scraper found no posts at all
  kind: 'no-posts' | 'low' | 'drop';
  rate?: number;                        // share of posts where the field was found that day
  usual?: number;                       // the same share over the days before
  seen?: number;                        // posts the rate is based on
  message: string;
}

// How often each field should be found. A field under its floor raises a "low" alert; a
// floor of 0 means the field is only watched for a drop against its own history, because
// its normal level varies (Facebook posts often have no stable id, thumbnails load late).
const FLOORS: Record<HealthPlatform, Record<string, number>> = {
  reddit: { title: 0.8, subreddit: 0.8, link: 0.8 },
  twitter: { author: 0.8, content: 0.8 },
  youtube: { title: 0.8, channel: 0.8, length: 0.5, views: 0.5, thumbnail: 0 },
  instagram: { author: 0.8, content: 0.5, stableId: 0 },
  facebook: { author: 0.8, content: 0.5, stableId: 0 },
};

const MIN_POSTS = 20;        // fewer than this and a rate says nothing
const MIN_BASELINE = 40;     // posts needed across earlier days to call something "usual"
const DROP = 0.3;            // a fall of this much against the usual rate is an alert
const BASELINE_DAYS = 7;
export const HEALTH_KEEP_DAYS = 21;

const has = (v: unknown): boolean => typeof v === 'string' ? v.trim().length > 0 : v !== undefined && v !== null;
const SPONSORED = '[Sponsored] ';

// For one scraped post: was each expected field found? null means it doesn't apply to
// this post (a Short has no length, an ad has no view count).
export function checkPost(platform: HealthPlatform, post: Record<string, unknown>): Record<string, boolean | null> {
  switch (platform) {
    case 'reddit':
      return { title: has(post.title), subreddit: has(post.subreddit), link: has(post.permalink) };
    case 'twitter':
      return { author: has(post.author), content: has(post.text) || (has(post.mediaType) && post.mediaType !== 'text') };
    case 'youtube': {
      const isAd = String(post.title ?? '').includes(SPONSORED);
      const short = post.isShort === true, live = post.isLive === true;
      return {
        title: has(String(post.title ?? '').replace(/^(\[[^\]]+\] )+/, '')),
        channel: short ? null : has(post.channel),            // a Short in a shelf names no channel
        length: short || live || isAd ? null : /^\d+(:\d{2})+$/.test(String(post.duration ?? '')),
        views: short || live || isAd ? null : typeof post.viewCount === 'number' && post.viewCount > 0,
        thumbnail: has(post.thumbnailUrl),
      };
    }
    case 'instagram':
      return {
        author: has(post.authorUsername),
        content: has(post.caption) || has(post.imageUrl) || has(post.thumbnailUrl),
        stableId: has(post.id) && !/^\d+$/.test(String(post.id)),   // a shortcode, not the fallback id
      };
    case 'facebook':
      return {
        author: has(post.authorDisplayName),
        content: has(post.caption) || has(post.imageUrl) || has(post.thumbnailUrl),
        stableId: has(post.id) && !String(post.id).startsWith('fb_hash_'),
      };
  }
}

export function tallyPosts(platform: HealthPlatform, posts: Record<string, unknown>[]): { posts: number; fields: Record<string, FieldTally> } {
  const fields: Record<string, FieldTally> = {};
  for (const post of posts) {
    for (const [field, found] of Object.entries(checkPost(platform, post))) {
      if (found === null) continue;
      const t = fields[field] ?? (fields[field] = { seen: 0, found: 0 });
      t.seen++;
      if (found) t.found++;
    }
  }
  return { posts: posts.length, fields };
}

// Add counts to a day, returning a new history trimmed to the latest HEALTH_KEEP_DAYS days
export function addToDay(
  history: HealthHistory,
  day: string,
  platform: HealthPlatform,
  delta: { loads?: number; posts?: number; fields?: Record<string, FieldTally> }
): HealthHistory {
  const before = history[day]?.[platform] ?? { loads: 0, posts: 0, fields: {} };
  const fields: Record<string, FieldTally> = { ...before.fields };
  for (const [name, t] of Object.entries(delta.fields ?? {})) {
    const b = fields[name] ?? { seen: 0, found: 0 };
    fields[name] = { seen: b.seen + t.seen, found: b.found + t.found };
  }
  const updated: HealthHistory = {
    ...history,
    [day]: { ...history[day], [platform]: { loads: before.loads + (delta.loads ?? 0), posts: before.posts + (delta.posts ?? 0), fields } },
  };
  const keep = Object.keys(updated).sort().slice(-HEALTH_KEEP_DAYS);
  return Object.fromEntries(keep.map(d => [d, updated[d]]));
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const SITE: Record<HealthPlatform, string> = { reddit: 'Reddit', twitter: 'X', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' };

// What looks broken on one day, given the days before it
export function evaluateDay(history: HealthHistory, day: string): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  const earlier = Object.keys(history).filter(d => d < day).sort().slice(-BASELINE_DAYS);

  for (const platform of Object.keys(FLOORS) as HealthPlatform[]) {
    const today = history[day]?.[platform];
    if (!today) continue;

    if (today.posts === 0) {
      // Three feed pages with nothing found is not a quiet day; the card selector has gone
      if (today.loads >= 3) {
        alerts.push({ platform, field: null, kind: 'no-posts', seen: today.loads,
          message: `${SITE[platform]}: no posts found on ${today.loads} feed pages. The scraper no longer recognises posts there.` });
      }
      continue;
    }

    for (const [field, floor] of Object.entries(FLOORS[platform])) {
      const t = today.fields[field];
      if (!t || t.seen < MIN_POSTS) continue;
      const rate = t.found / t.seen;

      let seenBefore = 0, foundBefore = 0;
      for (const d of earlier) {
        const b = history[d]?.[platform]?.fields[field];
        if (b) { seenBefore += b.seen; foundBefore += b.found; }
      }
      const usual = seenBefore >= MIN_BASELINE ? foundBefore / seenBefore : undefined;

      if (usual !== undefined && rate < usual - DROP) {
        alerts.push({ platform, field, kind: 'drop', rate, usual, seen: t.seen,
          message: `${SITE[platform]}: ${field} found on ${pct(rate)} of ${t.seen} posts, down from ${pct(usual)}.` });
      } else if (rate < floor) {
        alerts.push({ platform, field, kind: 'low', rate, usual, seen: t.seen,
          message: `${SITE[platform]}: ${field} found on only ${pct(rate)} of ${t.seen} posts.` });
      }
    }
  }
  return alerts;
}

// The report kept after each daily check
export interface HealthReport {
  day: string;          // the day that was checked
  checkedAt: number;
  alerts: HealthAlert[];
  seen: boolean;        // whether the alerts have been looked at in the dashboard
}

// The latest day that has counts and is over (so a half-finished today isn't judged)
export function lastFinishedDay(history: HealthHistory, today: string): string | undefined {
  return Object.keys(history).filter(d => d < today).sort().pop();
}
