// Where scoring is allowed to come from. People's private messages must never reach
// the scoring model (the extension once sent Facebook DMs), and each site's scraper
// has its own way of staying out of them. This is the backstop behind all of them:
// the background refuses a scoring request unless it comes from the right site and
// from a page that isn't a messaging surface.

export type ScorePlatformKey = 'reddit' | 'twitter' | 'youtube' | 'instagram' | 'facebook';

export const SCORE_MESSAGE_PLATFORM: Record<string, ScorePlatformKey> = {
  SCORE_POSTS: 'reddit',
  SCORE_TWEETS: 'twitter',
  SCORE_VIDEOS: 'youtube',
  SCORE_INSTAGRAM_POSTS: 'instagram',
  SCORE_FACEBOOK_POSTS: 'facebook',
};

// Same hosts as the content script matches in the manifest
const HOSTS: Record<ScorePlatformKey, string[]> = {
  reddit: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
  twitter: ['twitter.com', 'x.com'],
  youtube: ['www.youtube.com'],
  instagram: ['www.instagram.com'],
  facebook: ['www.facebook.com'],
};

// Inboxes and conversations. A path matches if it is one of these or sits under one.
const MESSAGING_PATHS: Record<ScorePlatformKey, string[]> = {
  reddit: ['/message', '/chat'],       // old Reddit inbox; chat
  twitter: ['/messages', '/i/chat'],   // DMs; the newer chat
  youtube: [],
  instagram: ['/direct'],
  facebook: ['/messages'],
};

export function isMessagingPath(platform: ScorePlatformKey, pathname: string): boolean {
  const path = pathname.toLowerCase();
  return MESSAGING_PATHS[platform].some(p => path === p || path.startsWith(`${p}/`));
}

// True if a page at this URL may have its posts scored for this platform
export function isScorableUrl(platform: ScorePlatformKey, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!HOSTS[platform].includes(parsed.hostname)) return false;
  return !isMessagingPath(platform, parsed.pathname);
}

// Whether the background should act on a scoring message, given where it came from:
// the sender's frame URL and its tab's URL (they differ only if one is stale after an
// in-page navigation). Every URL we have must be scorable, and we need at least one.
export function canScoreFrom(messageType: string, senderUrls: (string | undefined)[]): boolean {
  const platform = SCORE_MESSAGE_PLATFORM[messageType];
  if (!platform) return false;
  const urls = senderUrls.filter((u): u is string => !!u);
  return urls.length > 0 && urls.every(u => isScorableUrl(platform, u));
}
