// Runs at document_start, before LinkedIn renders anything. Holds feed posts blurred
// with plain CSS until the main content script takes over (it swaps in its own gate
// and removes this style), so posts never flash unblurred on first load.

import type { Settings } from '../../shared/types';
import { liGateCss, isLinkedInFeedPath } from './gate';
import { syncGateOpacity } from '../gateOpacity';

const FALLBACK_MS = 15000; // never leave the feed blurred if the main script fails

if (isLinkedInFeedPath(location.pathname)) {
  const style = document.createElement('style');
  style.id = 'tolerance-early-blur';
  document.documentElement.classList.add('tolerance-li-early');
  style.textContent = liGateCss('tolerance-li-early');
  document.documentElement.append(style);

  const remove = () => {
    style.remove();
    document.documentElement.classList.remove('tolerance-li-early');
  };
  setTimeout(remove, FALLBACK_MS);

  try {
    chrome.storage.local.get('settings', (result) => {
      if (chrome.runtime.lastError) { remove(); return; }
      const settings = result.settings as Partial<Settings> | undefined;
      syncGateOpacity(settings);
      if (settings?.blurUntilScored === false) remove();
    });
  } catch {
    remove();
  }
}
