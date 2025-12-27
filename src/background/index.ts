import { MessageType, EngagementScore, SessionLog, DailyNarrativeStats, WhitelistEntry } from '../shared/types';
import { log, setLogLevel } from '../shared/constants';
import { provisionFreeKey } from './provisioning';
import {
  getState,
  getSettings,
  setSettings,
  createSession,
  endSession,
  logImpressions,
  isBaselineComplete,
  setState,
  cleanupOldScores,
  getAllSessions,
  getCalibrationData,
  getCalibrationStats,
  getNarrativeThemes,
  saveNarrativeTheme,
  getEmergingNarratives,
  getCounterStrategies,
  saveCounterStrategy,
  deleteCounterStrategy,
  recordHeartbeat,
  getGlobalSession,
  getSessionMinutes,
  getCurrentPhase,
  clearScoreCache,
  getAdaptiveSettings,
  shouldShowFeedbackPrompt,
  submitCalibrationFeedback,
  getEffectiveBlurThreshold,
  getEffectivePhaseThresholds,
} from './storage';
import { scorePosts, scoreTweets, scoreVideos, scoreInstagramPosts } from './scorer';
import { getScheduledOrder } from './scheduler';
import { getApiUsage, resetApiUsage } from './openrouter';
import { getProductivityStats } from './rescuetime';
import {
  discoverEmergingNarratives,
  confirmEmergingNarrative,
  dismissEmergingNarrative,
  getUnclassifiedCount,
} from './themeDiscovery';

// Initialize extension state on install
chrome.runtime.onInstalled.addListener(async (details) => {
  log.debug(' installed, reason:', details.reason);

  // Set initial state with baseline start date
  const state = await getState();
  if (!state.baselineStartDate || state.baselineStartDate === 0) {
    await setState({ baselineStartDate: Date.now() });
  }

  // Schedule periodic cleanup
  chrome.alarms.create('cleanup', { periodInMinutes: 60 });

  // Schedule narrative theme discovery (daily)
  chrome.alarms.create('narrativeDiscovery', { periodInMinutes: 1440 }); // 24 hours

  // Create context menu for whitelisting authors
  chrome.contextMenus.create({
    id: 'tolerance-trust-author',
    title: 'Trust this author (never blur)',
    contexts: ['all'],
    documentUrlPatterns: [
      '*://old.reddit.com/*',
      '*://www.reddit.com/*',
      '*://reddit.com/*',
      '*://twitter.com/*',
      '*://x.com/*',
      '*://www.youtube.com/*',
      '*://www.instagram.com/*',
    ],
  });

  // Open dashboard on first install to prompt API key setup
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
  }

  // Pre-provision free tier API key (async, fire-and-forget)
  // This ensures the key is ready when the user first visits a social media site
  provisionFreeKey().then(result => {
    if (result) {
      log.debug(` Free tier key pre-provisioned on ${details.reason}`);
    }
  }).catch(err => {
    log.debug(` Free tier key pre-provisioning failed: ${err}`);
  });
});

// Handle context menu clicks for author whitelisting
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'tolerance-trust-author' || !tab?.id) return;

  try {
    // Ask content script for the clicked author
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CLICKED_AUTHOR' });

    if (!response?.sourceId || !response?.platform) {
      log.debug('Context menu: No author found at click position');
      return;
    }

    const { sourceId, platform } = response;

    // Add to whitelist
    const settings = await getSettings();
    const whitelist: WhitelistEntry[] = settings.whitelist || [];

    // Check if already whitelisted
    const normalizedSource = sourceId.toLowerCase().replace(/^[@u/]+/, '');
    const alreadyExists = whitelist.some(entry =>
      entry.platform === platform &&
      entry.sourceId.toLowerCase().replace(/^[@u/]+/, '') === normalizedSource
    );

    if (alreadyExists) {
      log.debug(`Context menu: ${sourceId} already whitelisted`);
      return;
    }

    // Add new entry
    const newEntry: WhitelistEntry = {
      sourceId,
      platform,
      createdAt: Date.now(),
      reason: 'Added via right-click menu',
    };

    whitelist.push(newEntry);
    await setSettings({ ...settings, whitelist });

    log.info(`Context menu: Added ${sourceId} (${platform}) to whitelist`);

    // Notify content script to refresh (optional visual feedback)
    chrome.tabs.sendMessage(tab.id, {
      type: 'AUTHOR_WHITELISTED',
      sourceId,
      platform,
    }).catch(() => {
      // Content script might not be ready, that's fine
    });
  } catch (err) {
    log.debug('Context menu error:', err);
  }
});

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'cleanup') {
    await cleanupOldScores();
  } else if (alarm.name === 'narrativeDiscovery') {
    // Run theme discovery if enough unclassified posts accumulated
    const discovered = await discoverEmergingNarratives();
    if (discovered.length > 0) {
      log.debug(` Discovered ${discovered.length} emerging narratives`);
    }
  }
});

