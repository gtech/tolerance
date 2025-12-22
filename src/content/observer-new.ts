import { log } from '../shared/constants';

// Observer for new Reddit's dynamic content loading
// New Reddit is an SPA that loads posts dynamically into <shreddit-feed>

let feedObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;

export function setupNewRedditObserver(callback: () => void, onNavigate?: () => void): void {
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
  setupNavigationListener(debouncedCallback, onNavigate);
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

function setupNavigationListener(callback: () => void, onNavigate?: () => void): void {
  // Debounce the callback
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedCallback = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      callback();
    }, 100);
  };

  const handleNavigation = () => {
    log.debug(' Navigation detected, re-setting up observer');

    // Call navigation callback to clear processed posts etc.
    if (onNavigate) onNavigate();

    // Disconnect existing observers - the feed element may have been replaced
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
    }

    // Wait for new content to load, then re-setup observer
    setTimeout(() => {
      const feed = document.querySelector('shreddit-feed');
      if (feed) {
        log.debug(' Found new shreddit-feed after navigation');
        observeFeed(feed, debouncedCallback);
        callback(); // Process the new posts
      } else {
        log.debug(' No shreddit-feed found after navigation, waiting...');
        // Set up body observer to wait for feed
        if (bodyObserver) bodyObserver.disconnect();
        bodyObserver = new MutationObserver(() => {
          const feed = document.querySelector('shreddit-feed');
          if (feed) {
            log.debug(' shreddit-feed appeared after navigation');
            bodyObserver?.disconnect();
            bodyObserver = null;
            observeFeed(feed, debouncedCallback);
            callback();
          }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
      }
    }, 500);
  };

  // New Reddit uses the History API for navigation
  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', () => {
    log.debug(' Navigation detected (popstate)');
    handleNavigation();
  });

  // Also intercept pushState/replaceState for SPA navigation
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function(...args) {
    originalPushState(...args);
    log.debug(' Navigation detected (pushState)');
    handleNavigation();
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
