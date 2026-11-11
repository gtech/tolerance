// Hide mode on YouTube removes blurred videos from the page. The grid closes up, YouTube
// loads more videos to fill the screen, and each of those costs a score. With a strict
// threshold nearly everything is hidden, so the page keeps loading and scoring without end.
//
// The budget caps how many videos may be hidden in a rolling window. Past the cap a video
// is blurred in place instead: it takes up room, the screen fills, and YouTube stops loading.

export const HIDE_BUDGET_MAX = 60;
export const HIDE_BUDGET_WINDOW_MS = 5 * 60 * 1000;

export interface HideBudget {
  // True if this video may be hidden (and counts it); false once the window is full
  take(now: number): boolean;
  // Hides counted in the current window
  used(now: number): number;
}

export function createHideBudget(max = HIDE_BUDGET_MAX, windowMs = HIDE_BUDGET_WINDOW_MS): HideBudget {
  let times: number[] = [];
  const prune = (now: number) => {
    times = times.filter(t => now - t < windowMs);
  };
  return {
    take(now) {
      prune(now);
      if (times.length >= max) return false;
      times.push(now);
      return true;
    },
    used(now) {
      prune(now);
      return times.length;
    },
  };
}