// Track active tab for image fetching
let activeContentScriptTabId: number | null = null;

// Fetch image as base64 via content script (needed for Reddit images that block API servers)
export async function fetchImageViaContentScript(url: string): Promise<string | null> {
  if (!activeContentScriptTabId) {
    log.debug(' No active content script tab for image fetch');
    return null;
  }

  try {
    const response = await chrome.tabs.sendMessage(activeContentScriptTabId, {
      type: 'FETCH_IMAGE_BASE64',
      url,
    });

    if (response?.success && response.base64) {
      return response.base64;
    }
    log.debug(` Image fetch failed: ${response?.error || 'unknown error'}`);
    return null;
  } catch (err) {
    log.debug(` Image fetch error: ${err}`);
    return null;
  }
}

// Message handler for content script communication
// Also handles heartbeats from tracker.js on other social media sites
chrome.runtime.onMessage.addListener((message: MessageType | { type: string }, sender, sendResponse) => {
  // Track sender tab for potential image fetch requests
  if (sender.tab?.id) {
    activeContentScriptTabId = sender.tab.id;
  }
  // Handle SOCIAL_MEDIA_HEARTBEAT separately (comes from tracker.js, not typed in MessageType)
  if (message.type === 'SOCIAL_MEDIA_HEARTBEAT') {
    recordHeartbeat().then(() => {
      sendResponse({ type: 'HEARTBEAT_ACK' });
    });
    return true;
  }

  // Handle TEST_ENDPOINT for dashboard connection testing
  if (message.type === 'TEST_ENDPOINT') {
    const { endpoint, model, apiKey } = message as { type: string; endpoint: string; model?: string; apiKey?: string };
    testEndpointConnection(endpoint, model, apiKey).then(sendResponse);
    return true;
  }

  handleMessage(message as MessageType, sender).then(sendResponse);
  return true; // Indicates async response
});

