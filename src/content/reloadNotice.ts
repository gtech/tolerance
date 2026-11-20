// When the extension is updated or reloaded, tabs that were already open keep running
// the old content script, which can no longer reach the background: nothing new gets
// scored and posts waiting for a score stay blurred. That is left as it is (better
// blurred than unfiltered); this tells the person why, and offers the fix: a refresh.
//
// The old script can still change the page, so the notice is drawn by it.

const NOTICE_ID = 'tolerance-reload-notice';
const CHECK_MS = 3_000;

function contextGone(): boolean {
  try {
    return !chrome.runtime?.id;
  } catch {
    return true;
  }
}

export function showReloadNotice(): void {
  if (document.getElementById(NOTICE_ID)) return;
  const host = document.createElement('div');
  host.id = NOTICE_ID;
  host.style.cssText = 'all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
  // A shadow root keeps the site's styles out of the notice
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .card {
      box-sizing: border-box; width: 300px; max-width: calc(100vw - 32px); padding: 14px 16px;
      background: #1a1a2e; color: #eee; border: 1px solid #4a4a8a; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.45);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .title { font-weight: 600; margin: 0 22px 4px 0; }
    .body { color: #bbb; font-size: 13px; margin: 0 0 12px; }
    .refresh {
      border: 0; border-radius: 6px; padding: 7px 14px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff;
      font: inherit; font-weight: 600;
    }
    .close {
      position: absolute; top: 6px; right: 8px; border: 0; background: none; color: #888;
      font-size: 18px; line-height: 1; cursor: pointer; padding: 4px;
    }
    .close:hover { color: #ccc; }
    .card { position: relative; }
  `;

  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'status');

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => host.remove());

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = 'Tolerance was updated';

  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = 'New posts on this page will stay blurred until you refresh it.';

  const refresh = document.createElement('button');
  refresh.className = 'refresh';
  refresh.textContent = 'Refresh page';
  refresh.addEventListener('click', () => location.reload());

  card.append(close, title, body, refresh);
  root.append(style, card);
  (document.body ?? document.documentElement).appendChild(host);
}

let watching = false;

// Called once a site's script has decided to run on the page. Shows the notice the
// first time the extension is found to be gone; closing it is final for this page.
export function watchForReload(): void {
  if (watching) return;
  watching = true;
  const timer = setInterval(() => {
    if (!contextGone()) return;
    clearInterval(timer);
    showReloadNotice();
  }, CHECK_MS);
}
