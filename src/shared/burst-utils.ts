// First-week "extinction burst" card. When the feed stops paying off, the urge to
// scroll and dig usually gets stronger before it fades, and people read that as
// the extension being annoying. In the first week after install, when signs of
// that show up, the feed shows one card naming what's happening.

export type BurstTrigger = 'reveals' | 'lowered';

export interface BurstState {
  reveals: number[];            // timestamps of recent reveals
  pending: BurstTrigger | null; // waiting for a feed tab that can show it
  shown: boolean;               // shown once, never again
}

export const BURST_WINDOW_DAYS = 7;
export const BURST_REVEAL_WINDOW_MS = 10 * 60 * 1000;
export const BURST_REVEAL_THRESHOLD = 5;
// Picking Gentle on the welcome page isn't frustration, so lowering right after
// install doesn't count
export const BURST_SETUP_GRACE_MS = 30 * 60 * 1000;

export const EMPTY_BURST_STATE: BurstState = { reveals: [], pending: null, shown: false };

export function inBurstWindow(installedAt: number | undefined, now: number): boolean {
  return !!installedAt && now - installedAt < BURST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// Fold one signal into the state. Outside the first week, or once shown, nothing changes.
export function noteBurstSignal(
  state: BurstState,
  signal: BurstTrigger,
  now: number,
  installedAt: number | undefined
): BurstState {
  if (state.shown || !inBurstWindow(installedAt, now)) return state;

  if (signal === 'lowered') {
    if (now - installedAt! < BURST_SETUP_GRACE_MS) return state;
    return { ...state, pending: state.pending ?? 'lowered' };
  }

  const reveals = [...state.reveals.filter(t => now - t < BURST_REVEAL_WINDOW_MS), now];
  const pending = state.pending ?? (reveals.length >= BURST_REVEAL_THRESHOLD ? 'reveals' : null);
  return { ...state, reveals, pending };
}
