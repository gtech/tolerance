// Grounding break overlay: an invitation (never forced) to step out of the scroll
// for under a minute. Rendered in a shadow root so site CSS can't touch it.
// Used by every platform content script (via the heartbeat response) and by the
// dashboard's "Try it now" button.

const HOST_ID = 'tolerance-grounding-host';

type ExerciseId = 'breathing' | '54321' | 'feet';
type GroundingEvent = 'shown' | 'declined' | 'started' | 'completed' | 'closed-tab' | 'dismissed';

interface Exercise {
  id: ExerciseId;
  invite: string;
  run: (stage: HTMLElement, done: () => void) => () => void; // returns a cleanup fn
}

// ------------------------------------------------------------------
// Heartbeat integration
// ------------------------------------------------------------------

// Whether this page is a reasonable place to interrupt (not mid-video, not already showing)
export function groundingCanPrompt(): boolean {
  if (document.getElementById(HOST_ID)) return false;
  if (location.hostname.endsWith('youtube.com') && location.pathname.startsWith('/watch')) return false;
  return true;
}

export function heartbeatMessage(): { type: 'SOCIAL_MEDIA_HEARTBEAT'; canPrompt: boolean } {
  return { type: 'SOCIAL_MEDIA_HEARTBEAT', canPrompt: groundingCanPrompt() };
}

export function handleHeartbeatResponse(response: unknown): void {
  const grounding = (response as { grounding?: { minutes: number } } | undefined)?.grounding;
  if (grounding && groundingCanPrompt()) {
    showGroundingInvite(grounding.minutes);
  }
}

function logEvent(event: GroundingEvent, exercise?: ExerciseId): void {
  try {
    chrome.runtime.sendMessage({ type: 'GROUNDING_EVENT', event, exercise, host: location.hostname }, () => {
      if (chrome.runtime.lastError) { /* silent */ }
    });
  } catch {
    // Extension context lost
  }
}

// ------------------------------------------------------------------
// Exercises
// ------------------------------------------------------------------

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const breathing: Exercise = {
  id: 'breathing',
  invite: 'Take three slow breaths with me?',
  run(stage, done) {
    const circle = el('div', 'breath-circle');
    const label = el('div', 'prompt', 'Get comfortable');
    const count = el('div', 'sub', '');
    stage.append(circle, label, count);

    const steps: { text: string; ms: number; scale: number }[] = [];
    for (let i = 0; i < 3; i++) {
      steps.push({ text: 'Breathe in…', ms: 4000, scale: 1 });
      steps.push({ text: 'Hold', ms: 2000, scale: 1 });
      steps.push({ text: 'Breathe out…', ms: 6000, scale: 0.45 });
    }

    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= steps.length) { done(); return; }
      const step = steps[i];
      label.textContent = step.text;
      count.textContent = `Breath ${Math.floor(i / 3) + 1} of 3`;
      circle.style.transitionDuration = `${step.ms}ms`;
      circle.style.transform = `scale(${step.scale})`;
      i++;
      timer = setTimeout(next, step.ms);
    };
    circle.style.transform = 'scale(0.45)';
    timer = setTimeout(next, 1500);
    return () => clearTimeout(timer);
  },
};

const fiveFourThree: Exercise = {
  id: '54321',
  invite: 'Try a quick 5-4-3-2-1 to come back to the room?',
  run(stage, done) {
    const steps = [
      ['5', 'Look around. Find five things you can see.'],
      ['4', 'Notice four things you can feel: your clothes, the chair, the air.'],
      ['3', 'Listen for three things you can hear.'],
      ['2', 'Notice two things you can smell.'],
      ['1', 'Notice one thing you can taste.'],
    ];
    const big = el('div', 'big-number');
    const label = el('div', 'prompt');
    const button = el('button', 'btn primary', 'Next') as HTMLButtonElement;
    stage.append(big, label, button);

    let i = 0;
    const show = () => {
      big.textContent = steps[i][0];
      label.textContent = steps[i][1];
      button.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    };
    button.addEventListener('click', () => {
      i++;
      if (i >= steps.length) done(); else show();
    });
    show();
    return () => {};
  },
};

const feet: Exercise = {
  id: 'feet',
  invite: 'Take thirty seconds to feel your feet on the ground?',
  run(stage, done) {
    const steps: [string, number][] = [
      ['Put both feet flat on the floor.', 5000],
      ['Press down gently. Feel the floor pushing back.', 7000],
      ['Notice the weight of your body in the chair.', 7000],
      ['Let your shoulders drop. Unclench your jaw.', 7000],
      ['One slow breath out.', 6000],
    ];
    const label = el('div', 'prompt');
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-fill');
    bar.append(fill);
    stage.append(label, bar);

    const total = steps.reduce((sum, [, ms]) => sum + ms, 0);
    let elapsed = 0;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      if (i >= steps.length) { done(); return; }
      const [text, ms] = steps[i];
      label.textContent = text;
      elapsed += ms;
      fill.style.transitionDuration = `${ms}ms`;
      fill.style.width = `${(elapsed / total) * 100}%`;
      i++;
      timer = setTimeout(next, ms);
    };
    next();
    return () => clearTimeout(timer);
  },
};

