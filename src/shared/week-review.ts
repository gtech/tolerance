// The week-one card: a week after install, one card on a feed shows how the person's
// time on feeds changed over that week and asks for a store rating or a conversation.
// Everyone sees the same two asks whichever way their numbers went.

import { averageMinutes, UsageDay } from './usage-history';

export type WeekReviewOutcome = 'rated' | 'call' | 'later' | 'dismissed';

export interface WeekReviewState {
  shows: number;              // how many times the card has been shown
  lastShownAt?: number;
  outcome?: WeekReviewOutcome; // what the person did with the last one
}

export const EMPTY_WEEK_REVIEW: WeekReviewState = { shows: 0 };

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_REVIEW_AFTER_DAYS = 7;
export const WEEK_REVIEW_RETRY_DAYS = 7;   // "Maybe later" gets one more ask, this long after
export const WEEK_REVIEW_MAX_SHOWS = 2;
export const WEEK_REVIEW_MIN_ACTIVE_DAYS = 3;
const ACTIVE_DAY_MINUTES = 1;
// Below this a "first three days" average is too small for a percentage to mean anything
const MIN_BASE_MINUTES = 5;
const STEADY_BAND = 0.1;

export interface WeekSummary {
  days: UsageDay[];            // the seven full days before today, oldest first
  activeDays: number;
  average: number;             // minutes a day over the tracked days
  early: number | null;        // first three days, minutes a day
  late: number | null;         // last three days
  change: number | null;       // (late - early) / early; null when it can't be compared
  trend: 'down' | 'steady' | 'up' | null;
}

// `days` ends today (as getUsageDays returns it); today is partial, so it is left out
export function summarizeWeek(days: UsageDay[]): WeekSummary {
  const week = days.slice(0, -1).slice(-7);
  const tracked = week.filter(d => d.minutes !== null);
  const activeDays = tracked.filter(d => (d.minutes ?? 0) >= ACTIVE_DAY_MINUTES).length;
  const average = tracked.length ? tracked.reduce((sum, d) => sum + (d.minutes ?? 0), 0) / tracked.length : 0;

  const early = week.length === 7 ? averageMinutes(week.slice(0, 3)) : null;
  const late = week.length === 7 ? averageMinutes(week.slice(4)) : null;
  const comparable = early !== null && late !== null && early >= MIN_BASE_MINUTES;
  const change = comparable ? (late - early) / early : null;
  const trend = change === null ? null : change <= -STEADY_BAND ? 'down' : change >= STEADY_BAND ? 'up' : 'steady';

  return { days: week, activeDays, average, early: comparable ? early : null, late: comparable ? late : null, change, trend };
}

// Whether to show the card now. `since` is the install time.
export function weekReviewDue(
  state: WeekReviewState,
  since: number | undefined,
  now: number,
  summary: WeekSummary
): boolean {
  if (!since || now - since < WEEK_REVIEW_AFTER_DAYS * DAY_MS) return false;
  if (state.shows >= WEEK_REVIEW_MAX_SHOWS) return false;
  if (state.shows > 0) {
    // Only "Maybe later" earns a second ask. A card that was shown but never answered
    // (tab closed) counts as later too.
    if (state.outcome && state.outcome !== 'later') return false;
    if (now - (state.lastShownAt ?? 0) < WEEK_REVIEW_RETRY_DAYS * DAY_MS) return false;
  }
  // Someone who has barely used it has nothing to say yet; wait until they have
  return summary.activeDays >= WEEK_REVIEW_MIN_ACTIVE_DAYS;
}
