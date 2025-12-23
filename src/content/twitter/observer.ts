// Observer for Twitter infinite scroll / timeline updates
// Twitter uses virtualization so we need to be careful about performance

import { log } from '../../shared/constants';

let timelineObserver: MutationObserver | null = null;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
let scrollCheckInterval: ReturnType<typeof setInterval> | null = null;
let lastCallTime = 0;
let lastKnownTweetCount = 0;
const THROTTLE_MS = 1000; // Process at most once per second

export function setupTwitterObserver(callback: () => Promise<void>): void {
  // Disconnect existing observer if any
  if (timelineObserver) {
    timelineObserver.disconnect();
  }
  if (scrollCheckInterval) {
    clearInterval(scrollCheckInterval);
  }

  // Wait for timeline to exist
  const findAndObserve = () => {
    const timeline = document.querySelector('[data-testid="primaryColumn"] section[role="region"]');
    if (!timeline) {
      // Try again in a bit - Twitter's SPA might not have rendered yet
      setTimeout(findAndObserve, 1000);
      return;
    }

    log.debug(' Setting up Twitter timeline observer');

    // Throttled callback - ensures we don't spam processing
    const throttledCallback = (source: string) => {
      const now = Date.now();
      const timeSinceLastCall = now - lastCallTime;

      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
        debounceTimeout = null;
      }

      // If it's been long enough since last call, trigger immediately
      if (timeSinceLastCall >= THROTTLE_MS) {
        lastCallTime = now;
        log.debug(` Twitter observer triggered (${source})`);
        callback();
      } else {
        // Schedule for when throttle period ends
        const delay = THROTTLE_MS - timeSinceLastCall;
        debounceTimeout = setTimeout(() => {
          lastCallTime = Date.now();
          log.debug(` Twitter observer triggered (${source}, delayed)`);
          callback();
        }, delay);
      }
    };

    // MutationObserver for DOM changes
    timelineObserver = new MutationObserver((mutations) => {
      let hasNewTweets = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (
              node.querySelector?.('[data-testid="tweet"]') ||
              node.matches?.('[data-testid="cellInnerDiv"]')
            ) {
              hasNewTweets = true;
              break;
            }
          }
        }
        if (hasNewTweets) break;
      }

      if (hasNewTweets) {
        throttledCallback('mutation');
      }
    });

    timelineObserver.observe(timeline, {
      childList: true,
      subtree: true,
    });

    // Scroll-based fallback - Twitter's virtualization may not always trigger mutations
    // Check every 500ms while scrolling for new tweets
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    let isScrolling = false;

    const checkForNewTweets = () => {
      const currentCount = document.querySelectorAll('[data-testid="tweet"]').length;
      if (currentCount !== lastKnownTweetCount) {
        log.debug(` Tweet count changed: ${lastKnownTweetCount} -> ${currentCount}`);
        lastKnownTweetCount = currentCount;
        throttledCallback('scroll-check');
      }
    };

    window.addEventListener('scroll', () => {
      isScrolling = true;

      // Clear existing scroll end timeout
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }

      // Mark scroll as ended after 200ms of no scroll events
      scrollTimeout = setTimeout(() => {
        isScrolling = false;
        // Final check when scrolling stops
        checkForNewTweets();
      }, 200);
    }, { passive: true });

    // Periodic check during scroll - catches tweets that slip through
    scrollCheckInterval = setInterval(() => {
      if (isScrolling) {
        checkForNewTweets();
      }
    }, 500);

    // Initial tweet count
    lastKnownTweetCount = document.querySelectorAll('[data-testid="tweet"]').length;
  };

  // Start looking for timeline
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', findAndObserve);
  } else {
    findAndObserve();
  }
}

// Also observe for navigation changes (Twitter is a SPA)
export function setupNavigationObserver(callback: () => void): void {
  // Twitter uses History API for navigation
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    callback();
  };

  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    callback();
  };

  window.addEventListener('popstate', callback);
}

export function disconnectObservers(): void {
  if (timelineObserver) {
    timelineObserver.disconnect();
    timelineObserver = null;
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }
  if (scrollCheckInterval) {
    clearInterval(scrollCheckInterval);
    scrollCheckInterval = null;
  }
  lastKnownTweetCount = 0;
}
