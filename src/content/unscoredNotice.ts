// A small notice in the lower left once several posts on a page could not be scored.
// It doesn't cover the feed: posts that can't be scored stay readable, and this says
// why and where to fix it (shared/failed-score.ts has the rules for when).
import type { Settings } from '../shared/types';
import { blursUnscored, nextUnscoredNotice, UnscoredNoticeRecord, UNSCORED_BEFORE_NOTICE } from '../shared/failed-score';

const ACCOUNT_URL = 'https://tolerance.lol/account.html';
const NOTICE_TAG = 'tolerance-unscored-notice';
const STORAGE_KEY = 'unscoredNotice';

let failedOnPage = 0;
let asked = false;

// Called for each post that comes back without a score
export function noteFailedScore(settings: Settings | null | undefined): void {
  failedOnPage++;
  if (failedOnPage <= UNSCORED_BEFORE_NOTICE || asked) return;
  asked = true;
  void maybeShow(settings?.apiTier === 'own-key', blursUnscored(settings));
}

async function maybeShow(ownKey: boolean, blurred: boolean): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const next = nextUnscoredNotice(stored[STORAGE_KEY] as UnscoredNoticeRecord | undefined, Date.now());
    if (!next) return;
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch {
    return; // Extension context lost
  }
  show(ownKey, blurred);
}

function show(ownKey: boolean, blurred: boolean): void {
  if (document.querySelector(NOTICE_TAG)) return;
  const host = document.createElement(NOTICE_TAG);
  const root = host.attachShadow({ mode: 'open' });
  const message = ownKey
    ? 'Your API key has likely run out of credit.'
    : 'Your credits have likely run out.';
  const action = ownKey ? 'Click here to check your key' : 'Click here to go Pro';
  root.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed; left: 16px; bottom: 16px; z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .card {
        display: flex; align-items: flex-start; gap: 6px;
        width: min(300px, calc(100vw - 32px)); box-sizing: border-box;
        background: #151515; color: #f4f4f4;
        border: 1px solid #353535; border-radius: 8px;
        box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      }
      .go {
        flex: 1; text-align: left; cursor: pointer;
        background: none; border: none; color: inherit; font: inherit;
        padding: 12px 0 12px 14px; font-size: 13px; line-height: 1.45;
      }
      .go b { display: block; font-weight: 600; margin-bottom: 2px; }
      .go span { color: #b8b8b8; }
      .go u { color: #d3a9ea; text-decoration: none; font-weight: 600; }
      .go:hover u { text-decoration: underline; }
      .close {
        cursor: pointer; background: none; border: none; color: #888;
        font-size: 16px; line-height: 1; padding: 10px 12px;
      }
      .close:hover { color: #ccc; }
    </style>
    <div class="card" role="status">
      <button class="go" type="button">
        <b>Tolerance couldn't score these posts</b>
        <span>${message} Posts it can't score are ${blurred ? 'blurred, as you set' : 'left as they are'}.</span>
        <u>${action}</u>
      </button>
      <button class="close" type="button" aria-label="Close">×</button>
    </div>`;
  root.querySelector('.go')?.addEventListener('click', () => {
    window.open(ownKey ? chrome.runtime.getURL('dashboard/index.html#api-setup') : ACCOUNT_URL, '_blank');
    host.remove();
  });
  root.querySelector('.close')?.addEventListener('click', () => host.remove());
  document.body.appendChild(host);
}
