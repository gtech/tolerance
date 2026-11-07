import type { Settings } from '../shared/types';
import { syncGateOpacity } from './gateOpacity';

// Reddit and Instagram blur unhandled posts with a stylesheet from the manifest
// (reddit-gate.css, instagram/gate.css), so it applies from first paint without
// touching the DOM. Scripts only mark posts as handled and switch the gate off.
export const GATE_POST_ATTR = 'data-tolerance-pid';  // post has been picked up
export const GATE_DONE_ATTR = 'data-tolerance-done'; // item will never be scored

// Keep the gate off where blur-until-scored doesn't apply. Returns a function to
// re-check, for pages where pageAllowed changes without a settings change.
export function watchGate(platform: 'reddit' | 'instagram', pageAllowed: () => boolean = () => true): () => void {
  let settings: Partial<Settings> | undefined;
  const update = () => {
    const on = settings?.platforms?.[platform] !== false && settings?.blurUntilScored !== false && pageAllowed();
    document.documentElement.classList.toggle('tolerance-gate-off', !on);
    syncGateOpacity(settings);
  };

  update();
  try {
    chrome.storage.local.get('settings', (result) => {
      settings = result?.settings as Partial<Settings> | undefined;
      update();
    });
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.settings?.newValue) {
        settings = changes.settings.newValue as Partial<Settings>;
        update();
      }
    });
  } catch {
    // Extension context lost: the gate releases posts on its own after 15 seconds
  }
  return update;
}

// Release a feed item that isn't a post yet only once it has stayed that way for a
// moment: a post that's still rendering looks the same, and releasing it would show
// it unblurred as soon as its content arrived.
const RELEASE_AFTER_MS = 2000;
const unscrapedSince = new WeakMap<Element, number>();

export function releaseIfStillUnscraped(item: Element, recheck: () => void): void {
  const since = unscrapedSince.get(item);
  if (since === undefined) {
    unscrapedSince.set(item, Date.now());
    setTimeout(recheck, RELEASE_AFTER_MS + 50);
  } else if (Date.now() - since >= RELEASE_AFTER_MS) {
    item.setAttribute(GATE_DONE_ATTR, '');
  }
}
