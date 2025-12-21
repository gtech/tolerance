import { log } from '../../shared/constants';

// Observe DOM changes for infinite scroll detection on Instagram
// Using interval-based polling instead of MutationObserver to avoid performance issues

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let lastSeenArticles = new Set<string>();

const POLL_INTERVAL_MS = 500; // Check every 500ms for more responsive scrolling

// Get a unique identifier for an article element
function getArticleId(article: Element): string | null {
  // Try __igdl_id attribute first
  const igdlId = article.getAttribute('__igdl_id');
  if (igdlId) return igdlId;

  // Try to find shortcode from permalink
  const link = article.querySelector<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]');
  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (match) return match[2];
  }

  // Fallback: use a hash of the article's position and content
  const rect = article.getBoundingClientRect();
  const author = article.querySelector('a[href^="/"]')?.getAttribute('href') || '';
  return `pos-${Math.round(rect.top)}-${author}`;
}

export function setupInstagramObserver(callback: () => void): void {
  if (pollIntervalId) {
    log.debug('Instagram: Observer already set up');
    return;
  }

  // Don't setup if not on valid page
  if (!isValidFeedPage()) {
    log.debug('Instagram: Not on valid feed page, skipping observer setup');
    return;
  }

  log.debug('Instagram: Setting up polling observer');

  // Track initial articles by ID (not just count)
  const initialArticles = document.querySelectorAll('article');
  lastSeenArticles.clear();
  for (const article of initialArticles) {
    const id = getArticleId(article);
    if (id) lastSeenArticles.add(id);
  }

  pollIntervalId = setInterval(() => {
    // Stop polling if not on valid page
    if (!isValidFeedPage()) {
      log.debug('Instagram: Poll detected invalid page, stopping');
      disconnectObserver();
      return;
    }

    // Check for new articles by ID, not just count
    // Instagram virtualizes DOM - count stays same but articles swap out
    const currentArticles = document.querySelectorAll('article');
    let hasNewArticles = false;

    for (const article of currentArticles) {
      const id = getArticleId(article);
      if (id && !lastSeenArticles.has(id)) {
        hasNewArticles = true;
        lastSeenArticles.add(id);
      }
    }

    // Limit set size to prevent memory growth
    if (lastSeenArticles.size > 200) {
      const arr = Array.from(lastSeenArticles);
      lastSeenArticles = new Set(arr.slice(-100));
    }

    if (hasNewArticles) {
      log.debug('Instagram: New articles detected via ID tracking');
      callback();
    }
  }, POLL_INTERVAL_MS);

  log.debug('Instagram: Polling started, tracking', lastSeenArticles.size, 'initial articles');
}

export function setupNavigationObserver(callback: () => void): void {
  // Instagram is a SPA, so we need to detect navigation changes
  // This handles when user navigates between feed, explore, profile, etc.

  let lastPathname = window.location.pathname;

  // Use popstate for browser back/forward
  window.addEventListener('popstate', () => {
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Instagram: Navigation detected via popstate');
      handleNavigation(callback);
    }
  });

  // Also observe for history pushState/replaceState (Instagram uses these)
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Instagram: Navigation detected via pushState');
      handleNavigation(callback);
    }
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Instagram: Navigation detected via replaceState');
      handleNavigation(callback);
    }
  };
}

function handleNavigation(callback: () => void): void {
  // Always disconnect observer first when navigating
  disconnectObserver();
  lastSeenArticles.clear(); // Clear tracking on navigation
  log.debug('Instagram: Observer disconnected for navigation');

  // Only process on feed pages
  if (isValidFeedPage()) {
    // Wait for new content to load
    setTimeout(() => {
      setupInstagramObserver(callback);
      callback();
    }, 500);
  } else {
    log.debug('Instagram: Not a valid feed page, staying disconnected');
  }
}

export function isValidFeedPage(): boolean {
  const pathname = window.location.pathname;

  // Skip explore, reels page, stories, direct messages FIRST
  if (pathname.startsWith('/explore')) return false;
  if (pathname.startsWith('/reels')) return false;
  if (pathname.startsWith('/reel/')) return false;  // Individual reel pages
  if (pathname.startsWith('/stories')) return false;
  if (pathname.startsWith('/direct')) return false;
  if (pathname.startsWith('/accounts')) return false;
  if (pathname.startsWith('/p/')) return false;  // Individual post pages

  // Feed pages: home feed only
  // Home feed is at /
  if (pathname === '/') {
    return true;
  }

  // Profile pages with feed - but NOT reserved paths
  if (pathname.match(/^\/[a-zA-Z0-9._]+\/?$/)) {
    // Double-check this isn't a reserved path that slipped through
    const reservedPaths = ['reels', 'explore', 'stories', 'direct', 'accounts', 'reel', 'p'];
    const pathSegment = pathname.split('/')[1];
    if (reservedPaths.includes(pathSegment)) {
      log.debug('Instagram: isValidFeedPage = false (reserved path):', pathname);
      return false;
    }
    return true;
  }

  log.debug('Instagram: isValidFeedPage = false:', pathname);
  return false;
}

export function disconnectObserver(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  lastSeenArticles.clear();
  log.debug('Instagram: Observer disconnected');
}
