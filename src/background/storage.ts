import { log } from '../shared/constants';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { LEGACY_FALLBACK_REASON } from '../shared/score-parse';
import { activeRubric, rubricHash, SCORING_SPEC_VERSION } from '../shared/scoring-spec';
import {
  SessionLog,
  PostImpression,
  DwellUpdate,
  ScrollBucket,
  EngagementScore,
  PostContent,
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
import { SEED_NARRATIVE_THEMES, DEFAULT_BLUR_THRESHOLDS } from '../shared/constants';
import { mergeDwellIntoImpressions, mergeScrollBuckets } from '../shared/attention-utils';
import { archiveUsageDay, recentUsageDays, UsageDay, UsageHistory } from '../shared/usage-history';
import { addTopicHit, customThemesFirst, TopicHits } from '../shared/topics';

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
    value: CalibrationEntry;
  };
  postContent: {
    key: string; // postId
    value: PostContent;
  };
}

const DB_NAME = 'tolerance';
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<ToleranceDB>> | null = null;

function getDB(): Promise<IDBPDatabase<ToleranceDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ToleranceDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          // Sessions store
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          sessionStore.createIndex('by-start', 'startTime');

          // Scores cache store
          const scoresStore = db.createObjectStore('scores', { keyPath: 'postId' });
          scoresStore.createIndex('by-timestamp', 'timestamp');

          // Calibration data
          db.createObjectStore('calibration', { keyPath: 'postId' });
        }
        if (oldVersion < 2) {
          // Post content store (deduplicated by postId)
          db.createObjectStore('postContent', { keyPath: 'postId' });
        }
      },
    });
    // Don't keep a failed open: the next call should try again
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

// Change the current session inside one transaction. Reading the session, changing it
// and writing it back as separate steps let two updates that arrive together (impressions
// from one tab, attention from another) overwrite each other.
async function updateCurrentSession(change: (session: SessionLog) => void): Promise<SessionLog | null> {
  const state = await getState();
  if (!state.currentSessionId) return null;

  const db = await getDB();
  const tx = db.transaction('sessions', 'readwrite');
  const session = await tx.store.get(state.currentSessionId);
  if (session) {
    change(session);
    await tx.store.put(session);
  }
  await tx.done;
  return session ?? null;
}

// State management (using chrome.storage.local for small state)
export async function getState(): Promise<AppState> {
  const result = await chrome.storage.local.get<{ state?: AppState }>('state');
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
  log.debug(`: Created session ${session.sessionId} for tab ${tabId}`);

  return session;
}

export async function getCurrentSession(): Promise<SessionLog | null> {
  const state = await getState();
  if (!state.currentSessionId) return null;

  const db = await getDB();
  return (await db.get('sessions', state.currentSessionId)) || null;
}

// Merge attention deltas (dwell per post, scroll per minute) into the current session
export async function logAttention(
  dwellUpdates: DwellUpdate[],
  scrollBuckets: ScrollBucket[]
): Promise<void> {
  let matched = 0;
  // Updates held from earlier go in with this batch; whatever still has no post waits again
  const updates = [...takeHeldDwell(), ...dwellUpdates];
  const unmatched: DwellUpdate[] = [];
  const session = await updateCurrentSession(session => {
    matched = mergeDwellIntoImpressions(session.posts, updates, unmatched);
    if (scrollBuckets.length > 0) {
      session.scroll = mergeScrollBuckets(session.scroll ?? [], scrollBuckets);
    }
  });
  if (!session) {
    holdDwell(updates);
    log.warn(': No session found for logging attention');
    return;
  }
  holdDwell(unmatched);
  log.debug(`: Attention merged - ${matched}/${updates.length} dwell updates, ${scrollBuckets.length} scroll buckets`);
}

// Time-on-screen updates whose post hasn't been logged yet. A page starts timing a post
// when it is scored and logs the post a moment later, so the first update can arrive
// first; it used to be dropped, leaving the post's total short by its first seconds.
// Held in memory only (lost if the background restarts) and capped.
const HELD_DWELL_MAX = 1000;
const heldDwell = new Map<string, DwellUpdate>();

