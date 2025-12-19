// Observer for Twitter infinite scroll / timeline updates
// Twitter uses virtualization so we need to be careful about performance

import { log } from '../../shared/constants';

let timelineObserver: MutationObserver | null = null;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500; // Twitter updates frequently, debounce aggressively

export function setupTwitterObserver(callback: () => Promise<void>): void {
  // Disconnect existing observer if any
  if (timelineObserver) {
    timelineObserver.disconnect();
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

    timelineObserver = new MutationObserver((mutations) => {
      // Only process if actual tweet-like nodes were added
      let hasNewTweets = false;

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            // Check if this contains a tweet
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
        // Debounce to avoid processing during rapid scroll
        if (debounceTimeout) {
          clearTimeout(debounceTimeout);
        }
        debounceTimeout = setTimeout(() => {
          callback();
        }, DEBOUNCE_MS);
      }
    });

    timelineObserver.observe(timeline, {
      childList: true,
      subtree: true,
    });
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
}
