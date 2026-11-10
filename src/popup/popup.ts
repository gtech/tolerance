import { AppState, Settings, AdaptiveSettings } from '../shared/types';
import { STRICTNESS_PRESETS } from '../shared/constants';
import { readStrictness, saveStrictness } from '../shared/strictness-settings';
import { formatMinutes, loadUsageChart } from '../shared/usage-chart';
import { getSecrets } from '../shared/secrets';

interface StateResult {
  state: AppState;
  settings: Settings;
}

interface GlobalSessionResult {
  globalSession: {
    totalMinutes: number;
  };
  phase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
}

interface FeedbackPromptResult {
  show: boolean;
  yesterdaySession?: {
    minutes: number;
    maxPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
  };
}

interface CalibrationFeedbackResult {
  success: boolean;
  adaptive: AdaptiveSettings;
}

async function init(): Promise<void> {
  // Set up dashboard links FIRST - before any async operations
  // This ensures the link works even if background script is slow/failing
  const dashboardLink = document.getElementById('dashboard-link');
  if (dashboardLink) {
    dashboardLink.addEventListener('click', openDashboard);
  }

  // Set up feedback buttons and strictness early too
  setupFeedbackButtons();
  await setupStrictness();

  // Get current state
  const result = await chrome.runtime.sendMessage({ type: 'GET_STATE' }) as StateResult;

  if (result?.settings) {
    await updateApiStatus(result.settings);
  }

  // Check if we should show feedback prompt
  await checkFeedbackPrompt();

  // Get global session for boredom phase
  await updateBoredomPhase();

  // Usage over the last few weeks
  await loadUsageChart('usage-chart', 28, 72);

  // Setup link may be dynamically added by updateApiStatus, so check again
  const setupLink = document.getElementById('setup-link');
  if (setupLink) {
    setupLink.addEventListener('click', openDashboardToApiSection);
  }
}

function openDashboard(e: Event): void {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
}

function openDashboardToApiSection(e: Event): void {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html#api-setup') });
}

async function updateApiStatus(settings: Settings): Promise<void> {
  const isFreeTier = settings.apiTier !== 'own-key';
  // Keys are not in the settings object (shared/secrets.ts)
  const hasOpenRouterKey = Boolean((await getSecrets()).openRouterApiKey?.trim());
  const hasCustomEndpoint = settings.apiProvider?.type === 'openai-compatible' &&
                            Boolean(settings.apiProvider?.endpoint?.trim());
  const isApiConfigured = isFreeTier || hasOpenRouterKey || hasCustomEndpoint;

  // Check for free tier exhaustion
  const errorStateResult = await chrome.storage.local.get('apiErrorState');
  const errorState = errorStateResult.apiErrorState as { exhausted: boolean; message: string } | undefined;
  const isExhausted = isFreeTier && errorState?.exhausted;

  const apiDot = document.getElementById('api-dot');
  const apiText = document.getElementById('api-status-text');
  const apiWarning = document.getElementById('api-warning');

  if (apiDot && apiText) {
    if (isExhausted) {
      apiDot.className = 'api-dot disconnected';
      apiText.textContent = 'Free Tier Exhausted (or use your own API key)';
      apiText.style.color = '#e74c3c';
    } else if (isApiConfigured) {
      apiDot.className = 'api-dot connected';
      if (isFreeTier) {
        apiText.textContent = 'Free Tier';
      } else if (hasCustomEndpoint) {
        apiText.textContent = 'Custom Endpoint';
      } else {
        apiText.textContent = 'Connected';
      }
      apiText.style.color = '#27ae60';
    } else {
      apiDot.className = 'api-dot disconnected';
      apiText.textContent = 'No API Key';
      apiText.style.color = '#e74c3c';
    }
  }

  if (apiWarning) {
    // Show warning if not configured OR if exhausted
    apiWarning.style.display = (!isApiConfigured || isExhausted) ? 'block' : 'none';
    if (isExhausted && apiWarning) {
      apiWarning.innerHTML = '<a href="#" id="setup-link">Free tier limit reached. Add your own API key →</a>';
      const setupLink = apiWarning.querySelector('#setup-link');
      if (setupLink) {
        setupLink.addEventListener('click', openDashboardToApiSection);
      }
    }
  }
}

