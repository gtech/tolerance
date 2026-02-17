import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock chrome API before importing scorer (which transitively imports background/index.ts)
beforeAll(() => {
  // @ts-expect-error - mocking chrome global for test environment
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      getURL: vi.fn(),
      sendMessage: vi.fn(),
    },
    storage: {
      local: { get: vi.fn(), set: vi.fn() },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      onActivated: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
  };
});

// Dynamic import after chrome mock is set up
let createPendingScore: (postId: string) => import('../src/shared/types').EngagementScore;

beforeAll(async () => {
  const module = await import('../src/background/scorer');
  createPendingScore = module.createPendingScore;
});

describe('createPendingScore', () => {
  it('sets apiScore to 50 as default', () => {
    const score = createPendingScore('test-123');
    expect(score.apiScore).toBe(50);
  });

  it('sets scoreFailed to true', () => {
    const score = createPendingScore('test-123');
    expect(score.scoreFailed).toBe(true);
  });

  it('sets bucket to medium', () => {
    const score = createPendingScore('test-123');
    expect(score.bucket).toBe('medium');
  });

  it('uses the provided postId', () => {
    const score = createPendingScore('abc-456');
    expect(score.postId).toBe('abc-456');
  });

  it('has empty factors object (no heuristic fields)', () => {
    const score = createPendingScore('test-123');
    expect(score.factors).toEqual({});
  });

  it('sets a timestamp', () => {
    const before = Date.now();
    const score = createPendingScore('test-123');
    expect(score.timestamp).toBeGreaterThanOrEqual(before);
    expect(score.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('does not have heuristicScore or heuristicConfidence', () => {
    const score = createPendingScore('test-123') as Record<string, unknown>;
    expect(score.heuristicScore).toBeUndefined();
    expect(score.heuristicConfidence).toBeUndefined();
  });
});
