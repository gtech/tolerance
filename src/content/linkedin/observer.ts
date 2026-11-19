import { log } from '../../shared/constants';
import { isLinkedInFeedPath } from './gate';

// New feed posts are detected with a MutationObserver (throttled). LinkedIn's feed is
// virtualized: posts are removed as they scroll away and built again when they come
// back, so the same post is seen many times. Unscored posts are covered by the CSS
// gate in the meantime, so the throttle only delays scoring, never exposes a post.

let observer: MutationObserver | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastRun = 0;
const THROTTLE_MS = 200;

export function setupLinkedInObserver(callback: () => void): void {
  if (observer) return;
  if (!isValidFeedPage()) return;

  const run = () => {
    throttleTimer = null;
    lastRun = Date.now();
    callback();
  };

  observer = new MutationObserver((mutations) => {
    if (!mutations.some(m => m.addedNodes.length > 0)) return;
    if (throttleTimer) return;
    throttleTimer = setTimeout(run, Math.max(0, THROTTLE_MS - (Date.now() - lastRun)));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  log.debug('LinkedIn: Mutation observer started');
}

// LinkedIn is a single-page app and changes the address from the page's own scripts,
// which a content script can't hook, so watch the path instead (popstate + poll).
let lastPath = location.pathname;
let navigationCallback: (() => void) | null = null;

function checkNavigation(): void {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  log.debug('LinkedIn: Navigation detected ->', lastPath);
  navigationCallback?.();
}

export function setupNavigationObserver(callback: () => void): void {
  navigationCallback = callback;
  window.addEventListener('popstate', checkNavigation);
  setInterval(checkNavigation, 250);
}

export function isValidFeedPage(): boolean {
  return isLinkedInFeedPath(window.location.pathname);
}

export function disconnectObserver(): void {
  observer?.disconnect();
  observer = null;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
}
