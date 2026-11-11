// Decides when a feed tab shows the week-one card (see shared/week-review.ts) and
// gathers the numbers it shows.

import {
  EMPTY_WEEK_REVIEW,
  WeekReviewOutcome,
  WeekReviewState,
  WeekSummary,
  summarizeWeek,
  weekReviewDue,
} from '../shared/week-review';
import { getSessionsInRange, getState, getUsageDays } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;
// The card can only be due once a day's numbers change, so don't recompute on every heartbeat
const CHECK_EVERY_MS = 30 * 60 * 1000;
let nextCheckAt = 0;

export interface WeekCardInfo {
  summary: WeekSummary;
  seen: number;      // posts shown on feeds over the week
  blurred: number;   // how many of those were blurred
  preview?: boolean; // dashboard preview: nothing is recorded
}

async function loadState(): Promise<WeekReviewState> {
  const { weekReview } = await chrome.storage.local.get('weekReview');
  return (weekReview as WeekReviewState | undefined) ?? EMPTY_WEEK_REVIEW;
}

async function installTime(): Promise<number | undefined> {
  const { installedAt } = await chrome.storage.local.get('installedAt');
  if (installedAt) return installedAt as number;
  // Installs from before installedAt existed: the baseline start is the closest thing
  return (await getState()).baselineStartDate || undefined;
}

async function countPosts(now: number): Promise<{ seen: number; blurred: number }> {
  const start = now - 7 * DAY_MS;
  // A session that began before the window can still hold posts inside it
  const sessions = await getSessionsInRange(start - DAY_MS, now);
  let seen = 0;
  let blurred = 0;
  for (const session of sessions) {
    for (const post of session.posts ?? []) {
      if (post.timestamp < start) continue;
      seen++;
      if (post.blurred) blurred++;
    }
  }
  return { seen, blurred };
}

export async function buildWeekCard(now = Date.now()): Promise<WeekCardInfo> {
  const [days, posts] = await Promise.all([getUsageDays(8), countPosts(now)]);
  return { summary: summarizeWeek(days), ...posts };
}

// Called on each heartbeat. Hands the card to the first tab that can show it.
export async function takeWeekCard(canPrompt: boolean): Promise<WeekCardInfo | null> {
  const now = Date.now();
  if (!canPrompt || now < nextCheckAt) return null;
  nextCheckAt = now + CHECK_EVERY_MS;

  const [state, since] = await Promise.all([loadState(), installTime()]);
  // Cheap checks first: most heartbeats stop here without reading any history
  if (!since || now - since < 7 * DAY_MS || state.shows >= 2) return null;

  const summary = summarizeWeek(await getUsageDays(8));
  if (!weekReviewDue(state, since, now, summary)) return null;

  await chrome.storage.local.set({
    weekReview: { shows: state.shows + 1, lastShownAt: now } satisfies WeekReviewState,
  });
  return { summary, ...(await countPosts(now)) };
}

export async function recordWeekOutcome(outcome: WeekReviewOutcome): Promise<void> {
  const state = await loadState();
  await chrome.storage.local.set({ weekReview: { ...state, outcome } satisfies WeekReviewState });
}
