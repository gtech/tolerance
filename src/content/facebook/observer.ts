import { log } from '../../shared/constants';
import { isFacebookFeedPath } from './gate';

// New feed items are detected with a MutationObserver (throttled), so they're picked
// up as soon as Facebook renders them. Unscored items are covered by the CSS gate in
// the meantime, so the throttle only delays scoring, never exposes a post.

let observer: MutationObserver | null = null;
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let lastRun = 0;
const THROTTLE_MS = 200;

export function setupFacebookObserver(callback: () => void): void {
  if (observer) return;
  if (!isValidFeedPage()) {
    log.debug('Facebook: Not on valid feed page, skipping observer setup');
    return;
  }

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
  log.debug('Facebook: Mutation observer started');
}

// Facebook is a SPA and calls history.pushState from the page's JS world, which a
// content script can't hook, so watch the path instead (popstate + poll).
let lastPath = location.pathname;
let navigationCallback: (() => void) | null = null;

export function checkNavigation(): void {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;
  log.debug('Facebook: Navigation detected ->', lastPath);
  navigationCallback?.();
}

export function setupNavigationObserver(callback: () => void): void {
  navigationCallback = callback;
  window.addEventListener('popstate', checkNavigation);
  setInterval(checkNavigation, 250);
}

export function isValidFeedPage(): boolean {
  return isFacebookFeedPath(window.location.pathname);
}

export function disconnectObserver(): void {
  observer?.disconnect();
  observer = null;
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  log.debug('Facebook: Observer disconnected');
}