async function updateBoredomPhase(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_GLOBAL_SESSION' }) as GlobalSessionResult | null;

    if (!result) return;

    const { globalSession, phase } = result;
    const minutes = globalSession.totalMinutes;

    // Update time display
    const sessionTimeEl = document.getElementById('session-time');
    if (sessionTimeEl) sessionTimeEl.textContent = formatMinutes(minutes);

    // Update phase badge
    const phaseBadge = document.getElementById('phase-badge');
    if (phaseBadge) {
      const phaseLabels: Record<string, string> = {
        'normal': 'Normal',
        'reduced': 'Reduced',
        'wind-down': 'Wind Down',
        'minimal': 'Minimal',
      };
      phaseBadge.textContent = phaseLabels[phase] || phase;
      phaseBadge.className = `phase-badge phase-${phase}`;
    }
  } catch (error) {
    console.error('Failed to get boredom phase:', error);
  }
}

// ==========================================
// Calibration Feedback Functions
// ==========================================

async function checkFeedbackPrompt(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'GET_FEEDBACK_PROMPT_STATUS',
    }) as FeedbackPromptResult | null;

    if (!result?.show) return;

    const promptEl = document.getElementById('feedback-prompt');
    const contextEl = document.getElementById('feedback-context');

    if (promptEl && contextEl && result.yesterdaySession) {
      const minutes = Math.round(result.yesterdaySession.minutes);
      const phase = result.yesterdaySession.maxPhase;
      const phaseLabels: Record<string, string> = {
        'normal': 'normal',
        'reduced': 'reduced engagement',
        'wind-down': 'wind-down',
        'minimal': 'minimal engagement',
      };
      contextEl.textContent = `You browsed for ${minutes} min and reached ${phaseLabels[phase]} phase.`;
      promptEl.style.display = 'block';
    }
  } catch (error) {
    console.error('Failed to check feedback prompt:', error);
  }
}

function setupFeedbackButtons(): void {
  const buttons = document.querySelectorAll('.feedback-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const response = btn.getAttribute('data-response') as 'restricted' | 'balanced' | 'too_easy';
      if (!response) return;

      await submitFeedback(response);
    });
  });
}

async function submitFeedback(response: 'restricted' | 'balanced' | 'too_easy'): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SUBMIT_CALIBRATION_FEEDBACK',
      response,
    }) as CalibrationFeedbackResult | null;

    if (result?.success) {
      // Show thank you message
      const promptEl = document.getElementById('feedback-prompt');
      if (promptEl) {
        promptEl.innerHTML = '<div class="feedback-thanks">Thanks! Settings adjusted based on your feedback.</div>';
        setTimeout(() => {
          promptEl.style.display = 'none';
        }, 2000);
      }
    }
  } catch (error) {
    console.error('Failed to submit feedback:', error);
  }
}

// ==========================================
// Strictness
// ==========================================

async function setupStrictness(): Promise<void> {
  const slider = document.getElementById('strictness') as HTMLInputElement | null;
  const label = document.getElementById('strictness-value');
  if (!slider || !label) return;

  const { level, exact } = await readStrictness();
  slider.value = String(level);
  label.textContent = exact ? STRICTNESS_PRESETS[level - 1].label : 'Custom';

  slider.addEventListener('input', () => {
    label.textContent = STRICTNESS_PRESETS[parseInt(slider.value, 10) - 1].label;
  });
  slider.addEventListener('change', () => {
    void saveStrictness(parseInt(slider.value, 10));
    void showFineTuneHint();
  });
}

// After a strictness change, point to per-phase control in the dashboard. Shown
// in the first few popups where the slider moves, and never again once clicked.
const FINE_TUNE_HINT_KEY = 'fineTuneHint';
const FINE_TUNE_HINT_MAX = 3;
let fineTuneHintShown = false;

async function showFineTuneHint(): Promise<void> {
  if (fineTuneHintShown) return;
  const desc = document.getElementById('strictness-desc');
  if (!desc) return;
  const stored = await chrome.storage.local.get(FINE_TUNE_HINT_KEY);
  const hint = (stored[FINE_TUNE_HINT_KEY] as { shown: number; clicked: boolean } | undefined)
    ?? { shown: 0, clicked: false };
  if (hint.clicked || hint.shown >= FINE_TUNE_HINT_MAX) return;
  fineTuneHintShown = true;
  void chrome.storage.local.set({ [FINE_TUNE_HINT_KEY]: { ...hint, shown: hint.shown + 1 } });

  desc.textContent = 'Want different levels as a session goes on? ';
  const link = document.createElement('a');
  link.href = '#';
  link.textContent = 'Fine-tune per phase';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.storage.local.set({ [FINE_TUNE_HINT_KEY]: { shown: hint.shown + 1, clicked: true } });
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html#thresholds') });
  });
  desc.append(link);
}

document.addEventListener('DOMContentLoaded', init);
