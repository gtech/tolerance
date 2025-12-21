import { log } from '../../shared/constants';

// Observe DOM changes for infinite scroll detection on Instagram
// Using interval-based polling instead of MutationObserver to avoid performance issues

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let lastArticleCount = 0;

const POLL_INTERVAL_MS = 500; // Check every 500ms for more responsive scrolling

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

  // Track initial article count
  lastArticleCount = document.querySelectorAll('article').length;

  pollIntervalId = setInterval(() => {
    // Stop polling if not on valid page
    if (!isValidFeedPage()) {
      log.debug('Instagram: Poll detected invalid page, stopping');
      disconnectObserver();
      return;
    }

    // Check if article count changed
    const currentCount = document.querySelectorAll('article').length;
    if (currentCount !== lastArticleCount) {
      lastArticleCount = currentCount;
      callback();
    }
  }, POLL_INTERVAL_MS);

  log.debug('Instagram: Polling started, initial article count:', lastArticleCount);
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
  log.debug('Instagram: Observer disconnected');
}
