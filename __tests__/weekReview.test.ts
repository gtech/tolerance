import { describe, it, expect } from 'vitest';
import {
  EMPTY_WEEK_REVIEW,
  summarizeWeek,
  weekReviewDue,
  WEEK_REVIEW_RETRY_DAYS,
} from '../src/shared/week-review';
import type { UsageDay } from '../src/shared/usage-history';

const DAY = 24 * 60 * 60 * 1000;
const installedAt = 1_000_000_000_000;

// Eight days ending today: seven full days, then today's partial figure
function days(minutes: (number | null)[], today = 999): UsageDay[] {
  return [...minutes, today].map((m, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, minutes: m }));
}

describe('week summary', () => {
  it('compares the first three days with the last three and leaves today out', () => {
    const summary = summarizeWeek(days([60, 60, 60, 50, 30, 30, 30]));
    expect(summary.days).toHaveLength(7);
    expect(summary.early).toBe(60);
    expect(summary.late).toBe(30);
    expect(summary.change).toBeCloseTo(-0.5);
    expect(summary.trend).toBe('down');
    expect(summary.activeDays).toBe(7);
  });

  it('calls a small move steady and a rise up', () => {
    expect(summarizeWeek(days([40, 40, 40, 40, 42, 42, 42])).trend).toBe('steady');
    expect(summarizeWeek(days([20, 20, 20, 40, 40, 40, 40])).trend).toBe('up');
  });

  it('makes no comparison when a day was not tracked or the start is tiny', () => {
    const untracked = summarizeWeek(days([null, null, 30, 30, 30, 30, 30]));
    expect(untracked.trend).toBeNull();
    expect(untracked.early).toBeNull();
    expect(untracked.average).toBe(30); // over the tracked days only
    expect(untracked.activeDays).toBe(5);

    const tiny = summarizeWeek(days([1, 2, 1, 30, 30, 30, 30]));
    expect(tiny.trend).toBeNull();
    expect(tiny.change).toBeNull();
  });

  it('counts only days with real use as active', () => {
    expect(summarizeWeek(days([0, 0, 0.4, 0, 25, 0, 12])).activeDays).toBe(2);
  });
});

describe('when the week-one card is due', () => {
  const used = summarizeWeek(days([60, 60, 60, 50, 30, 30, 30]));
  const barelyUsed = summarizeWeek(days([0, 0, 0, 0, 25, 0, 12]));

  it('waits a full week after install', () => {
    expect(weekReviewDue(EMPTY_WEEK_REVIEW, installedAt, installedAt + 6.9 * DAY, used)).toBe(false);
    expect(weekReviewDue(EMPTY_WEEK_REVIEW, installedAt, installedAt + 7 * DAY, used)).toBe(true);
  });

  it('never shows without an install time', () => {
    expect(weekReviewDue(EMPTY_WEEK_REVIEW, undefined, installedAt + 30 * DAY, used)).toBe(false);
  });

  it('holds off for someone who has barely used it', () => {
    expect(weekReviewDue(EMPTY_WEEK_REVIEW, installedAt, installedAt + 8 * DAY, barelyUsed)).toBe(false);
  });

  it('asks once more after "Maybe later", a week on, and never a third time', () => {
    const shownAt = installedAt + 7 * DAY;
    const later = { shows: 1, lastShownAt: shownAt, outcome: 'later' as const };
    expect(weekReviewDue(later, installedAt, shownAt + (WEEK_REVIEW_RETRY_DAYS - 1) * DAY, used)).toBe(false);
    expect(weekReviewDue(later, installedAt, shownAt + WEEK_REVIEW_RETRY_DAYS * DAY, used)).toBe(true);
    expect(weekReviewDue({ ...later, shows: 2 }, installedAt, shownAt + 60 * DAY, used)).toBe(false);
  });

  it('treats a card that was shown but never answered like "Maybe later"', () => {
    const unanswered = { shows: 1, lastShownAt: installedAt + 7 * DAY };
    expect(weekReviewDue(unanswered, installedAt, installedAt + 15 * DAY, used)).toBe(true);
  });

  it('does not ask again after a rating, a call or a dismissal', () => {
    for (const outcome of ['rated', 'call', 'dismissed'] as const) {
      const state = { shows: 1, lastShownAt: installedAt + 7 * DAY, outcome };
      expect(weekReviewDue(state, installedAt, installedAt + 60 * DAY, used)).toBe(false);
    }
  });
});
