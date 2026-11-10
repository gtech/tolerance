import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DwellUpdate } from '../src/shared/types';

// The time-on-screen tracker, with the browser's IntersectionObserver replaced by one
// the test drives by hand.

type Entry = { target: unknown; isIntersecting: boolean; intersectionRatio: number };
let report: (entries: Entry[]) => void;
let observed: Set<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
  observed = new Set();
  const g = globalThis as Record<string, unknown>;
  g.IntersectionObserver = class {
    constructor(cb: (entries: Entry[]) => void) { report = cb; }
    observe(el: unknown) { observed.add(el); }
    unobserve(el: unknown) { observed.delete(el); }
  };
  g.window = { addEventListener: () => {}, scrollY: 0 };
  g.document = { addEventListener: () => {}, visibilityState: 'visible' };
});

afterEach(() => {
  vi.useRealTimers();
});

const show = (el: unknown) => report([{ target: el, isIntersecting: true, intersectionRatio: 1 }]);
const hide = (el: unknown) => report([{ target: el, isIntersecting: false, intersectionRatio: 0 }]);
const card = () => ({}) as unknown as HTMLElement;

async function tracker() {
  const { AttentionTracker } = await import('../src/content/attention');
  const flushed: DwellUpdate[] = [];
  const t = new AttentionTracker(updates => { flushed.push(...updates); });
  const dwell = (id: string) => flushed.filter(u => u.postId === id).reduce((s, u) => s + u.dwellMs, 0);
  return { t, flushed, dwell };
}

describe('AttentionTracker', () => {
  it('counts the time a post is on screen', async () => {
    const { t, dwell } = await tracker();
    const a = card();
    t.track('a', a);
    show(a);
    vi.advanceTimersByTime(3000);
    hide(a);
    vi.advanceTimersByTime(5000);
    t.flush();
    expect(dwell('a')).toBe(3000);
  });

  it('stops timing the old post when its card is reused for another', async () => {
    const { t, dwell } = await tracker();
    const el = card();
    t.track('a', el);
    show(el);
    vi.advanceTimersByTime(2000);

    // The same card now shows a different video
    t.track('b', el);
    expect(observed.has(el)).toBe(true);
    show(el);                        // the observer reports the reused card afresh
    vi.advanceTimersByTime(4000);
    t.flush();

    expect(dwell('a')).toBe(2000);
    expect(dwell('b')).toBe(4000);
  });

  it('keeps timing a post whose card moved, without disturbing the card it left', async () => {
    const { t, dwell } = await tracker();
    const first = card(), second = card();
    t.track('a', first);
    t.track('b', first);             // 'a' lost its card to 'b'
    t.track('a', second);            // 'a' reappears in another card
    expect(observed.has(first)).toBe(true);
    show(first);
    show(second);
    vi.advanceTimersByTime(1000);
    t.flush();
    expect(dwell('a')).toBe(1000);
    expect(dwell('b')).toBe(1000);
  });
});