async function handleMessage(
  message: MessageType,
  _sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'GET_STATE': {
      const state = await getState();
      const settings = await getSettings();

      // Initialize log level from settings
      if (settings.logLevel) {
        setLogLevel(settings.logLevel);
      }

      // Check if baseline period is complete
      if (state.mode === 'baseline' && await isBaselineComplete()) {
        await setState({ mode: 'active' });
        state.mode = 'active';
        log.info('Baseline period complete, switching to active mode');
      }

      return { type: 'STATE_RESULT', state, settings };
    }

    case 'SCORE_POSTS': {
      const scores = await scorePosts(message.posts);
      return { type: 'SCORES_RESULT', scores };
    }

    case 'SCORE_TWEETS': {
      const scores = await scoreTweets(message.tweets);
      return { type: 'SCORES_RESULT', scores };
    }

    case 'SCORE_VIDEOS': {
      const scores = await scoreVideos(message.videos);
      return { type: 'SCORES_RESULT', scores };
    }

    case 'SCORE_INSTAGRAM_POSTS': {
      const scores = await scoreInstagramPosts(message.posts);
      return { type: 'SCORES_RESULT', scores };
    }

    case 'GET_SCHEDULER_ORDER': {
      const scoreMap = new Map<string, EngagementScore>();
      for (const score of message.scores) {
        scoreMap.set(score.postId, score);
      }

      const { orderedIds, hiddenIds } = await getScheduledOrder(message.postIds, scoreMap);
      return { type: 'SCHEDULER_ORDER_RESULT', orderedIds, hiddenIds };
    }

    case 'LOG_IMPRESSIONS': {
      // Ensure we have a session before logging
      let state = await getState();
      if (!state.currentSessionId) {
        await createSession(state.mode);
        state = await getState();
        log.debug(': Auto-created session for impressions');
      }
      await logImpressions(message.impressions);
      return { success: true };
    }

    case 'ENSURE_SESSION': {
      let state = await getState();
      const tabId = _sender.tab?.id;
      if (!state.currentSessionId) {
        const session = await createSession(state.mode, tabId);
        log.debug(': Session created:', session.sessionId, 'for tab:', tabId);
        return { created: true, sessionId: session.sessionId };
      }
      // Update tab association if needed
      if (tabId && state.sessionTabId !== tabId) {
        await setState({ sessionTabId: tabId });
      }
      return { created: false, sessionId: state.currentSessionId };
    }

    case 'GET_API_USAGE': {
      const usage = await getApiUsage();
      return { type: 'API_USAGE_RESULT', usage };
    }

    case 'RESET_API_USAGE': {
      await resetApiUsage();
      return { success: true };
    }

    case 'CLEAR_SCORE_CACHE': {
      const count = await clearScoreCache();
      return { type: 'SCORE_CACHE_CLEARED', count };
    }

    case 'GET_DASHBOARD_DATA': {
      const sessions = await getAllSessions();
      const calibration = await getCalibrationData();
      const apiUsage = await getApiUsage();
      const calibrationStats = await getCalibrationStats('24h');
      log.debug('GET_DASHBOARD_DATA:', {
        sessionsCount: sessions.length,
        calibrationCount: calibration.length,
        apiUsage,
        calibrationStats,
      });
      return {
        type: 'DASHBOARD_DATA_RESULT',
        sessions,
        calibration,
        apiUsage,
        calibrationStats,
      };
    }

    case 'GET_CALIBRATION_STATS': {
      const period = message.period || '24h';
      const stats = await getCalibrationStats(period);
      return { type: 'CALIBRATION_STATS_RESULT', stats };
    }

    case 'GET_GLOBAL_SESSION': {
      const globalSession = await getGlobalSession();
      const settings = await getSettings();
      // Use getSessionMinutes() to respect test override from dashboard slider
      const effectiveMinutes = await getSessionMinutes();
      const phase = getCurrentPhase(
        effectiveMinutes,
        settings.scheduler.phaseThresholds
      );
      return {
        type: 'GLOBAL_SESSION_RESULT',
        globalSession: { ...globalSession, totalMinutes: effectiveMinutes },
        phase,
        settings: {
          progressiveBoredomEnabled: settings.scheduler.progressiveBoredomEnabled,
          phaseThresholds: settings.scheduler.phaseThresholds,
          phaseRatios: settings.scheduler.phaseRatios,
        },
      };
    }

    case 'GET_PRODUCTIVITY': {
      const productivity = await getProductivityStats();
      return { type: 'PRODUCTIVITY_RESULT', productivity };
    }

    case 'GET_CARD_DATA': {
      // Get all data needed for the reminder card
      const [productivity, state, settings, sessions] = await Promise.all([
        getProductivityStats(),
        getState(),
        getSettings(),
        getAllSessions(),
      ]);

      // Calculate high-engagement posts seen today
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todaySessions = sessions.filter(s => s.startTime >= todayStart.getTime());
      const highEngagementToday = todaySessions.reduce(
        (sum, s) => sum + s.engagementDistribution.high,
        0
      );

      return {
        type: 'CARD_DATA_RESULT',
        productivity,
        settings,
        state,
        highEngagementToday,
      };
    }

    // ==========================================
    // Narrative Awareness Handlers
    // ==========================================

    case 'GET_NARRATIVE_THEMES': {
      const themes = await getNarrativeThemes();
      return { type: 'NARRATIVE_THEMES_RESULT', themes };
    }

    case 'UPDATE_NARRATIVE_THEME': {
      await saveNarrativeTheme(message.theme);
      return { success: true };
    }

    case 'GET_EMERGING_NARRATIVES': {
      const emerging = await getEmergingNarratives();
      const unclassifiedCount = getUnclassifiedCount();
      return { type: 'EMERGING_NARRATIVES_RESULT', emerging, unclassifiedCount };
    }

    case 'CONFIRM_EMERGING_NARRATIVE': {
      const newTheme = await confirmEmergingNarrative(message.id, message.name);
      if (newTheme) {
        await saveNarrativeTheme(newTheme);
        return { success: true, theme: newTheme };
      }
      return { success: false, error: 'Narrative not found' };
    }

    case 'DISMISS_EMERGING_NARRATIVE': {
      await dismissEmergingNarrative(message.id);
      return { success: true };
    }

    case 'TRIGGER_NARRATIVE_DISCOVERY': {
      const discovered = await discoverEmergingNarratives();
      return { type: 'DISCOVERY_RESULT', discovered };
    }

    case 'GET_NARRATIVE_TRENDS': {
      // Calculate narrative exposure trends from sessions
      const sessions = await getAllSessions();
      const trends = calculateNarrativeTrends(sessions, message.days);
      return { type: 'NARRATIVE_TRENDS_RESULT', trends };
    }

    case 'GET_COUNTER_STRATEGIES': {
      const strategies = await getCounterStrategies();
      return { type: 'COUNTER_STRATEGIES_RESULT', strategies };
    }

    case 'SAVE_COUNTER_STRATEGY': {
      await saveCounterStrategy(message.strategy);
      return { success: true };
    }

    case 'DELETE_COUNTER_STRATEGY': {
      await deleteCounterStrategy(message.strategyId);
      return { success: true };
    }

    // ==========================================
    // Adaptive Calibration Handlers
    // ==========================================

    case 'GET_ADAPTIVE_SETTINGS': {
      const adaptive = await getAdaptiveSettings();
      return { type: 'ADAPTIVE_SETTINGS_RESULT', adaptive };
    }

    case 'GET_FEEDBACK_PROMPT_STATUS': {
      const status = await shouldShowFeedbackPrompt();
      return { type: 'FEEDBACK_PROMPT_STATUS_RESULT', ...status };
    }

    case 'SUBMIT_CALIBRATION_FEEDBACK': {
      const adaptive = await submitCalibrationFeedback(message.response);
      return { type: 'CALIBRATION_FEEDBACK_RESULT', success: true, adaptive };
    }

    case 'GET_EFFECTIVE_BLUR_THRESHOLD': {
      const adaptive = await getAdaptiveSettings();
      const threshold = await getEffectiveBlurThreshold(message.phase, adaptive.blurThresholdOffset);
      return { type: 'BLUR_THRESHOLD_RESULT', threshold, phase: message.phase };
    }

    default:
      console.warn('Unknown message type:', message);
      return { error: 'Unknown message type' };
  }
}

