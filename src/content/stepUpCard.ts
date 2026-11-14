// The step-up card (see shared/step-up.ts): strictness goes from Default to Strict as
// this card appears, and one button puts it back. Same corner card as the others.

import type { StepUpCardInfo } from '../background/stepUp';
import { StepUpOutcome, STEP_UP_FROM_LEVEL, STEP_UP_TO_LEVEL } from '../shared/step-up';
import { saveStrictness } from '../shared/strictness-settings';
import { CARD_STYLES, el, send } from './burstCard';

const HOST_ID = 'tolerance-step-up-host';

const STEP_UP_STYLES = `
  .fine { color: #888; font-size: 12px; margin: 10px 0 0; }
`;

export function showStepUpCard(info: StepUpCardInfo): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_STYLES + STEP_UP_STYLES;
  const card = el('div', 'card');
  card.setAttribute('role', 'status');
  root.append(style, card);
  document.documentElement.append(host);

  // The change and its announcement go together: it is made here, as the card appears
  const raised = info.preview ? Promise.resolve() : saveStrictness(STEP_UP_TO_LEVEL).catch(() => {});

  const finish = (outcome: StepUpOutcome) => {
    host.remove();
    if (!info.preview) send({ type: 'STEP_UP_OUTCOME', outcome });
  };

  const closeBtn = el('button', 'close', '×');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => finish('dismissed'));

  const actions = el('div', 'actions');
  const ok = el('button', 'btn primary', 'OK');
  ok.addEventListener('click', () => finish('ok'));
  const keep = el('button', 'btn', 'Keep it where it is');
  keep.addEventListener('click', async () => {
    if (!info.preview) {
      await raised;
      await saveStrictness(STEP_UP_FROM_LEVEL).catch(() => {});
    }
    finish('kept');
  });
  actions.append(ok, keep);

  card.append(
    closeBtn,
    el('div', 'eyebrow', 'Tolerance · stepping up'),
    el('div', 'title', "You're past the hard part."),
    el('p', 'body', 'Tolerance is now one notch stricter. It blurs bait from the moment you open a feed, where before it waited until you had been scrolling a while.'),
    el('p', 'body', 'The less a feed pays out, the less there is to keep you on it.'),
    actions,
    el('p', 'fine', 'This happens once. You can change it any time from the toolbar icon.'),
  );
}
