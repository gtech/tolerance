// Week-one card (see shared/week-review.ts): the person's own numbers for the week, then
// two asks, a store rating or a conversation. Same corner card as the first-week one.

import type { WeekCardInfo } from '../background/weekReview';
import type { WeekReviewOutcome, WeekSummary } from '../shared/week-review';
import { formatMinutes } from '../shared/usage-chart';
import { CARD_STYLES, el, send } from './burstCard';

const HOST_ID = 'tolerance-week-host';

const CHROME_REVIEWS = 'https://chromewebstore.google.com/detail/pmnbipkkofbjeblbmhffdgaddaofgeag/reviews';
const FIREFOX_REVIEWS = 'https://addons.mozilla.org/firefox/addon/tolerancelol/reviews/';
const CALL_URL = 'https://calendly.com/wduncaniii';

// Gray only, like the usage chart: the card reports, it doesn't cheer
const WEEK_STYLES = `
  .stat { color: #2b2b2b; margin: 0 0 4px; }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 44px; margin: 12px 0 2px; border-bottom: 1px solid #d4d0c8; }
  .bar { flex: 1; min-height: 2px; background: #b9b5ab; border-radius: 2px 2px 0 0; }
  .bar.untracked { background: none; }
  .days { display: flex; gap: 4px; font-size: 10px; color: #999; margin-bottom: 12px; }
  .days span { flex: 1; text-align: center; }
  .ask { color: #555; margin: 0; }
  .later { background: none; border: none; color: #888; font: inherit; font-size: 13px; cursor: pointer; padding: 8px 4px; }
`;

function reviewsUrl(): string {
  let firefox = false;
  try {
    firefox = chrome.runtime.getURL('').startsWith('moz-extension://');
  } catch {
    // Extension context lost: the Chrome link is the safer guess
  }
  return firefox ? FIREFOX_REVIEWS : CHROME_REVIEWS;
}

function headline(summary: WeekSummary): string {
  if (summary.trend === 'down') return `A week in: ${Math.round(-summary.change! * 100)}% less time on feeds.`;
  if (summary.trend === 'up') return 'A week in: your time on feeds went up.';
  if (summary.trend === 'steady') return 'A week in: your time on feeds held steady.';
  return 'A week with Tolerance.';
}

function usageLine(summary: WeekSummary): string {
  if (summary.early !== null && summary.late !== null) {
    return `First three days: ${formatMinutes(summary.early)} a day. Last three: ${formatMinutes(summary.late)} a day.`;
  }
  return `${formatMinutes(summary.average)} a day on feeds this week.`;
}

function chart(summary: WeekSummary): HTMLElement[] {
  const max = Math.max(1, ...summary.days.map(d => d.minutes ?? 0));
  const bars = el('div', 'bars');
  const labels = el('div', 'days');
  for (const day of summary.days) {
    const bar = el('div', day.minutes === null ? 'bar untracked' : 'bar');
    bar.style.height = `${Math.round(((day.minutes ?? 0) / max) * 100)}%`;
    bar.title = day.minutes === null ? 'Not tracked yet' : formatMinutes(day.minutes);
    bars.append(bar);
    const [y, m, d] = day.date.split('-').map(Number);
    labels.append(el('span', '', new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'narrow' })));
  }
  return [bars, labels];
}

export function showWeekCard(info: WeekCardInfo): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CARD_STYLES + WEEK_STYLES;
  const card = el('div', 'card');
  card.setAttribute('role', 'status');
  root.append(style, card);
  document.documentElement.append(host);

  const finish = (outcome: WeekReviewOutcome) => {
    host.remove();
    if (!info.preview) send({ type: 'WEEK_REVIEW_OUTCOME', outcome });
  };
  const open = (url: string, outcome: WeekReviewOutcome) => {
    window.open(url, '_blank', 'noopener');
    finish(outcome);
  };

  const closeBtn = el('button', 'close', '×');
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', () => finish('dismissed'));

  const { summary } = info;
  card.append(
    closeBtn,
    el('div', 'eyebrow', 'Tolerance · one week'),
    el('div', 'title', headline(summary)),
    el('p', 'stat', usageLine(summary)),
  );
  if (info.seen > 0 && info.blurred > 0) {
    card.append(el('p', 'stat', `${info.blurred.toLocaleString()} of the ${info.seen.toLocaleString()} posts you scrolled past were blurred.`));
  }
  card.append(...chart(summary));

  // The same ask whichever way the numbers went
  const ask = summary.trend === 'up'
    ? 'Tolerance is built by one person. If it isn\'t doing what you hoped, I\'d like to hear why. And an honest rating helps other people decide.'
    : 'Tolerance is built by one person. An honest rating is the biggest help there is, and I\'d like to hear what isn\'t working.';
  card.append(el('p', 'ask', ask));

  const actions = el('div', 'actions');
  const rate = el('button', 'btn primary', 'Leave a rating');
  rate.addEventListener('click', () => open(reviewsUrl(), 'rated'));
  const call = el('button', 'btn', 'Talk to me');
  call.addEventListener('click', () => open(CALL_URL, 'call'));
  const later = el('button', 'later', 'Maybe later');
  later.addEventListener('click', () => finish('later'));
  actions.append(rate, call, later);
  card.append(actions);
}
