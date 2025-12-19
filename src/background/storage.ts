import { log } from '../shared/constants';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import {
  SessionLog,
  PostImpression,
  EngagementScore,
  AppState,
  Settings,
  NarrativeTheme,
  EmergingNarrative,
  CounterStrategy,
  DailyNarrativeStats,
  GlobalSession,
  AdaptiveSettings,
  CalibrationFeedback,
  DEFAULT_STATE,
  DEFAULT_SETTINGS,
  DEFAULT_ADAPTIVE_SETTINGS,
} from '../shared/types';
import { SEED_NARRATIVE_THEMES } from '../shared/constants';

interface ToleranceDB extends DBSchema {
  sessions: {
    key: string;
    value: SessionLog;
    indexes: { 'by-start': number };
  };
  scores: {
    key: string; // postId
    value: EngagementScore;
    indexes: { 'by-timestamp': number };
  };
  calibration: {
    key: string; // postId
    value: {
      postId: string;
      heuristicScore: number;
      apiScore: number;
      timestamp: number;
    };
  };
}

const DB_NAME = 'tolerance';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<ToleranceDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ToleranceDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ToleranceDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Sessions store
        const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
        sessionStore.createIndex('by-start', 'startTime');

        // Scores cache store
        const scoresStore = db.createObjectStore('scores', { keyPath: 'postId' });
        scoresStore.createIndex('by-timestamp', 'timestamp');

        // Calibration data (heuristic vs API comparison)
        db.createObjectStore('calibration', { keyPath: 'postId' });
      },
    });
  }
  return dbPromise;
}

// State management (using chrome.storage.local for small state)
export async function getState(): Promise<AppState> {
  const result = await chrome.storage.local.get('state');
  return result.state || { ...DEFAULT_STATE, baselineStartDate: Date.now() };
}

export async function setState(state: Partial<AppState>): Promise<void> {
  const current = await getState();
  await chrome.storage.local.set({ state: { ...current, ...state } });
}

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings');
  // Merge with defaults to ensure new fields are present
  const settings = (result.settings || {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    scheduler: { ...DEFAULT_SETTINGS.scheduler, ...settings.scheduler },
    narrativeDetection: { ...DEFAULT_SETTINGS.narrativeDetection, ...settings.narrativeDetection },
  };
}

export async function setSettings(settings: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...settings } });
}

// Session management
export async function createSession(mode: 'baseline' | 'active', tabId?: number): Promise<SessionLog> {
  const db = await getDB();
  const session: SessionLog = {
    sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    startTime: Date.now(),
    posts: [],
    engagementDistribution: { high: 0, medium: 0, low: 0 },
    mode,
  };

  await db.put('sessions', session);
  await setState({ currentSessionId: session.sessionId, sessionTabId: tabId ?? null });

  // Log existing session count for debugging
  const allSessions = await db.getAllFromIndex('sessions', 'by-start');
  log.debug(`: Created session ${session.sessionId} for tab ${tabId}. Total sessions: ${allSessions.length}`);

  return session;
}

export async function getCurrentSession(): Promise<SessionLog | null> {
  const state = await getState();
  if (!state.currentSessionId) return null;

  const db = await getDB();
  return (await db.get('sessions', state.currentSessionId)) || null;
}

export async function logImpressions(impressions: PostImpression[]): Promise<void> {
  const session = await getCurrentSession();
  if (!session) {
    log.warn(': No session found for logging impressions');
    return;
  }

  const db = await getDB();

  // Update session with new impressions
  session.posts.push(...impressions);

  // Update distribution counts
  for (const imp of impressions) {
    session.engagementDistribution[imp.bucket]++;
  }

  await db.put('sessions', session);
  log.debug(`: Logged ${impressions.length} impressions to session ${session.sessionId}`);

  // Backup session count to chrome.storage.local for persistence debugging
  const allSessions = await db.getAllFromIndex('sessions', 'by-start');
  await chrome.storage.local.set({
    _sessionBackup: {
      count: allSessions.length,
      totalPosts: allSessions.reduce((sum, s) => sum + s.posts.length, 0),
      lastUpdated: Date.now(),
    }
  });
}

