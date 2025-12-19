import { log } from '../../shared/constants';

// Observe DOM changes for infinite scroll detection on Instagram
// Instagram uses virtualized/lazy loading for feed content

let observer: MutationObserver | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastArticleCount = 0;

const DEBOUNCE_MS = 500; // Debounce processing to batch multiple DOM changes

export function setupInstagramObserver(callback: () => void): void {
  if (observer) {
    log.debug(' Instagram: Observer already set up');
    return;
  }

  // Find the main content container
  const mainContainer = findMainContainer();
  if (!mainContainer) {
    log.warn(' Instagram: Could not find main container, will retry');
    // Retry after a short delay (Instagram may still be loading)
    setTimeout(() => setupInstagramObserver(callback), 1000);
    return;
  }

  log.debug(' Instagram: Setting up observer on main container');

  observer = new MutationObserver((mutations) => {
    // Check if any articles were added
    let hasNewArticles = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if an article was added or contains articles
            if (node.tagName === 'ARTICLE' || node.querySelector('article')) {
              hasNewArticles = true;
              break;
            }
          }
        }
      }
      if (hasNewArticles) break;
    }

    // Also check if article count changed (handles virtual scroll replacement)
    const currentArticleCount = document.querySelectorAll('article').length;
    if (currentArticleCount !== lastArticleCount) {
      hasNewArticles = true;
      lastArticleCount = currentArticleCount;
    }

    if (hasNewArticles) {
      // Debounce to batch rapid changes
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        log.debug(' Instagram: New articles detected, triggering callback');
        callback();
      }, DEBOUNCE_MS);
    }
  });

  observer.observe(mainContainer, {
    childList: true,
    subtree: true,
  });

  // Track initial article count
  lastArticleCount = document.querySelectorAll('article').length;

  log.debug(' Instagram: Observer started, initial article count:', lastArticleCount);
}

export function setupNavigationObserver(callback: () => void): void {
  // Instagram is a SPA, so we need to detect navigation changes
  // This handles when user navigates between feed, explore, profile, etc.

  let lastPathname = window.location.pathname;

  // Use popstate for browser back/forward
  window.addEventListener('popstate', () => {
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug(' Instagram: Navigation detected via popstate');
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
      log.debug(' Instagram: Navigation detected via pushState');
      handleNavigation(callback);
    }
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    if (window.location.pathname !== lastPathname) {
      lastPathname = window.location.pathname;
      log.debug(' Instagram: Navigation detected via replaceState');
      handleNavigation(callback);
    }
  };
}

function handleNavigation(callback: () => void): void {
  // Always disconnect observer first when navigating
  if (observer) {
    observer.disconnect();
    observer = null;
    log.debug(' Instagram: Observer disconnected for navigation');
  }

  // Only process on feed pages
  if (isValidFeedPage()) {
    // Wait for new content to load
    setTimeout(() => {
      setupInstagramObserver(callback);
      callback();
    }, 500);
  } else {
    log.debug(' Instagram: Not a valid feed page, staying disconnected');
  }
}

function findMainContainer(): HTMLElement | null {
  // Instagram's main content area - try several selectors
  const selectors = [
    'main',
    '[role="main"]',
    'section > main',
    'div[style*="flex-direction: column"] > section',
  ];

  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element && element.querySelector('article')) {
      return element;
    }
  }

  // Fallback: find container of first article
  const firstArticle = document.querySelector('article');
  if (firstArticle) {
    // Go up a few levels to find a stable container
    let container = firstArticle.parentElement;
    for (let i = 0; i < 3 && container; i++) {
      if (container.tagName === 'MAIN' || container.getAttribute('role') === 'main') {
        return container;
      }
      container = container.parentElement;
    }
    // Use the parent of the first article if we can't find main
    return firstArticle.parentElement;
  }

  return null;
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
  if (pathname === '/') return true;

  // Profile pages with feed
  if (pathname.match(/^\/[a-zA-Z0-9._]+\/?$/)) return true;

  return false;
}

export function disconnectObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  log.debug(' Instagram: Observer disconnected');
}
