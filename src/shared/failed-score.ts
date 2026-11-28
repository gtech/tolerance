// What happens when a post can't be scored. A score can fail because the key hit a
// limit (allowance used up, key rejected) or because one request went wrong (the
// model's provider was busy, the reply was unreadable).
//
// A post without a score is left unblurred, so Tolerance can stay installed while
// someone decides what to do about their scoring; Settings.blurUnscored turns that
// round for anyone who would sooner see nothing than see it unfiltered.

export const ACCOUNT_URL = 'https://tolerance.lol/account.html';

export interface FailedScoreNotice {
  text: string;
  opensAccount: boolean; // clicking the "?" badge opens the account page
}

export function describeFailedScore(ownKey: boolean, keyProblem: boolean, reason?: string): FailedScoreNotice {
  if (keyProblem) {
    return ownKey
      ? { text: 'Your API key was refused. Check its spend limit and credits in the dashboard.', opensAccount: false }
      : { text: 'Free credits used up. Click to go Pro, or use your own API key.', opensAccount: true };
  }
  const detail = (reason ?? '').replace(/^Scoring failed:\s*/, '').trim();
  const what = `This post could not be scored${detail ? ` (${detail})` : ''}.`;
  // The account page is no help to someone scoring with their own key
  return ownKey
    ? { text: `${what} One request failed; your key is fine.`, opensAccount: false }
    : { text: `${what} Click to open your account.`, opensAccount: true };
}

export function blursUnscored(settings: { blurUnscored?: boolean } | null | undefined): boolean {
  return settings?.blurUnscored === true;
}

// The corner notice shown once more than this many posts on a page went unscored
export const UNSCORED_BEFORE_NOTICE = 5;
// It is shown the first couple of times only, and not twice in one sitting
export const UNSCORED_NOTICE_TIMES = 2;
export const UNSCORED_NOTICE_GAP_MS = 12 * 60 * 60 * 1000;
// Long enough after the last one, it counts as a new problem and is shown again
export const UNSCORED_NOTICE_FORGET_MS = 30 * 24 * 60 * 60 * 1000;

export interface UnscoredNoticeRecord {
  times: number;
  lastAt: number;
}

// The record to store if the notice should be shown now, or null if it should not
export function nextUnscoredNotice(record: UnscoredNoticeRecord | undefined, now: number): UnscoredNoticeRecord | null {
  const fresh = !record || now - record.lastAt > UNSCORED_NOTICE_FORGET_MS;
  const times = fresh ? 0 : record.times;
  if (times >= UNSCORED_NOTICE_TIMES) return null;
  if (!fresh && now - record.lastAt < UNSCORED_NOTICE_GAP_MS) return null;
  return { times: times + 1, lastAt: now };
}
