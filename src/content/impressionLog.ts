import type { EngagementScore, PostImpression } from '../shared/types';
import { impressionScoreFields } from '../shared/impression-fields';
import { AttentionTracker } from './attention';

// Recording what was shown, the same way on every site.
//
// A post is logged once per page load. The sites move between pages without
// reloading, and each content script forgets which posts it has handled when that
// happens, so going to a post and back used to log the whole restored feed again.
// What is remembered here outlives that. A full reload, or a new tab, starts again:
// a post the site serves a second time then is a real repeat and is logged as one.

const logged = new Set<string>();
let shownSoFar = 0;
let tracker: AttentionTracker | null = null;

function send(message: object): void {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    // The extension was reloaded under this page
  }
}

// True the first time it is asked about a post, false after
export function firstSighting(postId: string): boolean {
  if (!postId || logged.has(postId)) return false;
  logged.add(postId);
  return true;
}

// Time each post spends on screen, and how the page is scrolled. One per page.
export function attention(): AttentionTracker {
  if (!tracker) {
    tracker = new AttentionTracker((dwellUpdates, scrollBuckets) => {
      send({ type: 'LOG_ATTENTION', dwellUpdates, scrollBuckets });
    });
  }
  return tracker;
}

export interface ShownPost {
  id: string;
  element: HTMLElement | null | undefined;
  source: string;            // Account, channel or page it came from
  score: EngagementScore;
  blurThreshold: number;     // Threshold in force when it was shown
  blurred: boolean;          // What was decided
}

// For sites with no reordering (Instagram, Facebook): log posts that have just been
// scored and start timing them. Posts already logged on this page are still timed,
// since their element may have been rebuilt.
export function logShown(platform: NonNullable<PostImpression['platform']>, posts: ShownPost[]): void {
  const impressions: PostImpression[] = [];
  for (const post of posts) {
    if (post.element) attention().track(post.id, post.element);
    if (!firstSighting(post.id)) continue;
    const position = shownSoFar++;
    impressions.push({
      timestamp: Date.now(),
      postId: post.id,
      ...impressionScoreFields(post.score),
      platform,
      blurThreshold: post.blurThreshold,
      blurred: post.blurred,
      position,
      originalPosition: position,
      subreddit: post.source,
      wasReordered: false,
    });
  }
  if (impressions.length > 0) send({ type: 'LOG_IMPRESSIONS', impressions });
}
