import { AppState, Settings, SessionLog, DEFAULT_SETTINGS, AdaptiveSettings } from '../shared/types';

interface StateResult {
  state: AppState;
  settings: Settings;
}

interface DashboardResult {
  sessions: SessionLog[];
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

let currentSettings: Settings = DEFAULT_SETTINGS;

async function init(): Promise<void> {
  // Get current state
  const result = await chrome.runtime.sendMessage({ type: 'GET_STATE' }) as StateResult;

  if (result?.settings) {
    currentSettings = result.settings;
    updateApiStatus(result.settings);
    updateQualityModeToggle(result.settings);
  }

  // Check if we should show feedback prompt
  await checkFeedbackPrompt();

  // Get session stats
  await updateStats();

  // Get global session for boredom phase
  await updateBoredomPhase();

  // Set up dashboard links
  const dashboardLink = document.getElementById('dashboard-link');
  if (dashboardLink) {
    dashboardLink.addEventListener('click', openDashboard);
  }

  const setupLink = document.getElementById('setup-link');
  if (setupLink) {
    setupLink.addEventListener('click', openDashboard);
  }

  // Set up feedback buttons
  setupFeedbackButtons();

  // Set up quality mode toggle
  setupQualityModeToggle();
}

function openDashboard(e: Event): void {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
}

function updateApiStatus(settings: Settings): void {
  const hasApiKey = Boolean(settings.openRouterApiKey?.trim());

  const apiDot = document.getElementById('api-dot');
  const apiText = document.getElementById('api-status-text');
  const apiWarning = document.getElementById('api-warning');

  if (apiDot && apiText) {
    if (hasApiKey) {
      apiDot.className = 'api-dot connected';
      apiText.textContent = 'Connected';
      apiText.style.color = '#27ae60';
    } else {
      apiDot.className = 'api-dot disconnected';
      apiText.textContent = 'No API Key';
      apiText.style.color = '#e74c3c';
    }
  }

  if (apiWarning) {
    apiWarning.style.display = hasApiKey ? 'none' : 'block';
  }
}

async function updateStats(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }) as DashboardResult | null;

    if (!result?.sessions) return;

    // Get today's sessions
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todaySessions = result.sessions.filter(s => s.startTime >= todayStart.getTime());

    // Calculate totals
    let totalPosts = 0;
    let totalHigh = 0;
    let totalMedium = 0;
    let totalLow = 0;

    for (const session of todaySessions) {
      totalPosts += session.posts?.length ?? 0;
      totalHigh += session.engagementDistribution?.high ?? 0;
      totalMedium += session.engagementDistribution?.medium ?? 0;
      totalLow += session.engagementDistribution?.low ?? 0;
    }

    // Update UI
    const postsToday = document.getElementById('posts-today');
    const highCount = document.getElementById('high-count');
    const mediumCount = document.getElementById('medium-count');
    const lowCount = document.getElementById('low-count');

    if (postsToday) postsToday.textContent = String(totalPosts);
    if (highCount) highCount.textContent = String(totalHigh);
    if (mediumCount) mediumCount.textContent = String(totalMedium);
    if (lowCount) lowCount.textContent = String(totalLow);
  } catch (error) {
    console.error('Failed to get stats:', error);
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
    if (sessionTimeEl) {
      if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        sessionTimeEl.textContent = `${hours}h ${mins}m`;
      } else {
        sessionTimeEl.textContent = `${Math.round(minutes)}m`;
      }
    }

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
// Quality Mode Functions
// ==========================================

function updateQualityModeToggle(settings: Settings): void {
  const toggle = document.getElementById('quality-mode-toggle') as HTMLInputElement | null;
  const section = document.getElementById('quality-mode-section');

  if (toggle) {
    toggle.checked = settings.qualityMode ?? false;
  }

  if (section) {
    if (settings.qualityMode) {
      section.classList.add('active');
    } else {
      section.classList.remove('active');
    }
  }
}

function setupQualityModeToggle(): void {
  const toggle = document.getElementById('quality-mode-toggle') as HTMLInputElement | null;
  const section = document.getElementById('quality-mode-section');

  if (!toggle) return;

  toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;

    // Update UI immediately
    if (section) {
      if (enabled) {
        section.classList.add('active');
      } else {
        section.classList.remove('active');
      }
    }

    // Save setting (use local storage, same as background script)
    currentSettings.qualityMode = enabled;
    await chrome.storage.local.set({ settings: currentSettings });

    // Notify all tabs to refresh their blur state
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'QUALITY_MODE_CHANGED', enabled });
        } catch {
          // Tab might not have content script
        }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
