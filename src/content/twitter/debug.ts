// "Tolerance: debug this post" (right-click menu). Builds a plain-text report of
// what the extension saw for one tweet: its score state, what the reply/quote
// detector found, and the layout around the avatar column of this cell and the
// cells above it. The thread detector is geometric, so the layout is what's
// needed to see why a reply wasn't linked to its parent.

import { EngagementScore } from '../../shared/types';
import { anchorCacheId } from '../../shared/anchor-utils';
import { parseTweetElement, inQuotedTweet } from './scraper';

export interface DebugState {
  processed: boolean;
  anchorSent?: string;
  contentScore?: EngagementScore;
  blurDecision?: string;     // How the blur threshold was applied to this post
}

const PANEL_ID = 'tolerance-debug-panel';

function short(text: string | null | undefined, n = 60): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function scoreSummary(s: EngagementScore | null | undefined): string {
  if (!s) return 'none';
  const age = Math.round((Date.now() - s.timestamp) / 60000);
  const parts = [`${s.apiScore} (${s.bucket})`, `"${short(s.apiReason, 80)}"`, `${age}m old`];
  if (s.scoreFailed) parts.push('FAILED');
  if (s.whitelisted) parts.push('trusted');
  if (s.imageSeen !== undefined) parts.push(s.imageSeen ? 'image seen' : 'IMAGE NOT SEEN (text only)');
  if (s.preFloorScore !== undefined) parts.push(`before video floor: ${s.preFloorScore}`);
  if (s.anchor) parts.push(`anchor=@${s.anchor.author} ${s.anchor.kind} ${s.anchor.score}, own=${s.anchor.ownScore}`);
  return parts.join(' | ');
}

// Each video/photo/link card in the tweet and whether it was counted as the main
// tweet's or the quoted tweet's
function describeMedia(article: HTMLElement): string {
  const found = [...article.querySelectorAll('[data-testid="videoPlayer"], [data-testid="tweetPhoto"], [data-testid="card.wrapper"]')]
    .map(el => `${el.getAttribute('data-testid')}:${inQuotedTweet(article, el) ? 'quoted' : 'main'}`);
  return found.length ? found.join(' ') : 'none';
}

