// Observer for YouTube infinite scroll / content updates
// YouTube uses custom web components and SPA navigation

import { log } from '../../shared/constants';

let contentObserver: MutationObserver | null = null;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

export function setupYouTubeObserver(callback: () => Promise<void>): void {
  // Disconnect existing observer if any
  if (contentObserver) {
    contentObserver.disconnect();
  }

  log.debug(' Setting up YouTube content observer');

  contentObserver = new MutationObserver((mutations) => {
    let hasNewVideos = false;

    // Video selectors including new lockup model for sidebar
    const videoSelectors = 'ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, yt-lockup-view-model';

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement) {
          // Check if this is a video element or contains video elements
          if (
            node.matches?.(videoSelectors) ||
            node.querySelector?.(videoSelectors)
          ) {
            hasNewVideos = true;
            break;
          }
        }
      }
      if (hasNewVideos) break;
    }

    if (hasNewVideos) {
      // Debounce to avoid processing during rapid scroll
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        callback();
      }, DEBOUNCE_MS);
    }
  });

  // Observe the whole body since YouTube dynamically creates containers
  contentObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// YouTube uses History API for SPA navigation
export function setupNavigationObserver(callback: () => void): void {
  // Wrap pushState to detect navigation
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

  // Also listen for back/forward navigation
  window.addEventListener('popstate', callback);

  // YouTube also fires a custom event on navigation
  window.addEventListener('yt-navigate-finish', callback);
}

export function disconnectObservers(): void {
  if (contentObserver) {
    contentObserver.disconnect();
    contentObserver = null;
  }
  if (debounceTimeout) {
    clearTimeout(debounceTimeout);
    debounceTimeout = null;
  }
}
