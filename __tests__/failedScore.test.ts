import { describe, it, expect } from 'vitest';
import {
  blursUnscored, describeFailedScore, nextUnscoredNotice,
  UNSCORED_NOTICE_FORGET_MS, UNSCORED_NOTICE_GAP_MS, UNSCORED_NOTICE_TIMES,
} from '../src/shared/failed-score';

describe('failed score notice', () => {
  it('sends someone on the hosted key to the account page, whatever went wrong', () => {
    const limit = describeFailedScore(false, true);
    expect(limit.text).toContain('go Pro');
    expect(limit.opens).toBe('account');

    const oneOff = describeFailedScore(false, false);
    expect(oneOff.text).not.toContain('go Pro');
    expect(oneOff.opens).toBe('account');
  });

  it('sends someone with their own key to the key setup, whatever went wrong', () => {
    for (const refused of [true, false]) {
      const notice = describeFailedScore(true, refused);
      expect(notice.text).toContain('Click here to check your key');
      expect(notice.opens).toBe('key-setup');
    }
    expect(describeFailedScore(true, true).text).toContain('spend limit');
    expect(describeFailedScore(true, false).text).not.toContain('spend limit');
  });

  it('includes the cause when there is one', () => {
    const notice = describeFailedScore(true, false, 'Scoring failed: Empty reply from some/model');
    expect(notice.text).toBe('This post could not be scored (Empty reply from some/model). Click here to check your key.');
  });
});

describe('posts that could not be scored', () => {
  it('are left unblurred unless the setting says otherwise', () => {
    expect(blursUnscored(null)).toBe(false);
    expect(blursUnscored({})).toBe(false);
    expect(blursUnscored({ blurUnscored: true })).toBe(true);
  });
});

describe('corner notice for unscored posts', () => {
  const T = 1_800_000_000_000;

  it('is shown the first time', () => {
    expect(nextUnscoredNotice(undefined, T)).toEqual({ times: 1, lastAt: T });
  });

  it('is not shown again in the same sitting', () => {
    expect(nextUnscoredNotice({ times: 1, lastAt: T }, T + UNSCORED_NOTICE_GAP_MS - 1)).toBeNull();
  });

  it('is shown a second time later, then no more', () => {
    const later = T + UNSCORED_NOTICE_GAP_MS + 1;
    expect(nextUnscoredNotice({ times: 1, lastAt: T }, later)).toEqual({ times: 2, lastAt: later });
    expect(nextUnscoredNotice({ times: UNSCORED_NOTICE_TIMES, lastAt: T }, later)).toBeNull();
  });

  it('starts over when the last one was long ago', () => {
    const muchLater = T + UNSCORED_NOTICE_FORGET_MS + 1;
    expect(nextUnscoredNotice({ times: UNSCORED_NOTICE_TIMES, lastAt: T }, muchLater)).toEqual({ times: 1, lastAt: muchLater });
  });
});
