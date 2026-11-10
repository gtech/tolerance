import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkExport, formatReport, type ExportReport } from '../src/shared/export-check';
import { impressionScoreFields } from '../src/shared/impression-fields';
import { AI_LABEL_PREFIX, SCORING_SPEC_VERSION, SPONSORED_PREFIX } from '../src/shared/scoring-spec';
import type { EngagementScore, PostImpression } from '../src/shared/types';

// The export checker: a record of what a trustworthy export looks like. Each rule here
// was first checked by hand on a real day of data (10 November 2026).

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// A small export in which everything is as it should be: one post in the older format,
// and three in the newer one (a scored post, a failed score, a post a topic adjusted)
function goodExport(): Loose {
  const oldPost = { timestamp: T0 + 1000, postId: 'old1', score: 60, bucket: 'medium', position: 0, originalPosition: 0, subreddit: 'askscience', wasReordered: false };
  const scored = {
    timestamp: T0 + 2000, postId: 'x1', score: 70, bucket: 'high', position: 1, originalPosition: 1, subreddit: '@someone', wasReordered: false,
    platform: 'twitter', specVersion: 10, dims: { hook: 7, effort: 2, pull: 6, value: 3 }, blurThreshold: 55, blurred: true,
    dwellMs: 4200, viewportEnters: 1, maxContinuousDwellMs: 4200, imageSeen: true,
  };
  const failed = {
    timestamp: T0 + 3000, postId: 'yt1', score: 50, bucket: 'medium', position: 2, originalPosition: 2, subreddit: 'A Channel', wasReordered: false,
    platform: 'youtube', scoreFailed: true, blurThreshold: 55, blurred: false,
  };
  const topic = {
    timestamp: T0 + 4000, postId: 'r1', score: 100, bucket: 'high', position: 3, originalPosition: 3, subreddit: 'news', wasReordered: false,
    platform: 'reddit', specVersion: 10, dims: { hook: 6, effort: 3, pull: 5, value: 4 }, blurThreshold: 55, blurred: true,
    narrativeThemeId: 'topic-1', modelScore: 60,
  };
  return {
    exportDate: new Date(T0 + 3_600_000).toISOString(),
    extensionVersion: '0.1.35', scoringSpecVersion: 10,
    minutesByDay: { '2026-11-10': 43.6 },
    topics: [{ id: 'topic-1', name: 'A topic' }],
    sessions: [{
      sessionId: 's1', startTime: T0, endTime: T0 + 600_000, mode: 'active',
      posts: [oldPost, scored, failed, topic],
      engagementDistribution: { high: 2, medium: 2, low: 0 },
      scroll: [
        { minute: Math.floor(T0 / 60000), scrolledPx: 9000, maxVelocityPxS: 3000, scrollActiveMs: 20000 },
        { minute: Math.floor(T0 / 60000) + 1, scrolledPx: 4000, maxVelocityPxS: 1500, scrollActiveMs: 8000 },
      ],
    }],
    postContent: [
      { postId: 'x1', platform: 'twitter', text: 'A post with a picture', author: 'someone', timestamp: T0 + 2000, mediaType: 'image',
        imageUrl: 'https://example.com/a.jpg', imageSeen: true, imageDescription: 'A bar chart of rainfall by month.', imageHash: '00ff00ff12345678' },
      { postId: 'ig1', platform: 'instagram', text: 'A caption', author: 'someone', timestamp: T0 + 2500 },
    ],
    calibration: [{ postId: 'r1', apiScore: 60, timestamp: T0 + 4000, title: 'A headline' }],
  };
}

const rules = (r: ExportReport) => r.findings.map(f => f.rule);
const post = (e: Loose, i: number) => e.sessions[0].posts[i];