// Helper to check if URL is Reddit
function isRedditUrl(url?: string): boolean {
  if (!url) return false;
  return url.includes('reddit.com');
}

// Helper to check if URL is Twitter/X
function isTwitterUrl(url?: string): boolean {
  if (!url) return false;
  return url.includes('twitter.com') || url.includes('x.com');
}

// Helper to check if URL is YouTube
function isYouTubeUrl(url?: string): boolean {
  if (!url) return false;
  return url.includes('youtube.com');
}

// Helper to check if URL is Instagram
function isInstagramUrl(url?: string): boolean {
  if (!url) return false;
  return url.includes('instagram.com');
}

// Helper to check if URL is any supported social media platform
function isSocialMediaUrl(url?: string): boolean {
  return isRedditUrl(url) || isTwitterUrl(url) || isYouTubeUrl(url) || isInstagramUrl(url);
}

// Session lifecycle management
// Sessions persist while browsing social media - only end when leaving entirely

// Create session when switching to a social media tab (if no session exists)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    const state = await getState();

    if (isSocialMediaUrl(tab.url)) {
      // On social media - create session if none exists, or if switching to a different tab
      if (!state.currentSessionId) {
        await createSession(state.mode, activeInfo.tabId);
        const platform = isTwitterUrl(tab.url) ? 'Twitter' :
                        isInstagramUrl(tab.url) ? 'Instagram' :
                        isYouTubeUrl(tab.url) ? 'YouTube' : 'Reddit';
        log.debug(` Session created for ${platform} tab`, activeInfo.tabId);
      } else if (state.sessionTabId !== activeInfo.tabId) {
        // Switching to a different social media tab - update the tab association
        await setState({ sessionTabId: activeInfo.tabId });
        log.debug(': Session transferred to tab', activeInfo.tabId);
      }
    }
  } catch (e) {
    // Tab might not exist anymore
  }
});

