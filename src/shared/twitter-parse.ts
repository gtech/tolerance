// Reading the text Twitter puts on a post. No DOM here, so it can be tested directly.

// A post's ID holds the moment it was made: the bits above the lowest 22 are
// milliseconds since Twitter's own epoch (4 November 2010). The redesigned site
// (November 2026) shows only "9h" beside a post and no machine-readable time, so this
// is where the time comes from. IDs from before that scheme are short and say nothing.
const TWITTER_EPOCH_MS = 1288834974657;
export function snowflakeSeconds(id: string): number | undefined {
  if (!/^\d{15,20}$/.test(id)) return undefined;
  // A double loses the lowest few bits of a 19-digit ID; those are far below the
  // 22 bits thrown away here
  const ms = Math.floor(Number(id) / 4194304) + TWITTER_EPOCH_MS;
  return Math.floor(ms / 1000);
}

export interface EngagementCounts {
  replies?: number;
  reposts?: number;
  likes?: number;
  bookmarks?: number;
  views?: number;
}

// The accessibility label on a post's row of buttons spells the counts out in full:
// "39 replies, 64 reposts, 869 likes, 265 bookmarks, 38582 views". A count of zero is
// left out of the label altogether.
export function parseEngagementLabel(label: string | null | undefined): EngagementCounts {
  const counts: EngagementCounts = {};
  if (!label) return counts;
  const keys: Record<string, keyof EngagementCounts> = {
    repl: 'replies', repo: 'reposts', like: 'likes', book: 'bookmarks', view: 'views',
  };
  const pattern = /(\d[\d.,\s]*?)\s+(repl(?:y|ies)|reposts?|likes?|bookmarks?|views?)\b/g;
  for (const m of label.toLowerCase().matchAll(pattern)) {
    const n = parseInt(m[1].replace(/[^\d]/g, ''), 10);
    if (!Number.isNaN(n)) counts[keys[m[2].slice(0, 4)]] = n;
  }
  return counts;
}
