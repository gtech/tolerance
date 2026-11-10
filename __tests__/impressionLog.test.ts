import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EngagementScore, PostImpression } from '../src/shared/types';

// Recording what was shown: once per page load on every site, with Instagram and
// Facebook logging at all (they recorded nothing before November 2026).

let sent: { type: string; impressions?: PostImpression[] }[];
let observed: unknown[];

beforeEach(() => {
  vi.resetModules();   // each test is a fresh page load
  vi.useFakeTimers();
  sent = [];
  observed = [];
  const g = globalThis as Record<string, unknown>;
  g.IntersectionObserver = class {
    observe(el: unknown) { observed.push(el); }
    unobserve() {}
  };
  g.window = { addEventListener: () => {}, scrollY: 0 };
  g.document = { addEventListener: () => {}, visibilityState: 'visible' };
  g.chrome = { runtime: { sendMessage: (m: { type: string }) => { sent.push(m); }, lastError: undefined } };
});

afterEach(() => {
  vi.useRealTimers();
});

const score = (over: Partial<EngagementScore> = {}): EngagementScore =>
  ({ postId: 'p', apiScore: 72, bucket: 'high', specVersion: 10, ...over }) as EngagementScore;
const el = () => ({}) as unknown as HTMLElement;
const post = (id: string, over = {}) => ({ id, element: el(), source: 'someone', score: score({ postId: id }), blurThreshold: 55, blurred: true, ...over });

describe('firstSighting', () => {
  it('is true once per post', async () => {
    const { firstSighting } = await import('../src/content/impressionLog');
    expect(firstSighting('a')).toBe(true);
    expect(firstSighting('a')).toBe(false);
    expect(firstSighting('b')).toBe(true);
  });

  it('never accepts a post with no id', async () => {
    const { firstSighting } = await import('../src/content/impressionLog');
    expect(firstSighting('')).toBe(false);
  });
});

describe('logShown', () => {
  it('logs each post with its site, source, score and what was decided', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    logShown('instagram', [post('DAbc_1'), post('DAbc_2', { blurred: false, blurThreshold: 40 })]);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('LOG_IMPRESSIONS');
    const [a, b] = sent[0].impressions!;
    expect(a).toMatchObject({ postId: 'DAbc_1', platform: 'instagram', subreddit: 'someone', score: 72, bucket: 'high', specVersion: 10, blurThreshold: 55, blurred: true, wasReordered: false });
    expect(b).toMatchObject({ postId: 'DAbc_2', blurThreshold: 40, blurred: false });
  });

  it('numbers posts down the page across batches, not from 0 each time', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    logShown('facebook', [post('fb_1'), post('fb_2')]);
    logShown('facebook', [post('fb_3')]);
    expect(sent.flatMap(m => m.impressions!.map(i => i.position))).toEqual([0, 1, 2]);
  });

  it('does not log a post twice when the page hands it over again', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    logShown('facebook', [post('fb_1'), post('fb_2')]);
    logShown('facebook', [post('fb_1'), post('fb_2'), post('fb_3')]);   // e.g. after going to a post and back
    expect(sent.map(m => m.impressions!.map(i => i.postId))).toEqual([['fb_1', 'fb_2'], ['fb_3']]);
  });

  it('sends nothing when every post was already logged', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    logShown('instagram', [post('a')]);
    logShown('instagram', [post('a')]);
    expect(sent).toHaveLength(1);
  });

  it('times every post it is given, including one whose element was rebuilt', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    const first = el(), rebuilt = el();
    logShown('instagram', [post('a', { element: first })]);
    logShown('instagram', [post('a', { element: rebuilt })]);
    expect(observed).toContain(first);
    expect(observed).toContain(rebuilt);
  });

  it('carries a failed score through as failed', async () => {
    const { logShown } = await import('../src/content/impressionLog');
    logShown('facebook', [post('fb_9', { score: score({ postId: 'fb_9', apiScore: 50, scoreFailed: true, specVersion: undefined }) })]);
    expect(sent[0].impressions![0]).toMatchObject({ score: 50, scoreFailed: true });
  });
});
