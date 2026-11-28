// A small notice in the lower right once several posts on a page could not be scored.
// It doesn't cover the feed: posts that can't be scored stay readable, and this says
// why and where to fix it (shared/failed-score.ts has the rules for when). It looks
// like the "Tolerance was updated" notice (reloadNotice.ts) and sits where that does.
import type { Settings } from '../shared/types';
import { blursUnscored, nextUnscoredNotice, UnscoredNoticeRecord, UNSCORED_BEFORE_NOTICE } from '../shared/failed-score';
import { openAccount } from './failedScore';

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
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const message = ownKey
    ? 'Your API key has likely run out of credit.'
    : 'Your credits have likely run out.';
  root.innerHTML = `
    <style>
      .card {
        position: relative;
        box-sizing: border-box; width: 300px; max-width: calc(100vw - 32px); padding: 14px 16px;
        background: #1a1a2e; color: #eee; border: 1px solid #4a4a8a; border-radius: 10px;
        box-shadow: 0 6px 24px rgba(0,0,0,0.45);
        font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .title { font-weight: 600; margin: 0 22px 4px 0; }
      .body { color: #bbb; font-size: 13px; margin: 0 0 12px; }
      .go {
        border: 0; border-radius: 6px; padding: 7px 14px; cursor: pointer;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff;
        font: inherit; font-weight: 600;
      }
      .close {
        position: absolute; top: 6px; right: 8px; border: 0; background: none; color: #888;
        font-size: 18px; line-height: 1; cursor: pointer; padding: 4px;
      }
      .close:hover { color: #ccc; }
    </style>
    <div class="card" role="status">
      <button class="close" type="button" aria-label="Close">×</button>
      <div class="title">Tolerance couldn't score these posts</div>
      <p class="body">${message} Posts it can't score are ${blurred ? 'blurred, as you set' : 'left as they are'}.</p>
      <button class="go" type="button">${ownKey ? 'Check your key' : 'Go Pro'}</button>
    </div>`;
  root.querySelector('.go')?.addEventListener('click', () => {
    if (ownKey) void chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD', section: 'api-setup' }).catch(() => {});
    else openAccount();
    host.remove();
  });
  root.querySelector('.close')?.addEventListener('click', () => host.remove());
  (document.body ?? document.documentElement).appendChild(host);
}