describe('a consistent export', () => {
  it('has no findings', () => {
    const report = checkExport(goodExport());
    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ ok: true, errors: 0, warnings: 0 });
    expect(report.counts).toEqual({ sessions: 1, posts: 4, newFormatPosts: 3, postContent: 2, calibration: 1 });
  });

  it('is still consistent with the optional parts left out', () => {
    const e = goodExport();
    for (const key of ['postContent', 'calibration', 'minutesByDay', 'topics', 'scoringSpecVersion', 'exportDate']) delete e[key];
    delete e.sessions[0].scroll;
    delete e.sessions[0].endTime;
    expect(checkExport(e).findings).toEqual([]);
  });

  it('rejects something that is not an export', () => {
    for (const bad of [null, 'text', [], {}, { sessions: 'no' }]) {
      expect(rules(checkExport(bad))).toEqual(['export.shape']);
      expect(checkExport(bad).ok).toBe(false);
    }
  });
});

// Each case breaks one thing in the good export and names the rule that should catch it
const BROKEN: [string, 'error' | 'warning', string, (e: Loose) => void][] = [
  ['session.shape', 'error', 'a session with no start time', e => { delete e.sessions[0].startTime; }],
  ['session.duplicate-id', 'error', 'two sessions with one id', e => { e.sessions.push({ ...e.sessions[0] }); }],
  ['session.end-before-start', 'error', 'a session that ends before it starts', e => { e.sessions[0].endTime = T0 - 1; }],
  ['session.distribution', 'error', 'bucket totals that miss a post', e => { e.sessions[0].engagementDistribution.high = 1; }],
  ['session.scroll', 'error', 'a negative scroll distance', e => { e.sessions[0].scroll[0].scrolledPx = -5; }],
  ['session.scroll-order', 'error', 'a repeated scroll minute', e => { e.sessions[0].scroll[1].minute = e.sessions[0].scroll[0].minute; }],
  ['post.shape', 'error', 'a post with no id', e => { post(e, 0).postId = ''; e.sessions[0].engagementDistribution.medium = 1; }],
  ['post.shape', 'error', 'a post whose score is not a number', e => { post(e, 0).score = 'high'; e.sessions[0].engagementDistribution.medium = 1; }],
  ['post.score-range', 'error', 'a score above 100', e => { post(e, 0).score = 140; }],
  ['post.before-session', 'error', 'a post logged before its session began', e => { post(e, 0).timestamp = T0 - 600_000; }],
  ['export.future', 'error', 'a post dated after the export', e => { post(e, 0).timestamp = T0 + 7_200_000; e.sessions[0].endTime = T0 + 7_300_000; }],
  ['post.failed-score', 'error', 'a failed score that is not 50', e => { post(e, 2).score = 80; }],
  ['post.failed-score', 'error', 'a failed score with sub-scores', e => { post(e, 2).dims = { hook: 5, effort: 5, pull: 5, value: 5 }; }],
  ['post.dims-range', 'error', 'a sub-score of 0', e => { post(e, 1).dims.hook = 0; }],
  ['post.dims-range', 'error', 'a missing sub-score', e => { delete post(e, 1).dims.value; }],
  ['post.model-score', 'error', 'a model score above 100', e => { post(e, 3).modelScore = 600; }],
  ['post.platform', 'error', 'a platform that does not log posts', e => { post(e, 1).platform = 'instagram'; }],
  ['post.threshold', 'error', 'a newer post with no blur threshold', e => { delete post(e, 1).blurThreshold; }],
  ['post.threshold', 'error', 'a newer post with no blur decision', e => { delete post(e, 1).blurred; }],
  ['post.threshold', 'error', 'an older post with half of the newer fields', e => { post(e, 0).blurred = true; }],
  ['post.spec-ahead', 'error', 'a post from a newer spec than the export', e => { post(e, 1).specVersion = 11; }],
  ['post.source-format', 'error', 'an X post whose source is not a handle', e => { post(e, 1).subreddit = 'someone'; }],
  ['post.short', 'error', 'an X post marked as a Short', e => { post(e, 1).short = true; }],
  ['post.dwell', 'error', 'negative time on screen', e => { post(e, 1).dwellMs = -1; }],
  ['post.dwell', 'error', 'time on screen with a part missing', e => { delete post(e, 1).viewportEnters; }],
  ['post.image-seen', 'error', 'imageSeen that is not true or false', e => { post(e, 1).imageSeen = 'yes'; }],
  ['content.shape', 'error', 'stored text for an unknown platform', e => { e.postContent[0].platform = 'tiktok'; }],
  ['content.duplicate', 'error', 'a post stored twice', e => { e.postContent.push({ ...e.postContent[1] }); }],
  ['content.image-hash', 'error', 'a malformed fingerprint', e => { e.postContent[0].imageHash = 'xyz'; }],
  ['content.image-description', 'error', 'a description over the cap', e => { e.postContent[0].imageDescription = 'x'.repeat(301); }],
  ['content.image-unseen', 'error', 'a description for an image the model never saw', e => { e.postContent[0].imageSeen = false; }],
  ['content.image-seen', 'error', 'stored imageSeen that is not true or false', e => { e.postContent[1].imageSeen = 1; }],
  ['calibration.shape', 'error', 'a calibration entry with no score', e => { delete e.calibration[0].apiScore; }],
  ['calibration.duplicate', 'error', 'a post in the calibration log twice', e => { e.calibration.push({ ...e.calibration[0] }); }],
  ['calibration.score-range', 'error', 'a calibration score below 0', e => { e.calibration[0].apiScore = -10; }],
  ['calibration.data-url', 'error', 'an inline image in the calibration log', e => { e.calibration[0].imageUrl = 'data:image/png;base64,AAAA'; }],
  ['minutes.shape', 'error', 'more minutes than a day has', e => { e.minutesByDay['2026-11-10'] = 2000; }],
  ['minutes.shape', 'error', 'a badly dated day', e => { e.minutesByDay['10/11/2026'] = 30; }],
  ['export.spec-version', 'error', 'a spec version of 0', e => { e.scoringSpecVersion = 0; }],

  ['post.dwell-lost', 'warning', 'a longest stretch above the total', e => { post(e, 1).maxContinuousDwellMs = 6200; }],
  ['post.dwell-long', 'warning', 'an hour on screen', e => { post(e, 1).dwellMs = 3_600_000; post(e, 1).maxContinuousDwellMs = 1000; }],
  ['post.blur-below-threshold', 'warning', 'a blurred post under the threshold', e => { post(e, 1).blurThreshold = 90; }],
  ['post.spec', 'warning', 'a newer post with no spec version and not marked failed', e => { delete post(e, 1).specVersion; }],
  ['post.dims-missing', 'warning', 'a scored post with no sub-scores', e => { delete post(e, 1).dims; }],
  ['post.model-score-untagged', 'warning', 'a model score with no topic named', e => { delete post(e, 3).narrativeThemeId; }],
  ['post.topic-unknown', 'warning', 'a topic that is no longer in the list', e => { post(e, 3).narrativeThemeId = 'deleted-topic'; }],
  ['post.source-empty', 'warning', 'a post with no source', e => { post(e, 2).subreddit = ''; }],
  ['post.after-session-end', 'warning', 'a post dated well after its session ended', e => { post(e, 3).timestamp = T0 + 600_000 + 180_000; }],
  ['post.duplicate', 'warning', 'the same post twice at one instant', e => { e.sessions[0].posts.push({ ...post(e, 0) }); e.sessions[0].engagementDistribution.medium = 3; }],
  ['content.image-incomplete', 'warning', 'a seen image with no fingerprint', e => { delete e.postContent[0].imageHash; }],
  ['content.data-url', 'warning', 'an inline image stored with a post', e => { e.postContent[0].imageUrl = 'data:image/jpeg;base64,AAAA'; }],
  ['label.sponsored-low', 'warning', 'a site-marked ad logged under 100', e => { e.postContent[0].text = `${SPONSORED_PREFIX}Buy now`; }],
  ['label.ai-low', 'warning', 'a site-labeled AI post logged under 100', e => { e.postContent[0].text = `${AI_LABEL_PREFIX}Sunset`; }],
];