function holdDwell(updates: DwellUpdate[]): void {
  for (const u of updates) {
    const held = heldDwell.get(u.postId);
    if (held) {
      held.dwellMs += u.dwellMs;
      held.enters += u.enters;
      held.maxContinuousMs = Math.max(held.maxContinuousMs, u.maxContinuousMs);
    } else {
      heldDwell.set(u.postId, { ...u });
    }
  }
  // Oldest first out: a post that is never logged shouldn't hold a place for ever
  while (heldDwell.size > HELD_DWELL_MAX) heldDwell.delete(heldDwell.keys().next().value!);
}

// Forget held updates: they belong to the session that just ended
export function clearHeldDwell(): void {
  heldDwell.clear();
}

function takeHeldDwell(): DwellUpdate[] {
  const held = [...heldDwell.values()];
  heldDwell.clear();
  return held;
}

export async function logImpressions(impressions: PostImpression[]): Promise<void> {
  // Time on screen that arrived before these posts were logged now has somewhere to go
  const held = takeHeldDwell();
  const stillHeld: DwellUpdate[] = [];
  const session = await updateCurrentSession(session => {
    session.posts.push(...impressions);
    for (const imp of impressions) {
      session.engagementDistribution[imp.bucket]++;
    }
    mergeDwellIntoImpressions(session.posts, held, stillHeld);
  });
  holdDwell(session ? stillHeld : held);
  if (!session) {
    log.warn(': No session found for logging impressions');
    return;
  }
  log.debug(`: Logged ${impressions.length} impressions to session ${session.sessionId}`);
}

export async function endSession(): Promise<void> {
  const session = await updateCurrentSession(session => {
    session.endTime = Date.now();
  });
  if (!session) return;
  clearHeldDwell();
  await setState({ currentSessionId: null, sessionTabId: null });
}

// Score caching
const SCORE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function getCachedScores(postIds: string[]): Promise<Map<string, EngagementScore>> {
  const db = await getDB();
  const result = new Map<string, EngagementScore>();
  const now = Date.now();
  const settings = await getSettings();
  const hash = rubricHash(activeRubric(settings.scoringRubric));
  const { topicsChangedAt } = await chrome.storage.local.get('topicsChangedAt');

  // One transaction for the whole batch, not one per post
  const tx = db.transaction('scores');
  const records = await Promise.all(postIds.map(id => tx.store.get(id)));

  for (const [i, id] of postIds.entries()) {
    const cached = records[i];
    // Scores from an older scoring spec or another rubric are re-scored rather than mixed with new ones.
    // So are scores from before the topics or ad setting last changed, or the change wouldn't apply for up to a day.
    if (cached && now - cached.timestamp < SCORE_TTL_MS && !cached.scoreFailed &&
        cached.timestamp >= ((topicsChangedAt as number | undefined) ?? 0) &&
        cached.apiReason !== LEGACY_FALLBACK_REASON && cached.specVersion === SCORING_SPEC_VERSION &&
        cached.rubricHash === hash &&
        Number.isFinite(cached.apiScore)) {
      result.set(id, cached);
    }
  }

  return result;
}