const EXERCISES = [breathing, fiveFourThree, feet];

// ------------------------------------------------------------------
// Overlay
// ------------------------------------------------------------------

const STYLES = `
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(10, 12, 16, 0.55);
    backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    animation: fade 300ms ease;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .card {
    position: relative;
    width: min(420px, calc(100vw - 32px));
    background: #f7f5f0; color: #2b2b2b;
    border-radius: 18px; padding: 32px 28px 26px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.35);
    text-align: center; line-height: 1.5;
  }
  .close {
    position: absolute; top: 10px; right: 14px;
    background: none; border: none; font-size: 22px; color: #999; cursor: pointer;
  }
  .eyebrow { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #6f8f7f; margin-bottom: 8px; }
  .title { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
  .sub { font-size: 14px; color: #777; min-height: 21px; }
  .prompt { font-size: 18px; margin: 14px 0 8px; min-height: 54px; display: flex; align-items: center; justify-content: center; }
  .stage { display: flex; flex-direction: column; align-items: center; }
  .actions { display: flex; gap: 10px; justify-content: center; margin-top: 22px; flex-wrap: wrap; }
  .btn {
    font: inherit; font-size: 15px; padding: 10px 18px; border-radius: 10px; cursor: pointer;
    border: 1px solid #d4d0c8; background: #fff; color: #2b2b2b;
  }
  .btn.primary { background: #6f8f7f; border-color: #6f8f7f; color: #fff; }
  .btn:hover { filter: brightness(0.96); }
  .breath-circle {
    width: 140px; height: 140px; border-radius: 50%; margin: 6px auto 4px;
    background: radial-gradient(circle at 40% 35%, #b9d3c4, #6f8f7f);
    transition-property: transform; transition-timing-function: ease-in-out;
  }
  .big-number { font-size: 56px; font-weight: 300; color: #6f8f7f; line-height: 1; margin-top: 4px; }
  .progress { width: 100%; height: 6px; background: #e4e0d8; border-radius: 3px; overflow: hidden; margin-top: 10px; }
  .progress-fill { height: 100%; width: 0; background: #6f8f7f; transition-property: width; transition-timing-function: linear; }
`;

function pauseVideos(): void {
  document.querySelectorAll('video').forEach(v => { if (!v.paused) v.pause(); });
}

export function showGroundingInvite(minutes?: number, options: { preview?: boolean } = {}): void {
  if (document.getElementById(HOST_ID)) return;

  const exercise = EXERCISES[Math.floor(Math.random() * EXERCISES.length)];
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLES;
  const backdrop = el('div', 'backdrop');
  const card = el('div', 'card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  backdrop.append(card);
  root.append(style, backdrop);
  document.documentElement.append(host);

  let cleanup: () => void = () => {};
  const close = (event: GroundingEvent) => {
    cleanup();
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    if (!options.preview) logEvent(event, exercise.id);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); close('dismissed'); }
  };
  document.addEventListener('keydown', onKey, true);

  const closeBtn = el('button', 'close', '×');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => close('dismissed'));

  const render = (...children: HTMLElement[]) => {
    card.replaceChildren(closeBtn, ...children);
  };

  // 1. Invitation
  const invite = () => {
    const eyebrow = el('div', 'eyebrow', 'Grounding break');
    const title = el('div', 'title', minutes
      ? `You've been scrolling for ${Math.round(minutes)} minutes.`
      : 'A short pause.');
    const sub = el('div', 'sub', exercise.invite);
    const actions = el('div', 'actions');
    const yes = el('button', 'btn primary', "Let's do it");
    const no = el('button', 'btn', 'Not now');
    yes.addEventListener('click', start);
    no.addEventListener('click', () => close('declined'));
    actions.append(yes, no);
    render(eyebrow, title, sub, actions);
    (yes as HTMLButtonElement).focus();
  };

  // 2. Exercise
  const start = () => {
    if (!options.preview) logEvent('started', exercise.id);
    pauseVideos();
    const stage = el('div', 'stage');
    render(stage);
    cleanup = exercise.run(stage, finish);
  };

  // 3. Afterwards: the user chooses, no judgement either way
  const finish = () => {
    cleanup = () => {};
    if (!options.preview) logEvent('completed', exercise.id);
    const title = el('div', 'title', 'Welcome back.');
    const sub = el('div', 'sub', 'Carry on, or call it here. Either is fine.');
    const actions = el('div', 'actions');
    const back = el('button', 'btn', 'Back to the feed');
    const done = el('button', 'btn primary', "I'm done for now");
    back.addEventListener('click', () => close('dismissed'));
    done.addEventListener('click', () => {
      if (options.preview) { close('dismissed'); return; }
      logEvent('closed-tab', exercise.id);
      cleanup();
      host.remove();
      document.removeEventListener('keydown', onKey, true);
      try {
        chrome.runtime.sendMessage({ type: 'CLOSE_CURRENT_TAB' }, () => {
          if (chrome.runtime.lastError) { /* silent */ }
        });
      } catch {
        // Extension context lost
      }
    });
    actions.append(back, done);
    render(title, sub, actions);
  };

  if (!options.preview) logEvent('shown', exercise.id);
  invite();
}
