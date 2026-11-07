// Reading and saving the one-slider strictness from any extension page.
import { Settings, DEFAULT_SETTINGS } from './types';
import { DEFAULT_BLUR_THRESHOLDS, DEFAULT_PHASE_TIMING, strictnessThresholds, thresholdsToStrictness } from './constants';

async function storedSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return (settings as Settings | undefined) ?? DEFAULT_SETTINGS;
}

// exact=false means the phases were fine-tuned on the dashboard; level is then the closest preset
export async function readStrictness(): Promise<{ level: number; exact: boolean }> {
  const custom = (await storedSettings()).customThresholds;
  return thresholdsToStrictness(custom?.enabled ? custom.blurThresholds : DEFAULT_BLUR_THRESHOLDS);
}

export async function saveStrictness(level: number): Promise<void> {
  const settings = await storedSettings();
  await chrome.storage.local.set({
    settings: {
      ...settings,
      customThresholds: {
        blurThresholds: strictnessThresholds(level),
        phaseTiming: settings.customThresholds?.phaseTiming ?? settings.scheduler?.phaseThresholds ?? DEFAULT_PHASE_TIMING,
        enabled: true,
      },
    },
  });
}