// Only end session when navigating away from social media entirely (not internal navigation)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only check on completed navigation to avoid false positives during loading
  if (changeInfo.status === 'complete') {
    const state = await getState();

    // Only end session if:
    // 1. We have an active session
    // 2. This is the session's tab
    // 3. The URL is no longer social media
    if (state.currentSessionId && state.sessionTabId === tabId && !isSocialMediaUrl(tab.url)) {
      await endSession();
      log.debug(': Session ended - navigated away from social media');
    }
  }
});

// End session only when the session's tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.currentSessionId && state.sessionTabId === tabId) {
    await endSession();
    log.debug(': Session ended - tab closed');
  }
});

// Calculate narrative trends from session data
function calculateNarrativeTrends(sessions: SessionLog[], days: number): DailyNarrativeStats[] {
  const stats: Map<string, DailyNarrativeStats> = new Map();
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  // Initialize stats for each day
  for (let i = 0; i < days; i++) {
    const date = new Date(now - i * 24 * 60 * 60 * 1000);
    const dateStr = date.toISOString().split('T')[0];
    stats.set(dateStr, {
      date: dateStr,
      themeCounts: {},
      totalPosts: 0,
      exposure: {},
    });
  }

  // Aggregate posts from sessions
  for (const session of sessions) {
    if (session.startTime < cutoff) continue;

    const sessionDate = new Date(session.startTime).toISOString().split('T')[0];
    const dayStat = stats.get(sessionDate);
    if (!dayStat) continue;

    for (const post of session.posts) {
      dayStat.totalPosts++;

      if (post.narrativeThemeId) {
        dayStat.themeCounts[post.narrativeThemeId] =
          (dayStat.themeCounts[post.narrativeThemeId] || 0) + 1;
      }
    }
  }

  // Calculate exposure percentages and baseline averages
  const result = Array.from(stats.values()).sort((a, b) => a.date.localeCompare(b.date));

  for (const dayStat of result) {
    if (dayStat.totalPosts > 0) {
      for (const [themeId, count] of Object.entries(dayStat.themeCounts)) {
        dayStat.exposure[themeId] = Math.round((count / dayStat.totalPosts) * 100);
      }
    }
  }

  // Calculate 7-day rolling baseline for each theme
  for (let i = 0; i < result.length; i++) {
    const dayStat = result[i];
    dayStat.baselineAvg = {};

    // Get previous 7 days (or as many as available)
    const windowStart = Math.max(0, i - 7);
    const window = result.slice(windowStart, i);

    if (window.length > 0) {
      // Collect all theme IDs from window
      const allThemes = new Set<string>();
      for (const w of window) {
        Object.keys(w.exposure).forEach(t => allThemes.add(t));
      }

      // Calculate average for each theme
      for (const themeId of allThemes) {
        const values = window.map(w => w.exposure[themeId] || 0);
        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        dayStat.baselineAvg[themeId] = Math.round(avg);
      }
    }
  }

  return result;
}

// Test endpoint connection for dashboard
async function testEndpointConnection(
  endpoint: string,
  model?: string,
  apiKey?: string
): Promise<{ success: boolean; message: string; model?: string; responseTime?: number }> {
  const startTime = Date.now();

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model || 'test',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5,
        stream: false,
      }),
    });

    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      return {
        success: false,
        message: `HTTP ${response.status}: ${errorText.slice(0, 100)}`,
      };
    }

    const data = await response.json();

    // Check if we got a valid response
    if (data.choices && data.choices.length > 0) {
      return {
        success: true,
        message: 'Connection successful',
        model: data.model || model,
        responseTime,
      };
    } else if (data.error) {
      return {
        success: false,
        message: data.error.message || 'API returned an error',
      };
    } else {
      return {
        success: true,
        message: 'Connected (unexpected response format)',
        responseTime,
      };
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return {
        success: false,
        message: 'Connection refused - is the server running?',
      };
    }
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

log.debug(' background service worker loaded');
