import { log } from '../../shared/constants';

// Observe DOM changes for infinite scroll detection on Facebook
// Using interval-based polling (like Instagram) — MutationObserver is too noisy on React SPAs

let pollIntervalId: ReturnType<typeof setInterval> | null = null;
let lastSeenArticles = new Set<string>();

const POLL_INTERVAL_MS = 500; // Check every 500ms

// Get a unique identifier for an article element
function getArticleId(article: Element): string | null {
  // Look for permalink links with IDs
  const linkPatterns = [
    'a[href*="fbid="]',
    'a[href*="/posts/"]',
    'a[href*="story_fbid"]',
    'a[href*="/permalink/"]',
  ];

  for (const pattern of linkPatterns) {
    const link = article.querySelector<HTMLAnchorElement>(pattern);
    if (link) {
      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/(?:fbid|story_fbid)=(\d+)/) ||
                      href.match(/\/posts\/([a-zA-Z0-9_]+)/) ||
                      href.match(/\/permalink\/(\d+)/);
      if (idMatch) return idMatch[1];
    }
  }

  // Fallback: position + first few chars of text content
  const text = article.textContent?.slice(0, 100) || '';
  const rect = article.getBoundingClientRect();
  return `pos-${Math.round(rect.top)}-${text.length}`;
}

export function setupFacebookObserver(callback: () => void): void {
  if (pollIntervalId) {
    log.debug('Facebook: Observer already set up');
    return;
  }

  if (!isValidFeedPage()) {
    log.debug('Facebook: Not on valid feed page, skipping observer setup');
    return;
  }

  log.debug('Facebook: Setting up polling observer');

  // Track initial articles
  const initialArticles = document.querySelectorAll('div[role="article"]');
  lastSeenArticles.clear();
  for (const article of initialArticles) {
    const id = getArticleId(article);
    if (id) lastSeenArticles.add(id);
  }

  pollIntervalId = setInterval(() => {
    if (!isValidFeedPage()) {
      log.debug('Facebook: Poll detected invalid page, stopping');
      disconnectObserver();
      return;
    }

    const currentArticles = document.querySelectorAll('div[role="article"]');
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
      log.debug('Facebook: New articles detected via polling');
      callback();
    }
  }, POLL_INTERVAL_MS);

  log.debug('Facebook: Polling started, tracking', lastSeenArticles.size, 'initial articles');
}

export function setupNavigationObserver(callback: () => void): void {
  // Facebook is a SPA — detect navigation via pushState/replaceState/popstate
  let lastPathname = window.location.pathname;

  window.addEventListener('popstate', () => {
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Facebook: Navigation detected via popstate');
      handleNavigation(callback);
    }
  });

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Facebook: Navigation detected via pushState');
      handleNavigation(callback);
    }
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug('Facebook: Navigation detected via replaceState');
      handleNavigation(callback);
    }
  };
}

function handleNavigation(callback: () => void): void {
  disconnectObserver();
  lastSeenArticles.clear();
  log.debug('Facebook: Observer disconnected for navigation');

  if (isValidFeedPage()) {
    // Wait for new content to load
    setTimeout(() => {
      setupFacebookObserver(callback);
      callback();
    }, 500);
  } else {
    log.debug('Facebook: Not a valid feed page, staying disconnected');
  }
}

export function isValidFeedPage(): boolean {
  const pathname = window.location.pathname;

  // Invalid pages — skip these
  if (pathname.startsWith('/messages')) return false;
  if (pathname.startsWith('/marketplace')) return false;
  if (pathname.startsWith('/watch')) return false;
  if (pathname.startsWith('/notifications')) return false;
  if (pathname.startsWith('/settings')) return false;
  if (pathname.startsWith('/events')) return false;
  if (pathname.startsWith('/pages')) return false;
  if (pathname.startsWith('/gaming')) return false;
  if (pathname.startsWith('/fundraisers')) return false;
  if (pathname.startsWith('/saved')) return false;
  if (pathname.startsWith('/friends')) return false;
  if (pathname.startsWith('/photo')) return false;
  if (pathname.startsWith('/reel')) return false;
  if (pathname.startsWith('/stories')) return false;

  // Valid: Home feed
  if (pathname === '/' || pathname === '') return true;

  // Valid: Group feeds
  if (pathname.match(/^\/groups\/[^/]+\/?$/)) return true;

  return false;
}

export function disconnectObserver(): void {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  lastSeenArticles.clear();
  log.debug('Facebook: Observer disconnected');
}
