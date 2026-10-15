// Observer for YouTube infinite scroll / content updates
// YouTube uses custom web components and SPA navigation

import { log } from '../../shared/constants';
import { VIDEO_CARD_SELECTOR } from './gate';

let contentObserver: MutationObserver | null = null;
let debounceTimeout: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 500;

// onCardsChanged runs synchronously inside the MutationObserver callback (before the
// browser paints), for video cards that were added or whose links changed.
export function setupYouTubeObserver(
  callback: () => Promise<void>,
  onCardsChanged?: (cards: HTMLElement[]) => void
): void {
  // Disconnect existing observer if any
  if (contentObserver) {
    contentObserver.disconnect();
  }

  log.debug(' Setting up YouTube content observer');

  contentObserver = new MutationObserver((mutations) => {
    let hasNewVideos = false;

    if (onCardsChanged) {
      const cards = new Set<HTMLElement>();
      for (const mutation of mutations) {
        const nodes = mutation.type === 'attributes' ? [mutation.target] : [...mutation.addedNodes];
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          const card = node.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
          if (card) cards.add(card);
          if (mutation.type === 'childList') {
            node.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR).forEach(c => cards.add(c));
          }
        }
      }
      if (cards.size > 0) {
        try {
          onCardsChanged([...cards]);
        } catch (e) {
          log.error(' onCardsChanged failed:', e);
        }
      }
    }

    // Video selectors including new lockup model for sidebar
    const videoSelectors = 'ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-video-renderer, yt-lockup-view-model';

    for (const mutation of mutations) {
      // A recycled card is re-rendered in place: its video link changes but no
      // video element is added
      if (mutation.type === 'attributes') {
        const target = mutation.target as HTMLElement;
        if (target.closest?.(videoSelectors)) {
          hasNewVideos = true;
          break;
        }
        continue;
      }
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
    attributes: true,
    attributeFilter: ['href'],
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
