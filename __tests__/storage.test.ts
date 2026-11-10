import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { EngagementScore, PostImpression } from '../src/shared/types';
import { SCORING_SPEC_VERSION } from '../src/shared/scoring-spec';

// The extension's database code, run against an in-memory IndexedDB and an in-memory
// stand-in for chrome.storage.local.

const kv = new Map<string, unknown>();
beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (keys?: string | string[]) => {
          const wanted = keys === undefined ? [...kv.keys()] : typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(wanted.filter(k => kv.has(k)).map(k => [k, structuredClone(kv.get(k))]));
        },
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) kv.set(k, structuredClone(v));
        },
      },
    },
  };
});

let storage: typeof import('../src/background/storage');
beforeAll(async () => {
  storage = await import('../src/background/storage');
});

// Each test starts with empty stores (the module keeps one open connection)
async function clearDatabase(): Promise<void> {
  const { openDB } = await import('idb');
  const db = await openDB('tolerance');
  for (const name of db.objectStoreNames) await db.clear(name);
  db.close();
}

beforeEach(async () => {
  kv.clear();
  await storage.getAllSessions(); // makes sure the database exists
  await clearDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

function impression(postId: string, bucket: PostImpression['bucket'] = 'medium'): PostImpression {
  return {
    timestamp: Date.now(), postId, score: 60, bucket, position: 0, originalPosition: 0,
    subreddit: 'test', wasReordered: false,
  };
}

function score(postId: string, over: Partial<EngagementScore> = {}): EngagementScore {
  return {
    postId, apiScore: 70, bucket: 'high', factors: {}, timestamp: Date.now(),
    specVersion: SCORING_SPEC_VERSION, ...over,
  };
}

describe('sessions', () => {
  it('creates a session and makes it current', async () => {
    const session = await storage.createSession('active', 7);
    expect((await storage.getState()).currentSessionId).toBe(session.sessionId);
    expect((await storage.getState()).sessionTabId).toBe(7);
    expect(await storage.getCurrentSession()).toMatchObject({ sessionId: session.sessionId, posts: [] });
  });

  it('logs impressions and counts them by bucket', async () => {
    await storage.createSession('active');
    await storage.logImpressions([impression('a', 'high'), impression('b', 'low'), impression('c', 'high')]);
    const session = await storage.getCurrentSession();
    expect(session?.posts.map(p => p.postId)).toEqual(['a', 'b', 'c']);
    expect(session?.engagementDistribution).toEqual({ high: 2, medium: 0, low: 1 });
  });

  it('keeps every impression when batches arrive at the same time', async () => {
    await storage.createSession('active');
    const batches = Array.from({ length: 20 }, (_, i) => [impression(`p${i}a`), impression(`p${i}b`)]);
    await Promise.all(batches.map(b => storage.logImpressions(b)));
    const session = await storage.getCurrentSession();
    expect(session?.posts).toHaveLength(40);
    expect(session?.engagementDistribution.medium).toBe(40);
  });

  it('keeps both when impressions and attention arrive at the same time', async () => {
    await storage.createSession('active');
    await storage.logImpressions([impression('a')]);
    await Promise.all([
      storage.logImpressions([impression('b')]),
      storage.logAttention(
        [{ postId: 'a', dwellMs: 1500, enters: 1, maxContinuousMs: 1500 }],
        [{ minute: 100, scrolledPx: 900, maxVelocityPxS: 50, scrollActiveMs: 400 }]
      ),
      storage.logImpressions([impression('c')]),
    ]);
    const session = await storage.getCurrentSession();
    expect(session?.posts.map(p => p.postId).sort()).toEqual(['a', 'b', 'c']);
    expect(session?.posts.find(p => p.postId === 'a')?.dwellMs).toBe(1500);
    expect(session?.scroll).toEqual([{ minute: 100, scrolledPx: 900, maxVelocityPxS: 50, scrollActiveMs: 400 }]);
  });

  it('drops impressions and attention quietly when there is no session', async () => {
    await storage.logImpressions([impression('a')]);
    await storage.logAttention([{ postId: 'a', dwellMs: 1, enters: 1, maxContinuousMs: 1 }], []);
    expect(await storage.getAllSessions()).toEqual([]);
  });

  it('ends the session: sets an end time and clears the current session', async () => {
    const session = await storage.createSession('active', 3);
    await storage.logImpressions([impression('a')]);
    await storage.endSession();
    expect((await storage.getState()).currentSessionId).toBeNull();
    expect((await storage.getState()).sessionTabId).toBeNull();
    const [stored] = await storage.getAllSessions();
    expect(stored.sessionId).toBe(session.sessionId);
    expect(stored.endTime).toBeGreaterThanOrEqual(stored.startTime);
    expect(stored.posts).toHaveLength(1);
  });

  it('returns sessions oldest first, and the recent ones newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(2026, 5, 1, 12, i));
      ids.push((await storage.createSession('active')).sessionId);
    }
    expect((await storage.getAllSessions()).map(s => s.sessionId)).toEqual(ids);
    expect((await storage.getRecentSessions(2)).map(s => s.sessionId)).toEqual([ids[4], ids[3]]);
    expect(await storage.getRecentSessions(50)).toHaveLength(5);
  });

  it('finds sessions that started inside a time range', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const times = [10, 20, 30].map(m => new Date(2026, 5, 1, 12, m).getTime());
    for (const t of times) {
      vi.setSystemTime(t);
      await storage.createSession('active');
    }
    const found = await storage.getSessionsInRange(times[1], times[2]);
    expect(found.map(s => s.startTime)).toEqual([times[1], times[2]]);
  });
});

