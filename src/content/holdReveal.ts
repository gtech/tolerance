// Press-and-hold to reveal a blurred post, on every platform.
//
// A reveal should be a choice that costs something, not a free click or a
// resting cursor. Holding fills a ring over a few seconds; letting go early
// cancels. The hold gets longer with each reveal in the last 30 minutes, and a
// "Skip" button offers the way out (the part of a friction prompt that
// research on the one sec app found does the work).

import { holdSecondsFor, REVEAL_WINDOW_MS } from '../shared/hold-utils';

const HOLD_TAG = 'tolerance-hold';
const MAX_LOG_ENTRIES = 500;

// Recent reveal times across all tabs, cached so a press can start instantly
let recentReveals: number[] = [];
let cacheReady = false;

function initCache(): void {
  if (cacheReady) return;
  cacheReady = true;
  try {
    chrome.storage.local.get('revealTimes').then(({ revealTimes }) => {
      recentReveals = (revealTimes as number[] | undefined) ?? [];
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.revealTimes) recentReveals = (changes.revealTimes.newValue as number[] | undefined) ?? [];
    });
  } catch {
    // Extension context lost
  }
}

async function recordReveal(): Promise<void> {
  const now = Date.now();
  recentReveals = [...recentReveals.filter(t => now - t < REVEAL_WINDOW_MS), now];
  try {
    await chrome.storage.local.set({ revealTimes: recentReveals });
  } catch {
    // Extension context lost
  }
}

async function logEvent(event: 'revealed' | 'skipped' | 'let-go', holdMs: number): Promise<void> {
  try {
    const { revealLog } = await chrome.storage.local.get('revealLog');
    const entries = (revealLog as { t: number; event: string; holdMs: number; host: string }[] | undefined) ?? [];
    entries.push({ t: Date.now(), event, holdMs, host: location.hostname });
    await chrome.storage.local.set({ revealLog: entries.slice(-MAX_LOG_ENTRIES) });
  } catch {
    // Extension context lost
  }
}

// The click that follows a completed hold would otherwise open the post
function swallowNextClick(): void {
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 800);
}

const STYLES = `
  :host {
    all: initial;
    position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
    z-index: 2; pointer-events: auto;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .chip {
    display: flex; align-items: center; gap: 10px;
    background: rgba(20, 20, 20, 0.82); color: #fff;
    border-radius: 999px; padding: 6px 6px 6px 14px;
    font-size: 13px; font-weight: 500; white-space: nowrap;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3); user-select: none;
  }
  .ring { width: 18px; height: 18px; display: none; transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 3; }
  .ring .track { stroke: rgba(255,255,255,0.25); }
  .ring .fill { stroke: #7dcea0; stroke-linecap: round; }
  :host(.holding) .ring { display: block; }
  .skip {
    font: inherit; font-size: 12px; color: #ddd; cursor: pointer;
    background: rgba(255,255,255,0.12); border: none; border-radius: 999px; padding: 4px 10px;
  }
  .skip:hover { background: rgba(255,255,255,0.2); }
  :host(.done) .skip { display: none; }
  :host(.done) .chip { padding-right: 14px; }
  /* Short cards (YouTube sidebar, small thumbnails): tuck into the corner */
  @container tolerance-overlay (max-height: 170px) {
    :host { left: auto; right: 4px; bottom: 4px; transform: none; }
    .chip { font-size: 11px; gap: 6px; padding: 3px 3px 3px 9px; }
    .skip { font-size: 11px; padding: 2px 8px; }
    .ring { width: 14px; height: 14px; }
  }
`;

const CIRCUMFERENCE = 2 * Math.PI * 7;

export interface HoldRevealOptions {
  post: HTMLElement;          // what Skip scrolls past
  reveal: () => void;         // platform-specific unblur
  isRevealed?: () => boolean;
}

