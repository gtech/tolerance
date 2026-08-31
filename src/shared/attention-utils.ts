// Pure merge helpers for attention data (dwell + scroll).
// Kept free of chrome/DOM dependencies so they are unit-testable.

import type { PostImpression, DwellUpdate, ScrollBucket } from './types';

// Merge dwell deltas into session impressions in place.
// A post can be impressed more than once in a session (Twitter recreates DOM
// nodes); deltas are merged into the most recent impression for that postId.
// Returns the number of updates that found a matching impression.
export function mergeDwellIntoImpressions(
  posts: PostImpression[],
  updates: DwellUpdate[]
): number {
  const latestById = new Map<string, PostImpression>();
  for (const post of posts) {
    latestById.set(post.postId, post);
  }

  let matched = 0;
  for (const update of updates) {
    const imp = latestById.get(update.postId);
    if (!imp) continue;
    imp.dwellMs = (imp.dwellMs ?? 0) + update.dwellMs;
    imp.viewportEnters = (imp.viewportEnters ?? 0) + update.enters;
    imp.maxContinuousDwellMs = Math.max(imp.maxContinuousDwellMs ?? 0, update.maxContinuousMs);
    matched++;
  }
  return matched;
}

// Merge incoming per-minute scroll buckets into an existing list.
// Buckets for the same minute are combined; result stays sorted by minute.
export function mergeScrollBuckets(
  existing: ScrollBucket[],
  incoming: ScrollBucket[]
): ScrollBucket[] {
  const byMinute = new Map<number, ScrollBucket>();
  for (const bucket of existing) {
    byMinute.set(bucket.minute, { ...bucket });
  }
  for (const bucket of incoming) {
    const current = byMinute.get(bucket.minute);
    if (current) {
      current.scrolledPx += bucket.scrolledPx;
      current.maxVelocityPxS = Math.max(current.maxVelocityPxS, bucket.maxVelocityPxS);
      current.scrollActiveMs += bucket.scrollActiveMs;
    } else {
      byMinute.set(bucket.minute, { ...bucket });
    }
  }
  return [...byMinute.values()].sort((a, b) => a.minute - b.minute);
}