describe('score cache', () => {
  it('returns a fresh score from the current spec', async () => {
    await storage.cacheScores([score('a')]);
    const cached = await storage.getCachedScores(['a', 'missing']);
    expect([...cached.keys()]).toEqual(['a']);
  });

  it.each([
    ['older than a day', { timestamp: Date.now() - 25 * 60 * 60 * 1000 }],
    ['a failed score', { scoreFailed: true }],
    ['from an older scoring spec', { specVersion: SCORING_SPEC_VERSION - 1 }],
    ['with no spec recorded', { specVersion: undefined }],
    ['from an edited rubric', { rubricHash: 'abcd1234' }],
    ['not a number', { apiScore: Number.NaN }],
  ])('skips a cached score that is %s', async (_name, over) => {
    await storage.cacheScores([score('a', over), score('ok')]);
    const cached = await storage.getCachedScores(['a', 'ok']);
    expect([...cached.keys()]).toEqual(['ok']);
  });

  it('skips scores from before the topics last changed', async () => {
    await storage.cacheScores([score('old', { timestamp: Date.now() - 60_000 }), score('new')]);
    kv.set('topicsChangedAt', Date.now() - 30_000);
    const cached = await storage.getCachedScores(['old', 'new']);
    expect([...cached.keys()]).toEqual(['new']);
  });

  it('cleanup deletes only scores older than a day', async () => {
    await storage.cacheScores([score('old', { timestamp: Date.now() - 25 * 60 * 60 * 1000 }), score('new')]);
    await storage.cleanupOldScores();
    const left = await storage.getScoreRecords(['old', 'new']);
    expect(left.old).toBeNull();
    expect(left.new?.postId).toBe('new');
  });

  it('clearing the cache reports how many it removed', async () => {
    await storage.cacheScores([score('a'), score('b'), score('c')]);
    expect(await storage.clearScoreCache()).toBe(3);
    expect((await storage.getCachedScores(['a', 'b', 'c'])).size).toBe(0);
  });
});

