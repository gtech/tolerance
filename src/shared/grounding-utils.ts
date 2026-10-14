// Grounding breaks: every N minutes of continuous scrolling, invite the user into
// a short grounding exercise (breathing, 5-4-3-2-1, feet on the floor).
// "Continuous" = heartbeats with no break longer than GROUNDING_BREAK_RESET_MS.

export interface GroundingState {
  sittingMinutes: number;   // Scrolling time since the last prompt or real break
  lastHeartbeat: number;
}

export interface GroundingSettings {
  enabled: boolean;
  intervalMinutes: number;
}

export const DEFAULT_GROUNDING: GroundingSettings = { enabled: true, intervalMinutes: 20 };

// Gaps up to this long count as scrolling time (heartbeats are every 30s)
export const GROUNDING_HEARTBEAT_GAP_MS = 2 * 60 * 1000;
// A break at least this long starts a fresh sitting
export const GROUNDING_BREAK_RESET_MS = 5 * 60 * 1000;

export function advanceGrounding(
  state: GroundingState,
  now: number,
  intervalMinutes: number,
  canPrompt: boolean
): { state: GroundingState; prompt: boolean } {
  const gap = now - state.lastHeartbeat;
  let sitting = state.sittingMinutes;

  if (gap >= GROUNDING_BREAK_RESET_MS) {
    sitting = 0;
  } else if (gap <= GROUNDING_HEARTBEAT_GAP_MS) {
    sitting += gap / 60_000;
  }
  // Gaps in between: brief pause, neither counted nor reset

  let prompt = false;
  if (canPrompt && sitting >= intervalMinutes) {
    prompt = true;
    sitting = 0;
  }

  return { state: { sittingMinutes: sitting, lastHeartbeat: now }, prompt };
}
