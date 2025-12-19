// MutationObserver to handle dynamically loaded content
// Old Reddit can have infinite scroll via RES (Reddit Enhancement Suite)
// or native "never ending reddit" feature

import { log } from '../shared/constants';

type NewPostsCallback = () => void;

let observer: MutationObserver | null = null;
let debounceTimer: number | null = null;

export function setupObserver(onNewPosts: NewPostsCallback): void {
  if (observer) {
    observer.disconnect();
  }

  const siteTable = document.querySelector('#siteTable');
  if (!siteTable) {
    console.warn('Tolerance: #siteTable not found, cannot observe for new posts');
    return;
  }

  observer = new MutationObserver((mutations) => {
    // Check if any posts were added
    let hasNewPosts = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.classList.contains('thing') &&
            node.classList.contains('link')
          ) {
            hasNewPosts = true;
            break;
          }
        }
      }
      if (hasNewPosts) break;
    }

    if (hasNewPosts) {
      // Debounce to handle batch additions
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }

      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        onNewPosts();
      }, 100);
    }
  });

  observer.observe(siteTable, {
    childList: true,
    subtree: false,
  });

  log.debug(' Observer set up for infinite scroll');
}

export function disconnectObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// Also observe for RES-style page markers
// RES adds ".NERPageMarker" elements when loading new pages
export function setupRESObserver(onNewPage: NewPostsCallback): void {
  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (
            node instanceof HTMLElement &&
            node.classList.contains('NERPageMarker')
          ) {
            // New page loaded by RES
            setTimeout(onNewPage, 200); // Small delay for posts to render
            return;
          }
        }
      }
    }
  });

  bodyObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}