describe('calibration log', () => {
  it('stores the score with its details, but never inline image data', async () => {
    await storage.logCalibration('a', 80, {
      title: 'A post', imageUrl: 'data:image/png;base64,AAAA', thumbnailUrl: 'https://example.com/t.jpg',
      apiReason: 'curiosity gap',
    });
    const [entry] = await storage.getCalibrationData();
    expect(entry).toMatchObject({ postId: 'a', apiScore: 80, title: 'A post', apiReason: 'curiosity gap' });
    expect(entry.imageUrl).toBeUndefined();
    expect(entry.thumbnailUrl).toBe('https://example.com/t.jpg');
  });

  it('leaves out the reason when that setting is off', async () => {
    await storage.setSettings({ calibration: { storeApiReason: false, storePostContent: false } });
    await storage.logCalibration('a', 80, { apiReason: 'curiosity gap', apiFullResponse: { x: 1 } });
    const [entry] = await storage.getCalibrationData();
    expect(entry.apiReason).toBeUndefined();
    expect(entry.apiFullResponse).toBeUndefined();
  });

  it('prunes back to the newest maxEntries once it runs over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const max = 10;
    await storage.setSettings({ calibration: { storeApiReason: true, storePostContent: false, maxEntries: max } });
    const total = max + storage.CALIBRATION_PRUNE_SLACK + 1;
    for (let i = 0; i < total; i++) {
      vi.setSystemTime(new Date(2026, 5, 1, 12, 0, i));
      await storage.logCalibration(`p${i}`, 50);
      // Never more than the cap plus the slack
      expect((await storage.getCalibrationData()).length).toBeLessThanOrEqual(max + storage.CALIBRATION_PRUNE_SLACK);
    }
    const kept = (await storage.getCalibrationData()).map(e => e.postId);
    expect(kept).toHaveLength(max);
    expect(kept).toContain(`p${total - 1}`);
    expect(kept).not.toContain('p0');
  });

  it('keeps everything when maxEntries is 0', async () => {
    await storage.setSettings({ calibration: { storeApiReason: true, storePostContent: false, maxEntries: 0 } });
    for (let i = 0; i < 40; i++) await storage.logCalibration(`p${i}`, 50);
    expect(await storage.getCalibrationData()).toHaveLength(40);
  });

  it('stats only count records that still have a heuristic score', async () => {
    await storage.logCalibration('new', 80);
    expect(await storage.getCalibrationStats('all')).toMatchObject({ sampleSize: 0, avgDelta: 0 });
  });
});

describe('post content', () => {
  const post = { postId: 'a', platform: 'reddit' as const, text: 'hello', author: 'someone', timestamp: 1 };

  it('is not stored unless the setting is on', async () => {
    await storage.savePostContent([post]);
    expect(await storage.getAllPostContent()).toEqual([]);
  });

  it('is stored once per post when the setting is on', async () => {
    await storage.setSettings({ calibration: { storeApiReason: true, storePostContent: true } });
    await storage.savePostContent([post]);
    await storage.savePostContent([{ ...post, text: 'hello again' }]);
    expect(await storage.getAllPostContent()).toEqual([{ ...post, text: 'hello again' }]);
  });
});