describe('one thing wrong', () => {
  it.each(BROKEN)('%s (%s): %s', (rule, severity, _what, breakIt) => {
    const e = goodExport();
    breakIt(e);
    const report = checkExport(e);
    const finding = report.findings.find(f => f.rule === rule);
    expect(finding, `expected ${rule}, got: ${rules(report).join(', ') || 'nothing'}`).toBeDefined();
    expect(finding!.severity).toBe(severity);
    expect(finding!.count).toBeGreaterThanOrEqual(1);
    expect(report.ok).toBe(severity === 'warning' ? report.errors === 0 : false);
    // The one broken thing shouldn't set off unrelated error rules
    expect(report.findings.filter(f => f.severity === 'error' && f.rule !== rule).map(f => f.rule)).toEqual([]);
  });

  it('covers every rule the checker has', async () => {
    const source = (await import('fs')).readFileSync(new URL('../src/shared/export-check.ts', import.meta.url), 'utf8');
    const defined = new Set([...source.matchAll(/flag\('([a-z.-]+)'/g)].map(m => m[1]));
    const tested = new Set([...BROKEN.map(b => b[0]), 'export.shape', 'post.flat-day']);
    expect([...defined].filter(r => !tested.has(r))).toEqual([]);
  });
});

describe('specific cases', () => {
  it('flags a day on which every post is logged as 50', () => {
    const e = goodExport();
    e.sessions[0].posts = Array.from({ length: 6 }, (_, i) => ({ ...post(goodExport(), 0), postId: `p${i}`, timestamp: T0 + 1000 + i, score: 50 }));
    e.sessions[0].engagementDistribution = { high: 0, medium: 6, low: 0 };
    const finding = checkExport(e).findings.find(f => f.rule === 'post.flat-day');
    expect(finding).toMatchObject({ severity: 'warning', count: 6 });
  });

  it('accepts a site-marked ad that was logged at 100, and one whose score failed', () => {
    const e = goodExport();
    e.postContent[0].text = `${SPONSORED_PREFIX}Buy now`;
    post(e, 1).score = 100;
    expect(checkExport(e).findings).toEqual([]);

    const f = goodExport();
    f.postContent.push({ postId: 'yt1', platform: 'youtube', text: `${SPONSORED_PREFIX}Watch this`, author: 'A Channel', timestamp: T0 + 3000 });
    expect(checkExport(f).findings).toEqual([]);
  });

  it('accepts a YouTube Short with no channel, which a shelf does not show', () => {
    const e = goodExport();
    post(e, 2).subreddit = '';
    post(e, 2).short = true;
    expect(checkExport(e).findings).toEqual([]);
  });

  it('accepts a gallery described without the single-image flag', () => {
    const e = goodExport();
    delete e.postContent[0].imageSeen;
    delete e.postContent[0].imageHash;
    expect(checkExport(e).findings).toEqual([]);
  });

  it('gives examples as ids, capped at five, and counts every failing record', () => {
    const e = goodExport();
    e.sessions[0].posts = Array.from({ length: 9 }, (_, i) => ({ ...post(goodExport(), 0), postId: `p${i}`, timestamp: T0 + 1000 + i, score: 200 }));
    e.sessions[0].engagementDistribution = { high: 0, medium: 9, low: 0 };
    const finding = checkExport(e).findings.find(f => f.rule === 'post.score-range')!;
    expect(finding.count).toBe(9);
    expect(finding.examples).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });

  it('lists errors before warnings, and prints a summary without post text', () => {
    const e = goodExport();
    post(e, 2).subreddit = '';
    post(e, 0).score = 140;
    e.postContent[1].text = 'a private thought nobody should see in a report';
    const report = checkExport(e);
    expect(report.findings.map(f => f.severity)).toEqual(['error', 'warning']);
    const text = formatReport(report);
    expect(text).toContain('1 error, 1 warning.');
    expect(text).toContain('post.score-range');
    expect(text).not.toContain('private thought');
  });
});

// The same checker against what the extension's own code writes
describe('what the extension writes', () => {
  const kv = new Map<string, unknown>();
  let storage: typeof import('../src/background/storage');

  beforeAll(async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (keys?: string | string[]) => {
            const wanted = keys === undefined ? [...kv.keys()] : typeof keys === 'string' ? [keys] : keys;
            return Object.fromEntries(wanted.filter(k => kv.has(k)).map(k => [k, structuredClone(kv.get(k))]));
          },
          set: async (items: Record<string, unknown>) => { for (const [k, v] of Object.entries(items)) kv.set(k, structuredClone(v)); },
        },
      },
    };
    storage = await import('../src/background/storage');
  });

  beforeEach(async () => {
    kv.clear();
    storage.clearHeldDwell();
    const { openDB } = await import('idb');
    await storage.getAllSessions();
    const db = await openDB('tolerance');
    for (const name of db.objectStoreNames) await db.clear(name);
    db.close();
  });

  // What a content script logs for one post, built from a score the way the real ones are
  function logged(postId: string, platform: 'reddit' | 'twitter' | 'youtube', score: EngagementScore | undefined, i: number): PostImpression {
    return {
      timestamp: Date.now(), postId, ...impressionScoreFields(score), platform,
      blurThreshold: 55, blurred: !!score && !score.scoreFailed && score.apiScore >= 55,
      position: i, originalPosition: i, subreddit: platform === 'twitter' ? '@someone' : 'a source', wasReordered: false,
    };
  }
  const scoreFor = (postId: string, apiScore: number, over: Partial<EngagementScore> = {}): EngagementScore => ({
    postId, apiScore, bucket: apiScore >= 70 ? 'high' : apiScore >= 40 ? 'medium' : 'low', factors: {}, timestamp: Date.now(),
    specVersion: SCORING_SPEC_VERSION, dims: { hook: 6, effort: 3, pull: 5, value: 4 }, ...over,
  });

  it('passes the checker after a session of logging, attention and storage', async () => {
    await storage.setSettings({ calibration: { storeApiReason: true, storePostContent: true } });
    await storage.createSession('active', 1);

    const posts = [
      logged('x1', 'twitter', scoreFor('x1', 80, { imageSeen: true }), 0),
      logged('r1', 'reddit', scoreFor('r1', 30), 1),
      logged('yt1', 'youtube', scoreFor('yt1', 50, { scoreFailed: true, dims: undefined, specVersion: undefined }), 2),
      logged('gone', 'twitter', undefined, 3),   // no score came back at all
      logged('t1', 'reddit', scoreFor('t1', 100, { modelScore: 60, factors: { narrative: { themeId: 'topic-1', confidence: 'high', matchedKeywords: [] } } }), 4),
    ];
    // Batches and attention arriving together, including time on screen that arrives first
    await storage.logAttention([{ postId: 'x1', dwellMs: 1900, enters: 1, maxContinuousMs: 1900 }], []);
    await Promise.all([
      storage.logImpressions(posts.slice(0, 2)),
      storage.logImpressions(posts.slice(2)),
      storage.logAttention([{ postId: 'r1', dwellMs: 800, enters: 1, maxContinuousMs: 800 }],
        [{ minute: Math.floor(Date.now() / 60000), scrolledPx: 5000, maxVelocityPxS: 900, scrollActiveMs: 4000 }]),
    ]);
    await storage.logAttention([{ postId: 'x1', dwellMs: 4300, enters: 0, maxContinuousMs: 6200 }], []);
    await storage.logCalibration('r1', 30, { title: 'A headline', imageUrl: 'data:image/png;base64,AAAA', apiReason: 'plain news' });
    await storage.savePostContent([
      { postId: 'x1', platform: 'twitter', text: 'A post', author: 'someone', timestamp: Date.now(), imageSeen: true, imageDescription: 'A chart.', imageHash: '0123456789abcdef' },
      { postId: 'r1', platform: 'reddit', text: 'A headline', author: 'someone', timestamp: Date.now() },
    ]);
    await storage.endSession();

    const report = checkExport({
      exportDate: new Date(Date.now() + 1000).toISOString(), scoringSpecVersion: SCORING_SPEC_VERSION,
      topics: [{ id: 'topic-1', name: 'A topic' }],
      sessions: await storage.getAllSessions(),
      calibration: await storage.getCalibrationData(),
      postContent: await storage.getAllPostContent(),
    });
    expect(report.findings, formatReport(report)).toEqual([]);
    expect(report.counts).toMatchObject({ sessions: 1, posts: 5, newFormatPosts: 5, postContent: 2, calibration: 1 });
  });
});
