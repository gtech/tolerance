// Decides when a feed tab shows the step-up card (see shared/step-up.ts). The tab that
// shows the card is the one that changes the setting, so strictness never moves
// without the card that announces it.

import { EMPTY_STEP_UP, StepUpOutcome, StepUpState, stepUpDue, STEP_UP_AFTER_DAYS } from '../shared/step-up';
import { summarizeWeek, WeekReviewState } from '../shared/week-review';
import { readStrictness } from '../shared/strictness-settings';
import { getState, getUsageDays } from './storage';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 30 * 60 * 1000;
let nextCheckAt = 0;

export interface StepUpCardInfo {
  preview?: boolean; // dashboard preview: nothing is changed or recorded
}

// Called on each heartbeat. Hands the card to the first tab that can show it.
export async function takeStepUpCard(canPrompt: boolean): Promise<StepUpCardInfo | null> {
  const now = Date.now();
  if (!canPrompt || now < nextCheckAt) return null;
  nextCheckAt = now + CHECK_EVERY_MS;

  const stored = await chrome.storage.local.get(['stepUp', 'installedAt', 'weekReview']);
  const state = (stored.stepUp as StepUpState | undefined) ?? EMPTY_STEP_UP;
  const since = (stored.installedAt as number | undefined) ?? ((await getState()).baselineStartDate || undefined);
  // Cheap checks first: most heartbeats stop here without reading any history
  if (state.shownAt || !since || now - since < STEP_UP_AFTER_DAYS * DAY_MS) return null;

  const due = stepUpDue(state, {
    since,
    now,
    strictness: await readStrictness(),
    activeDays: summarizeWeek(await getUsageDays(8)).activeDays,
    weekCardShownAt: (stored.weekReview as WeekReviewState | undefined)?.lastShownAt,
  });
  if (!due) return null;

  await chrome.storage.local.set({ stepUp: { shownAt: now } satisfies StepUpState });
  return {};
}

export async function recordStepUpOutcome(outcome: StepUpOutcome): Promise<void> {
  const { stepUp } = await chrome.storage.local.get('stepUp');
  const state = (stepUp as StepUpState | undefined) ?? EMPTY_STEP_UP;
  await chrome.storage.local.set({ stepUp: { ...state, outcome } satisfies StepUpState });
}