export async function endSession(): Promise<void> {
  const session = await getCurrentSession();
  if (!session) return;

  const db = await getDB();
  session.endTime = Date.now();
  await db.put('sessions', session);
  await setState({ currentSessionId: null, sessionTabId: null });
}

// Score caching
const SCORE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getCachedScores(postIds: string[]): Promise<Map<string, EngagementScore>> {
  const db = await getDB();
  const result = new Map<string, EngagementScore>();
  const now = Date.now();

  for (const id of postIds) {
    const cached = await db.get('scores', id);
    if (cached && now - cached.timestamp < SCORE_TTL_MS) {
      result.set(id, cached);
    }
  }

  return result;
}

export async function cacheScores(scores: EngagementScore[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('scores', 'readwrite');

  for (const score of scores) {
    await tx.store.put(score);
  }

  await tx.done;
}

export async function clearScoreCache(): Promise<number> {
  const db = await getDB();
  const tx = db.transaction('scores', 'readwrite');
  const count = await tx.store.count();
  await tx.store.clear();
  await tx.done;
  log.debug(`: Cleared ${count} cached scores`);
  return count;
}

// Calibration data (for comparing heuristics vs API and fine-tuning)
export async function logCalibration(
  postId: string,
  heuristicScore: number,
  apiScore: number,
  metadata?: {
    // Core content
    permalink?: string;
    title?: string;
    subreddit?: string;
    // Engagement metrics (important for fine-tuning - model sees these)
    score?: number | null;      // Upvotes
    numComments?: number;
    upvoteRatio?: number;
    // Post metadata
    mediaType?: 'text' | 'image' | 'video' | 'link' | 'gallery' | 'gif';
    flair?: string;
    isNsfw?: boolean;
    domain?: string;
    createdUtc?: number;        // For computing post age
    // Media URLs (for multimodal fine-tuning)
    imageUrl?: string;
    thumbnailUrl?: string;
    // API response data
    apiReason?: string;
    apiFullResponse?: unknown;
    heuristicFactors?: string[];
  }
): Promise<void> {
  const db = await getDB();
  const settings = await getSettings();

  // Only store API reason/response if setting allows it
  const storeReason = settings.calibration?.storeApiReason !== false;

  await db.put('calibration', {
    postId,
    heuristicScore,
    apiScore,
    timestamp: Date.now(),
    // Core content
    permalink: metadata?.permalink,
    title: metadata?.title,
    subreddit: metadata?.subreddit,
    // Engagement metrics
    score: metadata?.score,
    numComments: metadata?.numComments,
    upvoteRatio: metadata?.upvoteRatio,
    // Post metadata
    mediaType: metadata?.mediaType,
    flair: metadata?.flair,
    isNsfw: metadata?.isNsfw,
    domain: metadata?.domain,
    createdUtc: metadata?.createdUtc,
    // Media URLs
    imageUrl: metadata?.imageUrl,
    thumbnailUrl: metadata?.thumbnailUrl,
    // API response data
    apiReason: storeReason ? metadata?.apiReason : undefined,
    apiFullResponse: storeReason ? metadata?.apiFullResponse : undefined,
    heuristicFactors: metadata?.heuristicFactors,
  });

  // Cleanup old entries if maxEntries is set
  const maxEntries = settings.calibration?.maxEntries ?? 500;
  if (maxEntries > 0) {
    const allEntries = await db.getAll('calibration');
    if (allEntries.length > maxEntries) {
      // Sort by timestamp and delete oldest entries
      const sorted = allEntries.sort((a, b) => a.timestamp - b.timestamp);
      const toDelete = sorted.slice(0, allEntries.length - maxEntries);
      const tx = db.transaction('calibration', 'readwrite');
      for (const entry of toDelete) {
        await tx.store.delete(entry.postId);
      }
      await tx.done;
      log.debug(`: Pruned ${toDelete.length} old calibration entries`);
    }
  }
}

// Analytics queries
export async function getSessionsInRange(
  startTime: number,
  endTime: number
): Promise<SessionLog[]> {
  const db = await getDB();
  const sessions = await db.getAllFromIndex('sessions', 'by-start', IDBKeyRange.bound(startTime, endTime));
  return sessions;
}

export async function getAllSessions(): Promise<SessionLog[]> {
  const db = await getDB();
  return db.getAllFromIndex('sessions', 'by-start');
}

export async function getCalibrationData(): Promise<
  Array<{ postId: string; heuristicScore: number; apiScore: number; timestamp: number }>
> {
  const db = await getDB();
  return db.getAll('calibration');
}

// Get calibration stats for dashboard
export interface CalibrationStats {
  avgDelta: number;
  sampleSize: number;
  accuracy: number; // % within 20 pts
  avgHeuristic: number;
  avgApi: number;
  period: '24h' | '7d' | 'all';
}

export async function getCalibrationStats(period: '24h' | '7d' | 'all' = '24h'): Promise<CalibrationStats> {
  const allData = await getCalibrationData();

  // Filter by time period
  const now = Date.now();
  const cutoffs = {
    '24h': now - 24 * 60 * 60 * 1000,
    '7d': now - 7 * 24 * 60 * 60 * 1000,
    'all': 0,
  };
  const cutoff = cutoffs[period];
  const data = allData.filter(d => d.timestamp >= cutoff);

  if (data.length === 0) {
    return {
      avgDelta: 0,
      sampleSize: 0,
      accuracy: 0,
      avgHeuristic: 0,
      avgApi: 0,
      period,
    };
  }

  // Calculate stats
  let totalDelta = 0;
  let totalHeuristic = 0;
  let totalApi = 0;
  let withinThreshold = 0;

  for (const d of data) {
    const delta = Math.abs(d.apiScore - d.heuristicScore);
    totalDelta += delta;
    totalHeuristic += d.heuristicScore;
    totalApi += d.apiScore;
    if (delta <= 20) {
      withinThreshold++;
    }
  }

  return {
    avgDelta: totalDelta / data.length,
    sampleSize: data.length,
    accuracy: (withinThreshold / data.length) * 100,
    avgHeuristic: totalHeuristic / data.length,
    avgApi: totalApi / data.length,
    period,
  };
}

// Check if baseline period is complete
export async function isBaselineComplete(): Promise<boolean> {
  const state = await getState();
  const msElapsed = Date.now() - state.baselineStartDate;
  const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
  return daysElapsed >= state.baselineDurationDays;
}

// Cleanup old scores (call periodically)
export async function cleanupOldScores(): Promise<void> {
  const db = await getDB();
  const cutoff = Date.now() - SCORE_TTL_MS;

  const tx = db.transaction('scores', 'readwrite');
  const index = tx.store.index('by-timestamp');

  let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.done;
}

// ==========================================
// Narrative Theme Management
// ==========================================

// Get all narrative themes (seed + user-discovered)
export async function getNarrativeThemes(): Promise<NarrativeTheme[]> {
  const result = await chrome.storage.local.get('narrativeThemes');

  // Initialize with seed themes if not set
  if (!result.narrativeThemes) {
    await chrome.storage.local.set({ narrativeThemes: SEED_NARRATIVE_THEMES });
    return SEED_NARRATIVE_THEMES;
  }

  return result.narrativeThemes;
}

// Update or add a narrative theme
export async function saveNarrativeTheme(theme: NarrativeTheme): Promise<void> {
  const themes = await getNarrativeThemes();
  const existingIndex = themes.findIndex(t => t.id === theme.id);

  if (existingIndex >= 0) {
    themes[existingIndex] = theme;
  } else {
    themes.push(theme);
  }

  await chrome.storage.local.set({ narrativeThemes: themes });
}

// Get emerging (pending) narratives
export async function getEmergingNarratives(): Promise<EmergingNarrative[]> {
  const result = await chrome.storage.local.get('emergingNarratives');
  return result.emergingNarratives || [];
}

// Save emerging narratives
export async function saveEmergingNarratives(narratives: EmergingNarrative[]): Promise<void> {
  await chrome.storage.local.set({ emergingNarratives: narratives });
}

// Get counter-strategies
export async function getCounterStrategies(): Promise<CounterStrategy[]> {
  const result = await chrome.storage.local.get('counterStrategies');
  return result.counterStrategies || [];
}

// Save a counter-strategy
export async function saveCounterStrategy(strategy: CounterStrategy): Promise<void> {
  const strategies = await getCounterStrategies();
  const existingIndex = strategies.findIndex(s => s.id === strategy.id);

  if (existingIndex >= 0) {
    strategies[existingIndex] = strategy;
  } else {
    strategies.push(strategy);
  }

  await chrome.storage.local.set({ counterStrategies: strategies });
}

// Delete a counter-strategy
export async function deleteCounterStrategy(strategyId: string): Promise<void> {
  const strategies = await getCounterStrategies();
  const filtered = strategies.filter(s => s.id !== strategyId);
  await chrome.storage.local.set({ counterStrategies: filtered });
}

// ==========================================
// Global Session Tracking (Cross-Platform)
// ==========================================

const HEARTBEAT_GAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes - if gap is larger, assume user was away
const DAY_RESET_HOUR = 4; // Reset at 4am local time (for late-night doomscrollers)

function getTodayDateString(): string {
  const now = new Date();

  // If it's before 4am, consider it part of the previous day
  // This helps late-night users not get a fresh session at midnight
  if (now.getHours() < DAY_RESET_HOUR) {
    now.setDate(now.getDate() - 1);
  }

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Get or initialize global session
export async function getGlobalSession(): Promise<GlobalSession> {
  const result = await chrome.storage.local.get('globalSession');
  const today = getTodayDateString();
  const stored = result.globalSession as GlobalSession | undefined;

  // If no session or different day, reset
  if (!stored || stored.resetDate !== today) {
    // Archive the old session before resetting (for calibration feedback)
    if (stored && stored.resetDate !== today) {
      const yesterday = {
        date: stored.resetDate,
        minutes: stored.totalMinutes,
        maxPhase: stored.maxPhaseReached || 'normal',
      };
      await chrome.storage.local.set({ yesterdaySession: yesterday });
      log.debug(' Archived yesterday session:', yesterday);
    }

    const newSession: GlobalSession = {
      startTimestamp: Date.now(),
      totalMinutes: 0,
      lastHeartbeat: Date.now(),
      resetDate: today,
      maxPhaseReached: 'normal',
    };
    await chrome.storage.local.set({ globalSession: newSession });
    log.debug(' New daily session started');
    return newSession;
  }

  // Ensure maxPhaseReached exists (migration for existing sessions)
  if (!stored.maxPhaseReached) {
    stored.maxPhaseReached = 'normal';
  }

  return stored;
}

// Record a heartbeat from any social media site
export async function recordHeartbeat(): Promise<void> {
  const session = await getGlobalSession();
  const settings = await getSettings();
  const now = Date.now();

  // Calculate time since last heartbeat
  const timeSinceLastBeat = now - session.lastHeartbeat;

  // Only add time if heartbeats are continuous (within threshold)
  // This prevents inflating time when tabs are left open but inactive
  if (timeSinceLastBeat <= HEARTBEAT_GAP_THRESHOLD_MS) {
    const minutesToAdd = timeSinceLastBeat / (60 * 1000);
    session.totalMinutes += minutesToAdd;
  }

  session.lastHeartbeat = now;

  // Update max phase reached
  const currentPhase = getCurrentPhase(session.totalMinutes, settings.scheduler.phaseThresholds);
  const phaseOrder = ['normal', 'reduced', 'wind-down', 'minimal'] as const;
  const currentPhaseIndex = phaseOrder.indexOf(currentPhase);
  const maxPhaseIndex = phaseOrder.indexOf(session.maxPhaseReached);
  if (currentPhaseIndex > maxPhaseIndex) {
    session.maxPhaseReached = currentPhase;
  }

  await chrome.storage.local.set({ globalSession: session });
}

// Get total session minutes today (for progressive boredom)
// If testBoredomMinutes is set in storage, use that for testing
export async function getSessionMinutes(): Promise<number> {
  // Check for test override first
  const testResult = await chrome.storage.local.get('testBoredomMinutes');
  if (testResult.testBoredomMinutes && testResult.testBoredomMinutes > 0) {
    return testResult.testBoredomMinutes;
  }

  const session = await getGlobalSession();
  return session.totalMinutes;
}

// Get current phase based on session duration
export function getCurrentPhase(
  sessionMinutes: number,
  thresholds: { normal: number; reduced: number; windDown: number }
): 'normal' | 'reduced' | 'wind-down' | 'minimal' {
  if (sessionMinutes >= thresholds.windDown) return 'minimal';
  if (sessionMinutes >= thresholds.reduced) return 'wind-down';
  if (sessionMinutes >= thresholds.normal) return 'reduced';
  return 'normal';
}

// ==========================================
// Adaptive Calibration Storage
// ==========================================

// Get adaptive settings
export async function getAdaptiveSettings(): Promise<AdaptiveSettings> {
  const result = await chrome.storage.local.get('adaptiveSettings');
  return result.adaptiveSettings || { ...DEFAULT_ADAPTIVE_SETTINGS };
}

// Save adaptive settings
export async function setAdaptiveSettings(settings: AdaptiveSettings): Promise<void> {
  await chrome.storage.local.set({ adaptiveSettings: settings });
}

// Check if we should show the feedback prompt
// Returns true if: yesterday had significant usage AND we haven't asked yet today
export async function shouldShowFeedbackPrompt(): Promise<{
  show: boolean;
  yesterdaySession?: {
    minutes: number;
    maxPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
  };
}> {
  const adaptive = await getAdaptiveSettings();
  const today = getTodayDateString();

  // Already gave feedback today
  if (adaptive.lastFeedbackDate === today) {
    return { show: false };
  }

  // Get yesterday's session data
  const yesterday = getYesterdayDateString();
  const result = await chrome.storage.local.get('yesterdaySession');
  const yesterdaySession = result.yesterdaySession as {
    date: string;
    minutes: number;
    maxPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
  } | undefined;

  // No data from yesterday or it's from a different day
  if (!yesterdaySession || yesterdaySession.date !== yesterday) {
    return { show: false };
  }

  // Only ask if they reached at least 'reduced' phase (meaningful usage)
  const phaseOrder = ['normal', 'reduced', 'wind-down', 'minimal'] as const;
  const phaseIndex = phaseOrder.indexOf(yesterdaySession.maxPhase);
  if (phaseIndex < 1) {
    return { show: false };
  }

  return {
    show: true,
    yesterdaySession: {
      minutes: yesterdaySession.minutes,
      maxPhase: yesterdaySession.maxPhase,
    },
  };
}

// Archive today's session as yesterday (call at midnight or on new day)
export async function archiveTodaySession(): Promise<void> {
  const session = await getGlobalSession();
  const yesterday = {
    date: session.resetDate,
    minutes: session.totalMinutes,
    maxPhase: session.maxPhaseReached,
  };
  await chrome.storage.local.set({ yesterdaySession: yesterday });
}

// Submit calibration feedback and adjust settings
export async function submitCalibrationFeedback(
  response: 'restricted' | 'balanced' | 'too_easy'
): Promise<AdaptiveSettings> {
  const adaptive = await getAdaptiveSettings();
  const today = getTodayDateString();

  // Get yesterday's session for the feedback record
  const result = await chrome.storage.local.get('yesterdaySession');
  const yesterdaySession = result.yesterdaySession as {
    date: string;
    minutes: number;
    maxPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
  } | undefined;

  // Record the feedback
  const feedback: CalibrationFeedback = {
    date: yesterdaySession?.date || getYesterdayDateString(),
    sessionMinutes: yesterdaySession?.minutes || 0,
    maxPhase: yesterdaySession?.maxPhase || 'normal',
    response,
    timestamp: Date.now(),
  };

  // Keep last 30 days of feedback
  adaptive.feedbackHistory = [
    ...adaptive.feedbackHistory.slice(-29),
    feedback,
  ];
  adaptive.lastFeedbackDate = today;

  // Adjust settings based on response
  // Use exponential smoothing for gradual adjustment
  const adjustmentStep = 5; // Points to adjust threshold
  const speedStep = 0.1;    // Multiplier adjustment

  switch (response) {
    case 'restricted':
      // User felt deprived - ease off
      // Raise blur threshold (fewer posts blurred)
      adaptive.blurThresholdOffset = Math.min(20, adaptive.blurThresholdOffset + adjustmentStep);
      // Slow down phase progression
      adaptive.phaseSpeedMultiplier = Math.max(0.5, adaptive.phaseSpeedMultiplier - speedStep);
      adaptive.adjustmentVelocity = Math.max(-1, adaptive.adjustmentVelocity - 0.2);
      log.debug(' Calibration - easing off (user felt restricted)');
      break;

    case 'too_easy':
      // User still scrolled too much - tighten up
      // Lower blur threshold (more posts blurred)
      adaptive.blurThresholdOffset = Math.max(-20, adaptive.blurThresholdOffset - adjustmentStep);
      // Speed up phase progression
      adaptive.phaseSpeedMultiplier = Math.min(2.0, adaptive.phaseSpeedMultiplier + speedStep);
      adaptive.adjustmentVelocity = Math.min(1, adaptive.adjustmentVelocity + 0.2);
      log.debug(' Calibration - tightening (user scrolled too much)');
      break;

    case 'balanced':
      // In the sweet spot - decay velocity toward zero
      adaptive.adjustmentVelocity *= 0.5;
      log.debug(' Calibration - maintaining (user felt balanced)');
      break;
  }

  await setAdaptiveSettings(adaptive);
  return adaptive;
}

// Get effective blur threshold for a given phase
// Checks custom thresholds first, then falls back to base + adaptive offset
export async function getEffectiveBlurThreshold(
  phase: 'normal' | 'reduced' | 'wind-down' | 'minimal',
  adaptiveOffset: number
): Promise<number> {
  // Check for custom thresholds first
  const settings = await getSettings();
  if (settings.customThresholds?.enabled) {
    const customThresholds = settings.customThresholds.blurThresholds;
    const phaseKey = phase === 'wind-down' ? 'windDown' : phase;
    const customThreshold = customThresholds[phaseKey as keyof typeof customThresholds];
    if (customThreshold !== undefined) {
      // Apply adaptive offset to custom threshold too
      const adjusted = customThreshold + adaptiveOffset;
      return Math.max(20, Math.min(100, adjusted));
    }
  }

  // Base thresholds (score at or above this gets blurred)
  // Normal phase = no intervention (threshold 100 = nothing blurred)
  // This gives users 15 min of baseline experience before intervention starts
  const baseThresholds: Record<string, number> = {
    'normal': 100,     // No blurring - baseline experience for first 15 min
    'reduced': 55,     // Only clearly high-engagement
    'wind-down': 45,   // High + upper medium
    'minimal': 30,     // Almost everything blurred after 75 min
  };

  const base = baseThresholds[phase] || 100;
  // Apply adaptive offset (positive = gentler = higher threshold)
  const adjusted = base + adaptiveOffset;

  // Clamp to reasonable bounds (allow up to 100 for no-blur phases)
  return Math.max(20, Math.min(100, adjusted));
}

// Get effective phase thresholds (adjusted by speed multiplier)
export function getEffectivePhaseThresholds(
  baseThresholds: { normal: number; reduced: number; windDown: number },
  speedMultiplier: number
): { normal: number; reduced: number; windDown: number } {
  // Higher multiplier = faster progression = lower thresholds
  // Lower multiplier = slower progression = higher thresholds
  return {
    normal: Math.round(baseThresholds.normal / speedMultiplier),
    reduced: Math.round(baseThresholds.reduced / speedMultiplier),
    windDown: Math.round(baseThresholds.windDown / speedMultiplier),
  };
}

// Helper to get yesterday's date string
function getYesterdayDateString(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
}