describe('daily usage', () => {
  it('counts the day from 4am to 4am', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 10, 3, 59));
    expect(storage.getTodayDateString()).toBe('2026-06-09');
    vi.setSystemTime(new Date(2026, 5, 10, 4, 0));
    expect(storage.getTodayDateString()).toBe('2026-06-10');
  });

  it('adds time between heartbeats, but not across a gap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 5, 10, 12, 0, 0).getTime();
    vi.setSystemTime(start);
    await storage.recordHeartbeat();              // starts the day at 0
    vi.setSystemTime(start + 60_000);
    await storage.recordHeartbeat();              // +1 min
    vi.setSystemTime(start + 60_000 + 10 * 60_000);
    await storage.recordHeartbeat();              // 10 min gap: away, not counted
    vi.setSystemTime(start + 60_000 + 10 * 60_000 + 30_000);
    await storage.recordHeartbeat();              // +0.5 min
    expect(await storage.getSessionMinutes()).toBeCloseTo(1.5, 5);
  });

  it('starts a new day at 4am and files the old one in the history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = new Date(2026, 5, 10, 23, 0, 0).getTime();
    vi.setSystemTime(start);
    await storage.recordHeartbeat();
    vi.setSystemTime(start + 90_000);
    await storage.recordHeartbeat();              // 1.5 min on June 10

    vi.setSystemTime(new Date(2026, 5, 11, 2, 0));  // still June 10's day
    expect((await storage.getGlobalSession()).resetDate).toBe('2026-06-10');

    vi.setSystemTime(new Date(2026, 5, 11, 9, 0));
    const today = await storage.getGlobalSession();
    expect(today).toMatchObject({ resetDate: '2026-06-11', totalMinutes: 0 });
    expect(kv.get('usageHistory')).toEqual({ '2026-06-10': 1.5 });
    expect(kv.get('yesterdaySession')).toMatchObject({ date: '2026-06-10', minutes: 1.5 });

    const days = await storage.getUsageDays(3);
    expect(days.map(d => [d.date, d.minutes])).toEqual([['2026-06-09', null], ['2026-06-10', 1.5], ['2026-06-11', 0]]);
  });

  it('records the furthest phase reached in the day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const thresholds = (await storage.getSettings()).scheduler.phaseThresholds;
    const start = new Date(2026, 5, 10, 12, 0, 0).getTime();
    vi.setSystemTime(start);
    await storage.recordHeartbeat();
    // One-minute heartbeats until just past the first threshold
    for (let m = 1; m <= thresholds.normal + 1; m++) {
      vi.setSystemTime(start + m * 60_000);
      await storage.recordHeartbeat();
    }
    expect((await storage.getGlobalSession()).maxPhaseReached).toBe('reduced');
  });

  it('asks for feedback the day after meaningful use, including before 4am', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    kv.set('yesterdaySession', { date: '2026-06-09', minutes: 80, maxPhase: 'reduced' });

    // 9am on June 10: yesterday was June 9
    vi.setSystemTime(new Date(2026, 5, 10, 9, 0));
    expect((await storage.shouldShowFeedbackPrompt()).show).toBe(true);

    // 2am on June 11 is still June 10's day, so yesterday is still June 9
    vi.setSystemTime(new Date(2026, 5, 11, 2, 0));
    expect((await storage.shouldShowFeedbackPrompt()).show).toBe(true);

    // 9am on June 11: June 9 is no longer yesterday
    vi.setSystemTime(new Date(2026, 5, 11, 9, 0));
    expect((await storage.shouldShowFeedbackPrompt()).show).toBe(false);
  });

  it('does not ask for feedback after a light day or twice in a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 5, 10, 9, 0));
    kv.set('yesterdaySession', { date: '2026-06-09', minutes: 5, maxPhase: 'normal' });
    expect((await storage.shouldShowFeedbackPrompt()).show).toBe(false);

    kv.set('yesterdaySession', { date: '2026-06-09', minutes: 80, maxPhase: 'reduced' });
    await storage.submitCalibrationFeedback('balanced');
    expect((await storage.shouldShowFeedbackPrompt()).show).toBe(false);
  });
});

describe('feedback adjusts strictness', () => {
  beforeEach(() => {
    kv.set('yesterdaySession', { date: '2026-06-09', minutes: 80, maxPhase: 'reduced' });
  });

  it('eases off when the day felt restricted, within limits', async () => {
    let adaptive = await storage.submitCalibrationFeedback('restricted');
    expect(adaptive.blurThresholdOffset).toBe(5);
    expect(adaptive.phaseSpeedMultiplier).toBeCloseTo(0.9);
    for (let i = 0; i < 10; i++) adaptive = await storage.submitCalibrationFeedback('restricted');
    expect(adaptive.blurThresholdOffset).toBe(20);
    expect(adaptive.phaseSpeedMultiplier).toBeCloseTo(0.5);
  });

  it('tightens when the day was too easy, within limits', async () => {
    let adaptive = await storage.submitCalibrationFeedback('too_easy');
    expect(adaptive.blurThresholdOffset).toBe(-5);
    for (let i = 0; i < 12; i++) adaptive = await storage.submitCalibrationFeedback('too_easy');
    expect(adaptive.blurThresholdOffset).toBe(-20);
    expect(adaptive.phaseSpeedMultiplier).toBeCloseTo(2.0);
  });

  it('keeps the last 30 answers', async () => {
    let adaptive = await storage.getAdaptiveSettings();
    for (let i = 0; i < 35; i++) adaptive = await storage.submitCalibrationFeedback('balanced');
    expect(adaptive.feedbackHistory).toHaveLength(30);
    expect(adaptive.blurThresholdOffset).toBe(0);
  });
});
