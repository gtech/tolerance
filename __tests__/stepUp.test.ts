import { describe, it, expect } from 'vitest';
import { EMPTY_STEP_UP, stepUpDue, StepUpInputs, STEP_UP_AFTER_DAYS } from '../src/shared/step-up';
import { strictnessThresholds, thresholdsToStrictness } from '../src/shared/constants';

const DAY = 24 * 60 * 60 * 1000;
const installedAt = 1_000_000_000_000;

function input(over: Partial<StepUpInputs> = {}): StepUpInputs {
  return {
    since: installedAt,
    now: installedAt + STEP_UP_AFTER_DAYS * DAY,
    strictness: { level: 3, exact: true },
    activeDays: 5,
    ...over,
  };
}

describe('step-up card', () => {
  it('is due ten days in for someone still on Default who has been using it', () => {
    expect(stepUpDue(EMPTY_STEP_UP, input())).toBe(true);
  });

  it('waits for day ten and needs an install time', () => {
    expect(stepUpDue(EMPTY_STEP_UP, input({ now: installedAt + 9.9 * DAY }))).toBe(false);
    expect(stepUpDue(EMPTY_STEP_UP, input({ since: undefined }))).toBe(false);
  });

  it('happens once, whatever was done with it', () => {
    expect(stepUpDue({ shownAt: installedAt + 10 * DAY }, input({ now: installedAt + 60 * DAY }))).toBe(false);
    expect(stepUpDue({ shownAt: installedAt + 10 * DAY, outcome: 'kept' }, input({ now: installedAt + 60 * DAY }))).toBe(false);
  });

  it('leaves alone anyone who has already chosen a level', () => {
    expect(stepUpDue(EMPTY_STEP_UP, input({ strictness: { level: 2, exact: true } }))).toBe(false);
    expect(stepUpDue(EMPTY_STEP_UP, input({ strictness: { level: 4, exact: true } }))).toBe(false);
    // Phases tuned by hand, closest to Default
    expect(stepUpDue(EMPTY_STEP_UP, input({ strictness: { level: 3, exact: false } }))).toBe(false);
  });

  it('does not follow straight after the week-one card', () => {
    const now = installedAt + 14 * DAY;
    expect(stepUpDue(EMPTY_STEP_UP, input({ now, weekCardShownAt: now - 1 * DAY }))).toBe(false);
    expect(stepUpDue(EMPTY_STEP_UP, input({ now, weekCardShownAt: now - 2 * DAY }))).toBe(true);
  });

  it('waits for someone who has barely used it', () => {
    expect(stepUpDue(EMPTY_STEP_UP, input({ activeDays: 2 }))).toBe(false);
  });

  it('moves between two real presets', () => {
    expect(thresholdsToStrictness(strictnessThresholds(3))).toEqual({ level: 3, exact: true });
    expect(thresholdsToStrictness(strictnessThresholds(4))).toEqual({ level: 4, exact: true });
  });
});
