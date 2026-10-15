// Runs at document_start, before YouTube renders anything. Holds every video card
// blurred with plain CSS until the main content script takes over (it swaps in its
// own gate and removes this style), so new cards never flash unblurred.

import type { Settings } from '../../shared/types';
import { gateCss, isUnscoredYouTubePage } from './gate';

const FALLBACK_MS = 15000; // never leave the feed blurred if the main script fails

if (!isUnscoredYouTubePage(location.pathname)) {
  const style = document.createElement('style');
  style.id = 'tolerance-early-blur';
  document.documentElement.classList.add('tolerance-yt-early');
  style.textContent = gateCss('tolerance-yt-early');
  document.documentElement.append(style);

  const remove = () => {
    style.remove();
    document.documentElement.classList.remove('tolerance-yt-early');
  };
  setTimeout(remove, FALLBACK_MS);

  try {
    chrome.storage.local.get('settings', (result) => {
      if (chrome.runtime.lastError) { remove(); return; }
      const settings = result.settings as Partial<Settings> | undefined;
      if (settings?.platforms?.youtube === false || settings?.blurUntilScored === false) remove();
    });
  } catch {
    remove();
  }
}
