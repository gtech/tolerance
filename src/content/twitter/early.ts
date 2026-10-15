// Runs at document_start, before Twitter renders anything. The main content script
// only starts at document_idle and needs a few round-trips before it can blur, so
// the first tweets of a fresh tab used to flash unblurred. This holds every tweet
// cell blurred with plain CSS until the main script takes over (it removes the
// style once its own pending blur is in place), or until settings say not to.

import type { Settings } from '../../shared/types';
import { isUnfilteredTwitterPath } from './paths';

// Keep in sync with removeEarlyBlur() in ./index.ts
const EARLY_BLUR_STYLE_ID = 'tolerance-early-blur';

const FALLBACK_MS = 15000; // never leave the feed blurred if the main script fails

if (!isUnfilteredTwitterPath(location.pathname)) {
  const style = document.createElement('style');
  style.id = EARLY_BLUR_STYLE_ID;
  style.textContent = `
    [data-testid="cellInnerDiv"]:has(article[data-testid="tweet"]):not(.tolerance-pending):not(.tolerance-blurred) > * {
      filter: blur(8px) !important;
      pointer-events: none !important;
    }
  `;
  document.documentElement.append(style);

  const remove = () => style.remove();
  setTimeout(remove, FALLBACK_MS);

  try {
    chrome.storage.local.get('settings', (result) => {
      if (chrome.runtime.lastError) { remove(); return; }
      const settings = result.settings as Partial<Settings> | undefined;
      const twitter = settings?.twitter;
      if (settings?.platforms?.twitter === false ||
          twitter?.blurHighEngagement === false ||
          twitter?.reorderEnabled ||
          settings?.blurUntilScored === false) {
        remove();
      }
    });
  } catch {
    remove();
  }
}
