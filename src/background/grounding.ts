// Decides when to invite the user into a grounding break, based on continuous
// scrolling time across all social media tabs (see shared/grounding-utils.ts).

import { getSettings } from './storage';
import { advanceGrounding, GroundingState, DEFAULT_GROUNDING } from '../shared/grounding-utils';

const MAX_LOG_ENTRIES = 500;

export interface GroundingLogEntry {
  timestamp: number;
  event: string;
  exercise?: string;
  host?: string;
}

// Called on every social media heartbeat. Returns the sitting length (minutes)
// if the sending tab should show the invitation now, else null.
export async function checkGrounding(canPrompt: boolean): Promise<number | null> {
  const settings = await getSettings();
  const config = { ...DEFAULT_GROUNDING, ...settings.grounding };

  const stored = await chrome.storage.local.get('groundingState');
  const state = (stored.groundingState as GroundingState | undefined) ?? { sittingMinutes: 0, lastHeartbeat: 0 };

  const sittingBefore = state.sittingMinutes;
  const result = advanceGrounding(state, Date.now(), config.intervalMinutes, canPrompt && config.enabled);
  await chrome.storage.local.set({ groundingState: result.state });

  return result.prompt ? Math.max(sittingBefore, config.intervalMinutes) : null;
}

export async function logGroundingEvent(entry: Omit<GroundingLogEntry, 'timestamp'>): Promise<void> {
  const stored = await chrome.storage.local.get('groundingLog');
  const entries = (stored.groundingLog as GroundingLogEntry[] | undefined) ?? [];
  entries.push({ timestamp: Date.now(), ...entry });
  await chrome.storage.local.set({ groundingLog: entries.slice(-MAX_LOG_ENTRIES) });
}
