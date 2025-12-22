import { log } from '../shared/constants';

// Observer for new Reddit's dynamic content loading
// New Reddit is an SPA that loads posts dynamically into <shreddit-feed>

let feedObserver: MutationObserver | null = null;
let bodyObserver: MutationObserver | null = null;
let postCheckInterval: ReturnType<typeof setInterval> | null = null;

// Track all post IDs we've seen (globally, to detect new ones)
let knownPostIds = new Set<string>();

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
  // Disconnect any existing observer and interval
  if (feedObserver) {
    feedObserver.disconnect();
  }
  if (postCheckInterval) {
    clearInterval(postCheckInterval);
  }

  // Helper: Get all current post IDs from the document (not just the feed element)
  // This ensures we detect posts even if the feed element reference is stale
  const getCurrentPostIds = (): Set<string> => {
    const posts = document.querySelectorAll('shreddit-post:not([promoted])');
    const ids = new Set<string>();
    for (const post of posts) {
      const id = post.getAttribute('id');
      if (id) ids.add(id);
    }
    return ids;
  };

  // Helper: Check for new posts and trigger callback if found
  const checkForNewPosts = (source: string): boolean => {
    const currentIds = getCurrentPostIds();
    let hasNew = false;

    for (const id of currentIds) {
      if (!knownPostIds.has(id)) {
        hasNew = true;
        knownPostIds.add(id);
      }
    }

    if (hasNew) {
      log.debug(` ${source}: New posts detected (total known: ${knownPostIds.size})`);
      callback();
    }

    return hasNew;
  };

  // Initial check - record existing posts
  const initialIds = getCurrentPostIds();
  for (const id of initialIds) {
    knownPostIds.add(id);
  }
  log.debug(` Initial posts recorded: ${knownPostIds.size}`);

  // Trigger callback for initial posts
  if (initialIds.size > 0) {
    callback();
  }

  // Poll for new posts during initial load (Reddit loads posts progressively)
  let pollCount = 0;
  const maxPolls = 10; // Poll for up to 5 seconds (500ms * 10)

  const pollForPosts = () => {
    checkForNewPosts('Poll');
    pollCount++;
    if (pollCount < maxPolls) {
      setTimeout(pollForPosts, 500);
    }
  };

  // Start polling after a short delay (let initial render complete)
  setTimeout(pollForPosts, 200);

  // MutationObserver on the feed
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
      checkForNewPosts('MutationObserver');
    }
  });

  // Observe the feed for new posts
  feedObserver.observe(feed, {
    childList: true,
    subtree: true,
  });

  // Also observe document body in case posts are added outside the feed
  const bodyMutationObserver = new MutationObserver(() => {
    // Lightweight check - only run if there might be new posts
    const currentCount = document.querySelectorAll('shreddit-post:not([promoted])').length;
    if (currentCount > knownPostIds.size) {
      checkForNewPosts('BodyObserver');
    }
  });

  bodyMutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Fallback: check on scroll since Reddit's lazy loading might not trigger mutations
  let scrollDebounce: ReturnType<typeof setTimeout> | null = null;

  window.addEventListener('scroll', () => {
    if (scrollDebounce) clearTimeout(scrollDebounce);
    scrollDebounce = setTimeout(() => {
      checkForNewPosts('Scroll');
    }, 300);
  }, { passive: true });

  // Ultimate fallback: periodic check every 2 seconds
  // This catches any posts that slip through other detection methods
  postCheckInterval = setInterval(() => {
    checkForNewPosts('Interval');
  }, 2000);

  log.debug(' New Reddit observer set up with multiple detection methods');
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

    // Clear known post IDs so new page's posts are detected
    knownPostIds.clear();

    // Disconnect existing observers - the feed element may have been replaced
    if (feedObserver) {
      feedObserver.disconnect();
      feedObserver = null;
    }
    if (postCheckInterval) {
      clearInterval(postCheckInterval);
      postCheckInterval = null;
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
  if (postCheckInterval) {
    clearInterval(postCheckInterval);
    postCheckInterval = null;
  }
  knownPostIds.clear();
}