export function attachHoldReveal(overlay: HTMLElement, opts: HoldRevealOptions): void {
  initCache();
  overlay.querySelector(HOLD_TAG)?.remove();

  const host = document.createElement(HOLD_TAG);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${STYLES}</style>
    <div class="chip">
      <svg class="ring" viewBox="0 0 18 18"><circle class="track" cx="9" cy="9" r="7"/><circle class="fill" cx="9" cy="9" r="7"/></svg>
      <span class="text">Hold to show</span>
      <button class="skip" type="button">Skip</button>
    </div>`;
  const text = root.querySelector('.text') as HTMLElement;
  const fill = root.querySelector('.fill') as SVGCircleElement;
  const skip = root.querySelector('.skip') as HTMLButtonElement;
  fill.style.strokeDasharray = String(CIRCUMFERENCE);
  fill.style.strokeDashoffset = String(CIRCUMFERENCE);
  // Overlays are absolutely positioned to fill the post, so size containment is safe
  overlay.style.containerType = 'size';
  overlay.style.containerName = 'tolerance-overlay';
  // Holding is allowed, so not the "not-allowed" cursor; no text selection mid-hold
  overlay.style.cursor = 'pointer';
  overlay.style.userSelect = 'none';
  overlay.appendChild(host);

  let holding = false;
  let finished = false;
  let startedAt = 0;
  let holdMs = 0;
  let frame = 0;
  let countdown: ReturnType<typeof setInterval> | null = null;
  let startX = 0;
  let startY = 0;

  const reset = () => {
    holding = false;
    cancelAnimationFrame(frame);
    if (countdown) clearInterval(countdown);
    host.classList.remove('holding');
    fill.style.strokeDashoffset = String(CIRCUMFERENCE);
    if (!finished) text.textContent = 'Hold to show';
  };

  const complete = () => {
    finished = true;
    reset();
    host.classList.add('done');
    text.textContent = 'Shown';
    swallowNextClick();
    recordReveal();
    logEvent('revealed', holdMs);
    opts.reveal();
  };

  const tick = () => {
    if (!holding) return;
    const progress = Math.min(1, (Date.now() - startedAt) / holdMs);
    fill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));
    if (progress >= 1) complete();
    else frame = requestAnimationFrame(tick);
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (finished || opts.isRevealed?.() || !e.isPrimary || e.button !== 0) return;
    if (e.composedPath().includes(skip)) return;
    e.preventDefault();
    e.stopPropagation();

    holdMs = holdSecondsFor(recentReveals, Date.now()) * 1000;
    holding = true;
    startedAt = Date.now();
    startX = e.clientX;
    startY = e.clientY;
    host.classList.add('holding');
    const secondsLeft = () => Math.max(1, Math.ceil((holdMs - (Date.now() - startedAt)) / 1000));
    text.textContent = `Keep holding · ${secondsLeft()}s`;
    countdown = setInterval(() => { text.textContent = `Keep holding · ${secondsLeft()}s`; }, 250);
    try { overlay.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    frame = requestAnimationFrame(tick);
  });

  const letGo = () => {
    if (!holding) return;
    const held = Date.now() - startedAt;
    reset();
    if (held > 300) logEvent('let-go', holdMs);
  };
  overlay.addEventListener('pointerup', letGo);
  overlay.addEventListener('pointercancel', letGo);
  overlay.addEventListener('lostpointercapture', letGo);
  // Dragging off the post (or a scroll gesture) counts as letting go
  overlay.addEventListener('pointermove', (e) => {
    if (holding && Math.hypot(e.clientX - startX, e.clientY - startY) > 24) letGo();
  });
  // Long-press menus on touch would interrupt the hold
  overlay.addEventListener('contextmenu', (e) => { if (holding) e.preventDefault(); });

  skip.addEventListener('pointerdown', (e) => e.stopPropagation());
  skip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    logEvent('skipped', holdSecondsFor(recentReveals, Date.now()) * 1000);
    text.textContent = 'Skipped';
    host.classList.add('done');
    finished = true;
    const bottom = opts.post.getBoundingClientRect().bottom;
    window.scrollBy({ top: Math.max(0, bottom - 72), behavior: 'smooth' });
  });
}

// For platforms that re-blur on mouse leave: a held reveal stays revealed
export function isHeldOpen(post: HTMLElement): boolean {
  return post.dataset.toleranceHeld === '1';
}

export function markHeldOpen(post: HTMLElement): void {
  post.dataset.toleranceHeld = '1';
}

export function clearHeldOpen(post: HTMLElement): void {
  delete post.dataset.toleranceHeld;
}
