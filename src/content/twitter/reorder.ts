import { Tweet, EngagementScore, PostImpression } from '../../shared/types';
import { log } from '../../shared/constants';

// Reorder tweets by recalculating translateY based on actual heights
// Twitter uses absolute positioning + translateY for virtual scrolling
// We must recalculate Y positions based on cumulative heights in new order

export function reorderTweets(
  tweets: Tweet[],
  scores: Map<string, EngagementScore>,
  newOrder: string[]
): PostImpression[] {
  const tweetMap = new Map(tweets.map(t => [t.id, t]));
  const impressions: PostImpression[] = [];

  // Record original positions
  const originalPositions = new Map<string, number>();
  tweets.forEach((tweet, index) => {
    originalPositions.set(tweet.id, index);
  });

  // Get parent elements (cellInnerDiv) for each tweet, their heights, and current transforms
  const tweetCells = new Map<string, HTMLElement>();
  const tweetHeights = new Map<string, number>();
  const originalTransforms = new Map<string, number>(); // Just the Y value

  for (const tweet of tweets) {
    const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
    if (cell) {
      tweetCells.set(tweet.id, cell);

      // Get actual height
      const height = cell.getBoundingClientRect().height;
      tweetHeights.set(tweet.id, height);

      // Parse current translateY value
      const transform = cell.style.transform || '';
      const match = transform.match(/translateY\(([-\d.]+)px\)/);
      const yValue = match ? parseFloat(match[1]) : 0;
      originalTransforms.set(tweet.id, yValue);
    }
  }

  // Find the starting Y position (minimum Y of all tweets)
  let startY = Infinity;
  for (const y of originalTransforms.values()) {
    if (y < startY) startY = y;
  }
  if (startY === Infinity) startY = 0;

  // Calculate new transforms based on cumulative heights in new order
  let currentY = startY;
  let position = 0;
  let reorderedCount = 0;

  for (const tweetId of newOrder) {
    const tweet = tweetMap.get(tweetId);
    if (!tweet) continue;

    const cell = tweetCells.get(tweetId);
    if (!cell) continue;

    const height = tweetHeights.get(tweetId) || 0;
    const score = scores.get(tweetId);
    const originalPos = originalPositions.get(tweetId) ?? position;
    const wasReordered = originalPos !== position;
    const oldY = originalTransforms.get(tweetId) || 0;

    // Apply new transform
    const newTransform = `translateY(${currentY}px)`;

    if (Math.abs(currentY - oldY) > 1) { // Allow 1px tolerance
      cell.style.transform = newTransform;
      if (wasReordered) {
        reorderedCount++;
        log.debug(` Tweet ${tweetId.slice(0, 8)}... pos ${originalPos}→${position}, Y: ${oldY.toFixed(0)}→${currentY.toFixed(0)}, height: ${height.toFixed(0)}`);
      }
    }

    // Create impression record
    impressions.push({
      timestamp: Date.now(),
      postId: tweetId,
      score: score?.apiScore ?? 50,
      bucket: score?.bucket ?? 'medium',
      position,
      originalPosition: originalPos,
      subreddit: `@${tweet.author}`,
      wasReordered,
      narrativeThemeId: score?.factors?.narrative?.themeId,
    });

    // Move Y down by this tweet's height for next tweet
    currentY += height;
    position++;
  }

  if (reorderedCount > 0) {
    log.debug(` Repositioned ${reorderedCount} tweets with height-aware transforms`);
  }

  return impressions;
}

// For baseline mode: just record impressions without reordering
export function recordImpressions(
  tweets: Tweet[],
  scores: Map<string, EngagementScore>
): PostImpression[] {
  return tweets.map((tweet, index) => {
    const score = scores.get(tweet.id);
    return {
      timestamp: Date.now(),
      postId: tweet.id,
      score: score?.apiScore ?? 50,
      bucket: score?.bucket ?? 'medium',
      position: index,
      originalPosition: index,
      subreddit: `@${tweet.author}`,
      wasReordered: false,
      narrativeThemeId: score?.factors?.narrative?.themeId,
    };
  });
}

// Hide a specific tweet using CSS
export function hideTweet(tweetId: string, tweets: Tweet[]): void {
  const tweet = tweets.find(t => t.id === tweetId);
  if (tweet?.element) {
    const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
    if (cell) {
      cell.style.opacity = '0';
      cell.style.pointerEvents = 'none';
    }
  }
}

// Show a previously hidden tweet
export function showTweet(tweetId: string, tweets: Tweet[]): void {
  const tweet = tweets.find(t => t.id === tweetId);
  if (tweet?.element) {
    const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
    if (cell) {
      cell.style.opacity = '';
      cell.style.pointerEvents = '';
    }
  }
}
