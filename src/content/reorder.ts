import { RedditPost, EngagementScore, PostImpression } from '../shared/types';
import { log } from '../shared/constants';

// Reorder posts in the DOM according to scheduled order
// This is the core intervention - transforms variable reward into fixed interval

export function reorderPosts(
  posts: RedditPost[],
  scores: Map<string, EngagementScore>,
  newOrder: string[],
  hiddenIds: string[] = []
): PostImpression[] {
  const postMap = new Map(posts.map(p => [p.id, p]));
  const impressions: PostImpression[] = [];

  // Get the parent container
  const container = document.querySelector('#siteTable');
  if (!container) {
    console.error('Tolerance: Could not find siteTable container');
    return impressions;
  }

  // Debug: Log original DOM order with scores
  const originalDomOrder = Array.from(container.querySelectorAll('.thing.link:not(.promoted)'))
    .map(el => {
      const id = el.getAttribute('data-fullname')?.replace('t3_', '') || '?';
      const s = scores.get(id);
      return `${id.slice(0,6)}(${s?.apiScore ?? s?.heuristicScore ?? '?'})`;
    })
    .slice(0, 15);
  log.debug(`Reorder: Original DOM (${container.querySelectorAll('.thing.link:not(.promoted)').length} posts): ${originalDomOrder.join(', ')}`);

  const newOrderWithScores = newOrder.slice(0, 15).map(id => {
    const s = scores.get(id);
    return `${id.slice(0,6)}(${s?.apiScore ?? s?.heuristicScore ?? '?'})`;
  });
  log.debug(`Reorder: Requested order (${newOrder.length} posts): ${newOrderWithScores.join(', ')}`);

  // Record original positions
  const originalPositions = new Map<string, number>();
  posts.forEach((post, index) => {
    originalPositions.set(post.id, index);
  });

  // Create document fragment for efficient reordering
  const fragment = document.createDocumentFragment();

  // Collect non-post elements (ads, promoted, etc) to preserve
  const nonPostElements: HTMLElement[] = [];
  const allChildren = Array.from(container.children) as HTMLElement[];

  for (const child of allChildren) {
    if (
      !child.classList.contains('thing') ||
      !child.classList.contains('link') ||
      child.classList.contains('promoted')
    ) {
      nonPostElements.push(child);
    }
  }

  // Reorder posts according to new order
  let position = 0;
  let appendedCount = 0;
  for (const postId of newOrder) {
    const post = postMap.get(postId);
    if (!post) {
      log.debug(`Reorder: Post ${postId} not found in postMap`);
      continue;
    }
    if (!post.element) {
      log.debug(`Reorder: Post ${postId} has no element`);
      continue;
    }

    const score = scores.get(postId);
    const originalPos = originalPositions.get(postId) ?? position;
    const wasReordered = originalPos !== position;

    // Create impression record
    impressions.push({
      timestamp: Date.now(),
      postId,
      score: score?.heuristicScore ?? 50,
      bucket: score?.bucket ?? 'medium',
      position,
      originalPosition: originalPos,
      subreddit: post.subreddit,
      wasReordered,
      narrativeThemeId: score?.factors?.narrative?.themeId,
    });

    fragment.appendChild(post.element);
    appendedCount++;
    position++;
  }

  log.debug(`Reorder: Appended ${appendedCount} posts to fragment, ${nonPostElements.length} non-post elements`);

  // Re-append non-post elements at their relative positions
  // (simplified: just append at end - ads don't need precise positioning)
  for (const el of nonPostElements) {
    fragment.appendChild(el);
  }

  // Clear and repopulate container
  // This is faster than individual insertions
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  container.appendChild(fragment);

  // Hidden posts are simply not included in newOrder, so they're removed from DOM
  // Log how many were hidden
  if (hiddenIds.length > 0) {
    log.debug(`Reorder: ${hiddenIds.length} high-engagement posts hidden (not in feed)`);
  }

  // Debug: Verify final DOM order with scores
  const finalDomOrder = Array.from(container.querySelectorAll('.thing.link:not(.promoted)'))
    .map(el => {
      const id = el.getAttribute('data-fullname')?.replace('t3_', '') || '?';
      const s = scores.get(id);
      return `${id.slice(0,6)}(${s?.apiScore ?? s?.heuristicScore ?? '?'})`;
    })
    .slice(0, 15);
  log.debug(`Reorder: Final DOM (${container.querySelectorAll('.thing.link:not(.promoted)').length} visible posts): ${finalDomOrder.join(', ')}`);

  return impressions;
}

// For baseline mode: just record impressions without reordering
export function recordImpressions(
  posts: RedditPost[],
  scores: Map<string, EngagementScore>
): PostImpression[] {
  return posts.map((post, index) => {
    const score = scores.get(post.id);
    return {
      timestamp: Date.now(),
      postId: post.id,
      score: score?.heuristicScore ?? 50,
      bucket: score?.bucket ?? 'medium',
      position: index,
      originalPosition: index,
      subreddit: post.subreddit,
      wasReordered: false,
      narrativeThemeId: score?.factors?.narrative?.themeId,
    };
  });
}

// Hide a specific post (for future use - complete filtering)
export function hidePost(postId: string, posts: RedditPost[]): void {
  const post = posts.find(p => p.id === postId);
  if (post?.element) {
    post.element.style.display = 'none';
  }
}

// Show a previously hidden post
export function showPost(postId: string, posts: RedditPost[]): void {
  const post = posts.find(p => p.id === postId);
  if (post?.element) {
    post.element.style.display = '';
  }
}
