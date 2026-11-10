// Point the browser's uninstall page at tolerance.lol/bye/, a one-question survey.
// The URL carries a few facts so answers can be read in context: version,
// days since install, strictness level, browser, and whether the first-week
// card was shown. Nothing identifying. Refreshed at startup and on settings changes.

import { thresholdsToStrictness, DEFAULT_BLUR_THRESHOLDS } from '../shared/constants';
import type { Settings } from '../shared/types';
import type { BurstState } from '../shared/burst-utils';

const SURVEY_URL = 'https://tolerance.lol/bye/';
const DAY_MS = 24 * 60 * 60 * 1000;

export async function updateUninstallUrl(): Promise<void> {
  if (!chrome.runtime.setUninstallURL) return;
  try {
    const stored = await chrome.storage.local.get(['installedAt', 'state', 'settings', 'burstState']);
    // Installs from before installedAt existed fall back to the baseline start date
    const since = (stored.installedAt as number | undefined)
      ?? (stored.state as { baselineStartDate?: number } | undefined)?.baselineStartDate;
    const settings = stored.settings as Settings | undefined;
    const custom = settings?.customThresholds;
    const level = thresholdsToStrictness(custom?.enabled ? custom.blurThresholds : DEFAULT_BLUR_THRESHOLDS).level;

    const params = new URLSearchParams({
      v: chrome.runtime.getManifest().version,
      s: String(level),
      b: chrome.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chrome',
    });
    if (since) params.set('d', String(Math.max(0, Math.floor((Date.now() - since) / DAY_MS))));
    if ((stored.burstState as BurstState | undefined)?.shown) params.set('c', '1');

    await chrome.runtime.setUninstallURL(`${SURVEY_URL}?${params}`);
  } catch {
    // Not fatal: the survey just opens without context
  }
}

export function watchForUninstallUrlChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.burstState || changes.installedAt)) {
      updateUninstallUrl();
    }
  });
}