function describeCell(cell: Element | null): string {
  if (!cell) return 'none';
  const article = cell.querySelector<HTMLElement>('article[data-testid="tweet"]');
  if (!article) {
    const testids = [...cell.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')).slice(0, 6);
    return `no tweet; testids=[${testids.join(',')}] text="${short(cell.textContent, 50)}"`;
  }
  const t = parseTweetElement(article);
  return t ? `tweet ${t.id} @${t.author} "${short(t.text, 40)}"` : 'tweet (unparseable)';
}

// Elements in the avatar column of an article, with geometry relative to the avatar
function avatarColumn(article: HTMLElement | null, label: string): string[] {
  if (!article) return [`${label}: no article`];
  const avatar = article.querySelector<HTMLElement>('[data-testid="Tweet-User-Avatar"]');
  if (!avatar) return [`${label}: no Tweet-User-Avatar`];
  const a = avatar.getBoundingClientRect();
  const center = a.left + a.width / 2;
  const lines = [`${label}: avatar ${Math.round(a.width)}x${Math.round(a.height)} at y=${Math.round(a.top)}`];

  let count = 0;
  for (const el of article.querySelectorAll<HTMLElement>('*')) {
    if (avatar.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // Anything overlapping the avatar's column, narrower than the avatar
    if (r.right < a.left - 4 || r.left > a.right + 4 || r.width > a.width + 8) continue;
    const cs = getComputedStyle(el);
    const narrow = r.width <= 4 && r.height >= 4 && Math.abs(r.left + r.width / 2 - center) <= 4;
    const pos = r.bottom <= a.top + 2 ? 'above' : r.top >= a.bottom - 2 ? 'below' : 'beside';
    const testid = el.getAttribute('data-testid');
    lines.push(
      `  ${narrow ? '*' : ' '} <${el.tagName.toLowerCase()}${testid ? ` ${testid}` : ''}> ` +
      `${Math.round(r.width)}x${Math.round(r.height)} dx=${Math.round(r.left + r.width / 2 - center)} ` +
      `y=${Math.round(r.top - a.top)} ${pos}` +
      (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? ` bg=${cs.backgroundColor}` : '') +
      (cs.borderLeftWidth !== '0px' ? ` borderL=${cs.borderLeftWidth}` : '') +
      (cs.borderRightWidth !== '0px' ? ` borderR=${cs.borderRightWidth}` : '')
    );
    if (++count >= 40) { lines.push('  …'); break; }
  }
  return lines;
}

export async function buildDebugReport(
  target: HTMLElement,
  state: (tweetId: string) => DebugState
): Promise<string> {
  const cell = target.closest('[data-testid="cellInnerDiv"]');
  const article = cell?.querySelector<HTMLElement>('article[data-testid="tweet"]');
  if (!cell || !article) return 'Tolerance debug: no tweet found where you right-clicked.';

  const tweet = parseTweetElement(article);
  if (!tweet) return 'Tolerance debug: could not parse this tweet.';
  const st = state(tweet.id);
  const anchorId = tweet.anchor ? anchorCacheId(tweet.anchor) : undefined;

  let records: Record<string, EngagementScore | null> = {};
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DEBUG_SCORE_RECORDS', ids: anchorId ? [tweet.id, anchorId] : [tweet.id] });
    records = res?.records ?? {};
  } catch { /* extension context lost */ }

  const lines: string[] = [
    'Tolerance debug report',
    `page: ${location.pathname}  viewport: ${innerWidth}x${innerHeight}  time: ${new Date().toISOString()}`,
    '',
    `tweet: ${tweet.id} @${tweet.author} "${short(tweet.text)}"`,
    `media: ${tweet.mediaType}  retweet: ${tweet.isRetweet}  quote: ${tweet.isQuoteTweet ? `@${tweet.quotedTweet?.author}` : 'no'}`,
    `media found: ${describeMedia(article)}`,
    `"Replying to": ${tweet.isReply ? `yes (@${tweet.replyToAuthor ?? '?'})` : 'no'}`,
    `anchor now: ${tweet.anchor ? `${tweet.anchor.kind} @${tweet.anchor.author} id=${tweet.anchor.id ?? '-'} key=${anchorId}` : 'NONE'}`,
    `processed: ${st.processed}  anchor last sent: ${st.anchorSent ?? 'never'}`,
    `cell classes: ${cell.className || '-'}  badge: ${cell.querySelector('.tolerance-score-badge')?.textContent ?? 'none'}`,
    '',
    `score on page:  ${scoreSummary(st.contentScore)}`,
    `score in cache: ${scoreSummary(records[tweet.id])}`,
    `blur decision: ${st.blurDecision ?? 'unknown'}`,
    ...(anchorId ? [`anchor in cache: ${scoreSummary(records[anchorId])}`] : []),
    '',
    'cells above:',
  ];

  let prev = cell.previousElementSibling;
  for (let i = 1; i <= 3 && prev; i++, prev = prev.previousElementSibling) {
    lines.push(`  -${i}: ${describeCell(prev)}`);
  }
  lines.push(`  next: ${describeCell(cell.nextElementSibling)}`);
  lines.push('');
  lines.push('avatar column (* = counts as connector line):');
  lines.push(...avatarColumn(article, 'this'));
  let prevArticle: HTMLElement | null = null;
  prev = cell.previousElementSibling;
  for (let i = 0; i < 3 && prev && !prevArticle; i++, prev = prev.previousElementSibling) {
    prevArticle = prev.querySelector<HTMLElement>('article[data-testid="tweet"]');
  }
  lines.push(...avatarColumn(prevArticle, 'nearest tweet above'));

  return lines.join('\n');
}

export function showDebugReport(report: string): void {
  document.getElementById(PANEL_ID)?.remove();
  const host = document.createElement('div');
  host.id = PANEL_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      .panel { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: min(640px, calc(100vw - 32px));
        background: #fff; color: #222; border: 1px solid #ccc; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.3);
        font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 12px; }
      textarea { width: 100%; height: 320px; box-sizing: border-box; font: 11px ui-monospace, Menlo, monospace; white-space: pre; }
      .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; align-items: center; }
      .row span { margin-right: auto; color: #666; }
      button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #bbb; background: #f4f4f4; cursor: pointer; }
      button.primary { background: #1d9bf0; border-color: #1d9bf0; color: #fff; }
    </style>
    <div class="panel">
      <textarea readonly></textarea>
      <div class="row"><span></span><button class="primary">Copy</button><button class="close">Close</button></div>
    </div>`;
  const textarea = root.querySelector('textarea')!;
  const status = root.querySelector('.row span')!;
  textarea.value = report;
  root.querySelector('button.primary')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      textarea.select();
      document.execCommand('copy');
    }
    status.textContent = 'Copied';
  });
  root.querySelector('button.close')!.addEventListener('click', () => host.remove());
  document.documentElement.append(host);
  console.log(report);
}
