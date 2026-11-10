// How long to hold before a blurred post shows (see content/holdReveal.ts).
// Peeking once is cheap; a run of peeks gets more expensive. Reveals older
// than the window stop counting, so a break resets it.

export const REVEAL_WINDOW_MS = 30 * 60 * 1000;
export const HOLD_BASE_SECONDS = 2;
export const HOLD_STEP_SECONDS = 2;
export const HOLD_MAX_SECONDS = 10;

export function holdSecondsFor(revealTimes: number[], now: number): number {
  const recent = revealTimes.filter(t => now - t < REVEAL_WINDOW_MS).length;
  return Math.min(HOLD_MAX_SECONDS, HOLD_BASE_SECONDS + HOLD_STEP_SECONDS * recent);
}
