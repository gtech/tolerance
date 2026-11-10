// Decides when a feed tab shows the first-week extinction-burst card
// (see shared/burst-utils.ts). Signals: a run of reveals, or turning strictness down.

import { BurstState, BurstTrigger, EMPTY_BURST_STATE, inBurstWindow, noteBurstSignal } from '../shared/burst-utils';
import { thresholdsToStrictness, DEFAULT_BLUR_THRESHOLDS } from '../shared/constants';
import type { Settings } from '../shared/types';

const MAX_LOG_ENTRIES = 100;

export interface BurstCardInfo {
  trigger: BurstTrigger;
  level: number; // current strictness, so the card knows if it can offer "turn it down"
}

async function load(): Promise<{ state: BurstState; installedAt: number | undefined }> {
  const stored = await chrome.storage.local.get(['burstState', 'installedAt']);
  return {
    state: (stored.burstState as BurstState | undefined) ?? EMPTY_BURST_STATE,
    installedAt: stored.installedAt as number | undefined,
  };
}

export async function logBurstEvent(event: string, trigger?: string): Promise<void> {
  const stored = await chrome.storage.local.get('burstLog');
  const entries = (stored.burstLog as { timestamp: number; event: string; trigger?: string }[] | undefined) ?? [];
  entries.push({ timestamp: Date.now(), event, trigger });
  await chrome.storage.local.set({ burstLog: entries.slice(-MAX_LOG_ENTRIES) });
}

export async function recordBurstSignal(signal: BurstTrigger): Promise<void> {
  const { state, installedAt } = await load();
  if (state.shown || !inBurstWindow(installedAt, Date.now())) return;
  const next = noteBurstSignal(state, signal, Date.now(), installedAt);
  await chrome.storage.local.set({ burstState: next });
  if (!state.pending && next.pending) await logBurstEvent('triggered', next.pending);
}

function strictnessOf(settings: Settings | undefined): number {
  const custom = settings?.customThresholds;
  return thresholdsToStrictness(custom?.enabled ? custom.blurThresholds : DEFAULT_BLUR_THRESHOLDS).level;
}

// Called on each heartbeat. Hands the card to the first tab that can show it.
export async function takeBurstCard(canPrompt: boolean): Promise<BurstCardInfo | null> {
  if (!canPrompt) return null;
  const { state } = await load();
  if (!state.pending || state.shown) return null;

  await chrome.storage.local.set({ burstState: { ...state, pending: null, shown: true } });
  const { settings } = await chrome.storage.local.get('settings');
  return { trigger: state.pending, level: strictnessOf(settings as Settings | undefined) };
}

// Turning strictness down (popup, dashboard or welcome page) counts as a signal
export function watchStrictnessChanges(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const before = strictnessOf(changes.settings.oldValue as Settings | undefined);
    const after = strictnessOf(changes.settings.newValue as Settings | undefined);
    if (after < before) recordBurstSignal('lowered');
  });
}
