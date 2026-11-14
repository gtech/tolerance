// The step-up card: once the first-week burst has passed, strictness goes from Default
// to Strict, announced by one card with a one-tap way back. It happens once. Going up
// is what happens if the person does nothing, because almost nobody moves a setting on
// their own and the stricter level is where the feed stops paying out.

export type StepUpOutcome = 'ok' | 'kept' | 'dismissed';

export interface StepUpState {
  shownAt?: number;
  outcome?: StepUpOutcome; // 'kept' = "Keep it where it is", back to Default
}

export const EMPTY_STEP_UP: StepUpState = {};

const DAY_MS = 24 * 60 * 60 * 1000;
export const STEP_UP_AFTER_DAYS = 10;
// Leave room after the week-one card so the two don't arrive back to back
export const STEP_UP_GAP_AFTER_WEEK_CARD_DAYS = 2;
export const STEP_UP_MIN_ACTIVE_DAYS = 3;
export const STEP_UP_FROM_LEVEL = 3; // Default
export const STEP_UP_TO_LEVEL = 4;   // Strict

export interface StepUpInputs {
  since: number | undefined;                    // install time
  now: number;
  strictness: { level: number; exact: boolean };
  activeDays: number;                           // days with real use in the last seven
  weekCardShownAt?: number;
}

export function stepUpDue(state: StepUpState, input: StepUpInputs): boolean {
  if (state.shownAt) return false;
  if (!input.since || input.now - input.since < STEP_UP_AFTER_DAYS * DAY_MS) return false;
  // Only someone still on the untouched Default. Anyone who turned it down, turned it
  // up or tuned the phases by hand has already chosen.
  if (!input.strictness.exact || input.strictness.level !== STEP_UP_FROM_LEVEL) return false;
  if (input.weekCardShownAt && input.now - input.weekCardShownAt < STEP_UP_GAP_AFTER_WEEK_CARD_DAYS * DAY_MS) return false;
  return input.activeDays >= STEP_UP_MIN_ACTIVE_DAYS;
}
