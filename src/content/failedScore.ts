// The notice for a failed score's badge, shared by every site's content script.
import type { Settings } from '../shared/types';
import { ACCOUNT_URL, describeFailedScore, FailedScoreNotice } from '../shared/failed-score';

// The background opens the tab: a window.open from here counts as a pop-up, and Brave
// blocks it. window.open is the fallback if the background can't be reached.
export function openAccount(): void {
  chrome.runtime.sendMessage({ type: 'OPEN_ACCOUNT' }).catch(() => { window.open(ACCOUNT_URL, '_blank'); });
}

// The background sets apiErrorState only when the key itself is refused or out of
// allowance, and clears it on the next request that works
let keyProblem = false;
const exhausted = (state: unknown): boolean => !!(state as { exhausted?: boolean } | undefined)?.exhausted;
void chrome.storage.local.get('apiErrorState').then(stored => {
  keyProblem = exhausted(stored.apiErrorState);
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.apiErrorState) {
    keyProblem = exhausted(changes.apiErrorState.newValue);
  }
});

export function failedScoreNotice(settings: Settings | null | undefined, reason?: string): FailedScoreNotice {
  return describeFailedScore(settings?.apiTier === 'own-key', keyProblem, reason);
}

// Only a notice the account page can fix makes the badge a link to it
export function linkFailedBadge(badge: HTMLElement, notice: FailedScoreNotice): void {
  badge.style.pointerEvents = 'auto';
  if (!notice.opensAccount) {
    badge.style.cursor = 'help';
    return;
  }
  badge.style.cursor = 'pointer';
  badge.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openAccount();
  });
}
