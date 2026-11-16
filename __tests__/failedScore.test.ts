import { describe, it, expect } from 'vitest';
import { describeFailedScore } from '../src/shared/failed-score';

describe('failed score notice', () => {
  it('points free users at the account page only when the allowance is the problem', () => {
    const limit = describeFailedScore(false, true);
    expect(limit.text).toContain('Free tier exhausted');
    expect(limit.opensAccount).toBe(true);

    const oneOff = describeFailedScore(false, false);
    expect(oneOff.text).not.toContain('Free tier');
    expect(oneOff.text).toContain('your key and allowance are fine');
    expect(oneOff.opensAccount).toBe(false);
  });

  it('tells someone with their own key to check it only when it was refused', () => {
    expect(describeFailedScore(true, true).text).toContain('spend limit');
    expect(describeFailedScore(true, true).opensAccount).toBe(false);
    expect(describeFailedScore(true, false).text).not.toContain('spend limit');
  });

  it('includes the cause when there is one', () => {
    const notice = describeFailedScore(false, false, 'Scoring failed: Empty reply from some/model');
    expect(notice.text).toBe('This post could not be scored (Empty reply from some/model). One request failed; your key and allowance are fine.');
  });
});
