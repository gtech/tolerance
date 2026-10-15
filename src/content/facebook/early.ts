// Runs at document_start, before Facebook renders anything. Holds feed items blurred
// with plain CSS until the main content script takes over (it swaps in its own gate
// and removes this style), so posts never flash unblurred on first load.

import type { Settings } from '../../shared/types';
import { fbGateCss, isFacebookFeedPath } from './gate';

const FALLBACK_MS = 15000; // never leave the feed blurred if the main script fails

if (isFacebookFeedPath(location.pathname)) {
  const style = document.createElement('style');
  style.id = 'tolerance-early-blur';
  document.documentElement.classList.add('tolerance-fb-early');
  style.textContent = fbGateCss('tolerance-fb-early');
  document.documentElement.append(style);

  const remove = () => {
    style.remove();
    document.documentElement.classList.remove('tolerance-fb-early');
  };
  setTimeout(remove, FALLBACK_MS);

  try {
    chrome.storage.local.get('settings', (result) => {
      if (chrome.runtime.lastError) { remove(); return; }
      const settings = result.settings as Partial<Settings> | undefined;
      if (settings?.platforms?.facebook === false || settings?.blurUntilScored === false) remove();
    });
  } catch {
    remove();
  }
}
