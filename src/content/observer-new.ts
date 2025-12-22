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

  // Process any existing posts after a short delay to let Reddit finish rendering
  const checkExistingPosts = () => {
    const existingPosts = feed.querySelectorAll('shreddit-post:not([promoted])');
    if (existingPosts.length > 0) {
      log.debug(` Found ${existingPosts.length} existing posts, triggering callback`);
      callback();
    }
  };
  // Check immediately and again after a delay
  checkExistingPosts();
  setTimeout(checkExistingPosts, 500);
  setTimeout(checkExistingPosts, 1500);

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

  // Fallback: also check on scroll since Reddit's lazy loading might not trigger mutations
  let scrollDebounce: ReturnType<typeof setTimeout> | null = null;
  let lastPostCount = feed.querySelectorAll('shreddit-post:not([promoted])').length;

  window.addEventListener('scroll', () => {
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      const currentCount = feed.querySelectorAll('shreddit-post:not([promoted])').length;
      if (currentCount > lastPostCount) {
        log.debug(` Scroll detected ${currentCount - lastPostCount} new posts (${lastPostCount} -> ${currentCount})`);
        lastPostCount = currentCount;
        callback();
      }
    }, 300);
  }, { passive: true });

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

  // Track current URL to detect changes
  let lastUrl = window.location.href;

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

  // Fallback: poll for URL changes (in case pushState interception doesn't work)
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      log.debug(' URL change detected via polling:', lastUrl, '->', currentUrl);
      lastUrl = currentUrl;
      handleNavigation();
    }
  }, 500);
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
