import { describe, it, expect } from 'vitest';
import {
  noteBurstSignal,
  EMPTY_BURST_STATE,
  BURST_REVEAL_THRESHOLD,
  BURST_REVEAL_WINDOW_MS,
  BURST_SETUP_GRACE_MS,
  BURST_WINDOW_DAYS,
} from '../src/shared/burst-utils';

const DAY = 24 * 60 * 60 * 1000;
const installedAt = 1_000_000_000_000;
const day2 = installedAt + DAY;

function reveals(count: number, start: number, gapMs: number) {
  let state = EMPTY_BURST_STATE;
  for (let i = 0; i < count; i++) state = noteBurstSignal(state, 'reveals', start + i * gapMs, installedAt);
  return state;
}

describe('first-week burst card', () => {
  it('triggers after a run of reveals inside the window', () => {
    expect(reveals(BURST_REVEAL_THRESHOLD - 1, day2, 60_000).pending).toBeNull();
    expect(reveals(BURST_REVEAL_THRESHOLD, day2, 60_000).pending).toBe('reveals');
  });

  it('does not trigger when reveals are spread out', () => {
    const gap = BURST_REVEAL_WINDOW_MS / (BURST_REVEAL_THRESHOLD - 1) + 1000;
    expect(reveals(BURST_REVEAL_THRESHOLD * 3, day2, gap).pending).toBeNull();
  });

  it('triggers when strictness is lowered after the setup grace period', () => {
    expect(noteBurstSignal(EMPTY_BURST_STATE, 'lowered', day2, installedAt).pending).toBe('lowered');
  });

  it('ignores lowering right after install (welcome page choice)', () => {
    const t = installedAt + BURST_SETUP_GRACE_MS - 1000;
    expect(noteBurstSignal(EMPTY_BURST_STATE, 'lowered', t, installedAt).pending).toBeNull();
  });

  it('does nothing after the first week or without an install date', () => {
    const late = installedAt + BURST_WINDOW_DAYS * DAY + 1;
    expect(noteBurstSignal(EMPTY_BURST_STATE, 'lowered', late, installedAt).pending).toBeNull();
    expect(noteBurstSignal(EMPTY_BURST_STATE, 'lowered', day2, undefined).pending).toBeNull();
  });

  it('never triggers again once shown', () => {
    const shown = { ...EMPTY_BURST_STATE, shown: true };
    expect(noteBurstSignal(shown, 'lowered', day2, installedAt)).toBe(shown);
  });

  it('keeps the first trigger', () => {
    const fromReveals = reveals(BURST_REVEAL_THRESHOLD, day2, 1000);
    expect(noteBurstSignal(fromReveals, 'lowered', day2 + 10_000, installedAt).pending).toBe('reveals');
  });
});