// Raw cache records (including failed / expired ones) for the debug report
export async function getScoreRecords(postIds: string[]): Promise<Record<string, EngagementScore | null>> {
  const db = await getDB();
  const out: Record<string, EngagementScore | null> = {};
  for (const id of postIds) out[id] = (await db.get('scores', id)) ?? null;
  return out;
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

// One stored calibration record: the score plus whatever post details were logged with it
export interface CalibrationEntry extends CalibrationMetadata {
  postId: string;
  apiScore: number;
  timestamp: number;
  heuristicScore?: number;  // Only on records from before heuristic scoring was removed
}

// What can be logged alongside a calibration score
export interface CalibrationMetadata {
    // Core content
    permalink?: string;
    title?: string;
    subreddit?: string;
    // Engagement metrics (important for fine-tuning - model sees these)
    score?: number | null;      // Upvotes
    numComments?: number;
    upvoteRatio?: number;
    // Post metadata
    mediaType?: 'text' | 'image' | 'video' | 'link' | 'gallery' | 'gif' | 'reel';
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
}

// How far past maxEntries the calibration store may grow before it is pruned back
export const CALIBRATION_PRUNE_SLACK = 25;

// Calibration data (for fine-tuning)
export async function logCalibration(
  postId: string,
  apiScore: number,
  metadata?: CalibrationMetadata
): Promise<void> {
  const db = await getDB();
  const settings = await getSettings();

  // Only store API reason/response if setting allows it
  const storeReason = settings.calibration?.storeApiReason !== false;

  // Don't store base64 data URLs - only store actual URLs
  const imageUrl = metadata?.imageUrl?.startsWith('data:') ? undefined : metadata?.imageUrl;
  const thumbnailUrl = metadata?.thumbnailUrl?.startsWith('data:') ? undefined : metadata?.thumbnailUrl;

  await db.put('calibration', {
    postId,
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
    // Media URLs (only actual URLs, not base64)
    imageUrl,
    thumbnailUrl,
    // API response data
    apiReason: storeReason ? metadata?.apiReason : undefined,
    apiFullResponse: storeReason ? metadata?.apiFullResponse : undefined,
  });

  // Cleanup old entries if maxEntries is set. Pruning has to load every entry to find
  // the oldest, so let the store run a little over and prune in batches, not on every
  // post once it is full.
  const maxEntries = settings.calibration?.maxEntries ?? 500;
  if (maxEntries > 0 && await db.count('calibration') > maxEntries + CALIBRATION_PRUNE_SLACK) {
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

// Post content storage (for ML training data)
export async function savePostContent(posts: PostContent[]): Promise<void> {
  const settings = await getSettings();
  if (!settings.calibration?.storePostContent) return;

  const db = await getDB();
  const tx = db.transaction('postContent', 'readwrite');

  for (const post of posts) {
    await tx.store.put(post);
  }

  await tx.done;
}

export async function getAllPostContent(): Promise<PostContent[]> {
  const db = await getDB();
  return db.getAll('postContent');
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

// The latest sessions, most recent first, without loading every session
export async function getRecentSessions(limit: number): Promise<SessionLog[]> {
  const db = await getDB();
  const recent: SessionLog[] = [];
  let cursor = await db.transaction('sessions').store.index('by-start').openCursor(null, 'prev');
  while (cursor && recent.length < limit) {
    recent.push(cursor.value);
    cursor = await cursor.continue();
  }
  return recent;
}

export async function getCalibrationData(): Promise<CalibrationEntry[]> {
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
  // These stats compare the API score with the old heuristic score, so only records
  // that have one count (none written since heuristic scoring was removed)
  const data = allData
    .filter(d => d.timestamp >= cutoff)
    .flatMap(d => d.heuristicScore === undefined ? [] : [{ apiScore: d.apiScore, heuristicScore: d.heuristicScore }]);

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

  return customThemesFirst(result.narrativeThemes as NarrativeTheme[]);
}

// Tally a post a topic caught, for the dashboard
export async function recordTopicHits(caught: { themeId: string; reason?: string }[]): Promise<void> {
  if (caught.length === 0) return;
  const { topicHits } = await chrome.storage.local.get('topicHits');
  const today = getTodayDateString();
  let hits = (topicHits as TopicHits | undefined) ?? {};
  for (const { themeId, reason } of caught) hits = addTopicHit(hits, themeId, today, reason);
  await chrome.storage.local.set({ topicHits: hits });
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

  await chrome.storage.local.set({ narrativeThemes: themes, topicsChangedAt: Date.now() });
}

// Delete a narrative theme by ID
export async function deleteNarrativeTheme(themeId: string): Promise<boolean> {
  const themes = await getNarrativeThemes();
  const index = themes.findIndex(t => t.id === themeId);

  if (index >= 0) {
    // Don't allow deleting system themes
    if (themes[index].isSystemTheme) {
      return false;
    }
    themes.splice(index, 1);
    await chrome.storage.local.set({ narrativeThemes: themes, topicsChangedAt: Date.now() });

    // Cascade: delete any counter-strategies referencing this theme
    const strategies = await getCounterStrategies();
    const filteredStrategies = strategies.filter(s => s.themeId !== themeId);
    if (filteredStrategies.length !== strategies.length) {
      await chrome.storage.local.set({ counterStrategies: filteredStrategies });
    }

    return true;
  }
  return false;
}

// Get emerging (pending) narratives
export async function getEmergingNarratives(): Promise<EmergingNarrative[]> {
  const result = await chrome.storage.local.get<{ emergingNarratives?: EmergingNarrative[] }>('emergingNarratives');
  return result.emergingNarratives || [];
}

// Save emerging narratives
export async function saveEmergingNarratives(narratives: EmergingNarrative[]): Promise<void> {
  await chrome.storage.local.set({ emergingNarratives: narratives });
}

// Get counter-strategies
export async function getCounterStrategies(): Promise<CounterStrategy[]> {
  const result = await chrome.storage.local.get<{ counterStrategies?: CounterStrategy[] }>('counterStrategies');
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

  await chrome.storage.local.set({ counterStrategies: strategies, topicsChangedAt: Date.now() });
}

// Delete a counter-strategy
export async function deleteCounterStrategy(strategyId: string): Promise<void> {
  const strategies = await getCounterStrategies();
  const filtered = strategies.filter(s => s.id !== strategyId);
  await chrome.storage.local.set({ counterStrategies: filtered, topicsChangedAt: Date.now() });
}

// ==========================================
// Global Session Tracking (Cross-Platform)
// ==========================================

const HEARTBEAT_GAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes - if gap is larger, assume user was away
const DAY_RESET_HOUR = 4; // Reset at 4am local time (for late-night doomscrollers)

// The usage day `daysAgo` days back. Days run 4am to 4am: before 4am still counts as
// the previous day, so late-night use doesn't get a fresh session at midnight.
function usageDateString(daysAgo: number): string {
  const now = new Date();
  if (now.getHours() < DAY_RESET_HOUR) {
    now.setDate(now.getDate() - 1);
  }
  now.setDate(now.getDate() - daysAgo);

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function getTodayDateString(): string {
  return usageDateString(0);
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
      const { usageHistory } = await chrome.storage.local.get('usageHistory');
      await chrome.storage.local.set({
        yesterdaySession: yesterday,
        usageHistory: archiveUsageDay((usageHistory as UsageHistory | undefined) ?? {}, stored.resetDate, stored.totalMinutes, today),
      });
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

// Minutes per day for the usage chart, ending today. Days from before the history
// existed are unknown, apart from the last one, which yesterdaySession already holds.
export async function getUsageDays(count: number): Promise<UsageDay[]> {
  const session = await getGlobalSession();
  const { usageHistory, yesterdaySession } = await chrome.storage.local.get(['usageHistory', 'yesterdaySession']);
  const yesterday = yesterdaySession as { date: string; minutes: number } | undefined;
  const history: UsageHistory = {
    ...(yesterday ? { [yesterday.date]: yesterday.minutes } : {}),
    ...(usageHistory as UsageHistory | undefined),
  };
  return recentUsageDays(history, session.resetDate, session.totalMinutes, count);
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
  const testResult = await chrome.storage.local.get<{ testBoredomMinutes?: number }>('testBoredomMinutes');
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
  const result = await chrome.storage.local.get<{ adaptiveSettings?: AdaptiveSettings }>('adaptiveSettings');
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

  // Map phase names to threshold keys (phase uses 'wind-down', constants use 'windDown')
  const phaseToKey: Record<string, keyof typeof DEFAULT_BLUR_THRESHOLDS> = {
    'normal': 'normal',
    'reduced': 'reduced',
    'wind-down': 'windDown',
    'minimal': 'minimal',
  };

  const key = phaseToKey[phase] || 'normal';
  const base = DEFAULT_BLUR_THRESHOLDS[key];
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

// The usage day before today's, on the same 4am-to-4am days as getTodayDateString.
// (It used to be the calendar day before, so between midnight and 4am "yesterday"
// and "today" were the same date and the feedback prompt never matched.)
function getYesterdayDateString(): string {
  return usageDateString(1);
}
