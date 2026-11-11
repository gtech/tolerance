// First-week card naming the extinction burst (see shared/burst-utils.ts).
// Non-modal, bottom corner, shadow root so site CSS can't touch it.

import type { BurstCardInfo } from '../background/burst';
import { saveStrictness } from '../shared/strictness-settings';

const HOST_ID = 'tolerance-burst-host';

export function send(message: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) { /* silent */ }
    });
  } catch {
    // Extension context lost
  }
}

// Called by every platform when a blurred post is revealed. Each post counts once,
// since some platforms re-blur on mouse leave.
const counted = new WeakSet<Element>();
export function noteReveal(post: Element): void {
  if (counted.has(post)) return;
  counted.add(post);
  send({ type: 'BURST_SIGNAL', signal: 'reveals' });
}

// Shared with the week-one card (weekCard.ts)
export const CARD_STYLES = `
  :host { all: initial; }
  .card {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
    width: min(360px, calc(100vw - 32px)); box-sizing: border-box;
    background: #f7f5f0; color: #2b2b2b;
    border-radius: 14px; padding: 18px 18px 16px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.3);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px; line-height: 1.5;
    animation: rise 300ms ease;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  .close {
    position: absolute; top: 6px; right: 10px;
    background: none; border: none; font-size: 20px; color: #999; cursor: pointer;
  }
  .eyebrow { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #6f8f7f; margin-bottom: 6px; }
  .title { font-size: 16px; font-weight: 600; margin-bottom: 6px; padding-right: 16px; }
  .body { color: #555; margin: 0 0 6px; }
  .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
  .btn {
    font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 9px; cursor: pointer;
    border: 1px solid #d4d0c8; background: #fff; color: #2b2b2b;
  }
  .btn.primary { background: #6f8f7f; border-color: #6f8f7f; color: #fff; }
  .btn:hover { filter: brightness(0.96); }
`;

export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function showBurstCard(info: BurstCardInfo): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_STYLES;
  const card = el('div', 'card');
  card.setAttribute('role', 'status');
  root.append(style, card);
  document.documentElement.append(host);

  const close = (event: string) => {
    host.remove();
    send({ type: 'BURST_EVENT', event, trigger: info.trigger });
  };

  const closeBtn = el('button', 'close', '×');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => close('dismissed'));

  const lowered = info.trigger === 'lowered';
  const title = lowered
    ? 'Good call turning it down instead of off.'
    : "Irritated? That's common in the first week.";
  const explain = 'Your feed stopped handing out what it trained you to expect, and the urge to hunt for it gets louder before it gets quieter. Psychologists call this an extinction burst. It tends to ease off.';
  const after = lowered
    ? 'The first week is usually the hardest. Once it eases, you can turn it back up.'
    : '';

  const actions = el('div', 'actions');
  if (!lowered && info.level > 1) {
    const down = el('button', 'btn', "It's too strict, turn it down");
    down.addEventListener('click', async () => {
      await saveStrictness(info.level - 1);
      close('turned-down');
    });
    actions.append(down);
  }
  const ok = el('button', 'btn primary', 'Got it');
  ok.addEventListener('click', () => close('got-it'));
  actions.append(ok);

  card.append(closeBtn, el('div', 'eyebrow', 'Tolerance · first week'), el('div', 'title', title), el('p', 'body', explain));
  if (after) card.append(el('p', 'body', after));
  card.append(actions);

  send({ type: 'BURST_EVENT', event: 'shown', trigger: info.trigger });
}
