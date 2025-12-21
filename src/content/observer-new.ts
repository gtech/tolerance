import { log } from '../shared/constants';

// Observer for new Reddit's dynamic content loading
// New Reddit is an SPA that loads posts dynamically into <shreddit-feed>

let feedObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;

export function setupNewRedditObserver(callback: () => void): void {
  // Debounce the callback to avoid rapid-fire calls
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCallback = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      callback();
    }, 100);
  };

  // Try to find the feed container
  const feed = document.querySelector('shreddit-feed');

  if (feed) {
    log.debug(' Found shreddit-feed, setting up observer');
    observeFeed(feed, debouncedCallback);
  } else {
    log.debug(' shreddit-feed not found, waiting for it to appear');
    // Wait for the feed to appear
    bodyObserver = new MutationObserver(() => {
      const feed = document.querySelector('shreddit-feed');
      if (feed) {
        log.debug(' shreddit-feed appeared, setting up observer');
        bodyObserver?.disconnect();
        bodyObserver = null;
        observeFeed(feed, debouncedCallback);
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Also listen for SPA navigation events
  setupNavigationListener(debouncedCallback);
}

function observeFeed(feed: Element, callback: () => void): void {
  // Disconnect any existing observer
  if (feedObserver) {
    feedObserver.disconnect();
  }

  feedObserver = new MutationObserver((mutations) => {
    // Check if any shreddit-post elements were added
    let hasNewPosts = false;

    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLElement) {
          // Check if the node itself is a post or contains posts
          if (node.tagName === 'SHREDDIT-POST' ||
              node.tagName === 'ARTICLE' ||
              node.querySelector('shreddit-post')) {
            hasNewPosts = true;
            break;
          }
        }
      }
      if (hasNewPosts) break;
    }

    if (hasNewPosts) {
      log.debug(' New posts detected via MutationObserver');
      callback();
    }
  });

  // Observe the feed for new posts
  feedObserver.observe(feed, {
    childList: true,
    subtree: true,
  });

  log.debug(' New Reddit observer set up on shreddit-feed');
}

function setupNavigationListener(callback: () => void): void {
  // New Reddit uses the History API for navigation
  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', () => {
    log.debug(' Navigation detected (popstate), re-processing posts');
    // Wait a bit for the new content to load
    setTimeout(callback, 500);
  });

  // Also intercept pushState/replaceState for SPA navigation
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function(...args) {
    originalPushState(...args);
    log.debug(' Navigation detected (pushState), re-processing posts');
    setTimeout(callback, 500);
  };

  history.replaceState = function(...args) {
    originalReplaceState(...args);
    // Don't trigger for replaceState as it's often used for scroll position updates
  };
}

// Cleanup function
export function disconnectNewRedditObserver(): void {
  if (feedObserver) {
    feedObserver.disconnect();
    feedObserver = null;
  }
  if (bodyObserver) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
}
