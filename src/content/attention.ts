// AttentionTracker: measures what actually gets attended to, not just rendered.
//
// Dwell: a post accrues dwell time while it is ≥50% visible inside a visible
// tab. IntersectionObserver supplies visibility transitions; the Page
// Visibility API gates tab focus. Longest continuous stretch is tracked
// separately from total so a 90s read is distinguishable from 30 glances.
//
// Scroll: per-minute aggregates of scrolled pixels, peak velocity, and active
// scrolling time — the raw signature needed to detect skim/doomscroll cadence.
//
// Deltas flush every FLUSH_INTERVAL_MS and on tab hide/pagehide. The
// background merges them into the current session, so partial data survives
// abrupt closes.

import { log } from '../shared/constants';
import type { DwellUpdate, ScrollBucket } from '../shared/types';

const VISIBLE_RATIO = 0.5;
const FLUSH_INTERVAL_MS = 10_000;
// A single scroll event can't represent more than this much "active" time
const SCROLL_ACTIVE_CAP_MS = 200;

interface TrackedPost {
  postId: string;
  element: HTMLElement;
  intersecting: boolean;      // Currently ≥50% in viewport (regardless of tab visibility)
  attendedSince: number | null; // Start of the current attended segment
  lastAccrual: number;        // Last time dwellMs was topped up
  dwellMs: number;            // Accrued since last flush
  enters: number;             // Viewport entries since last flush
  maxContinuousMs: number;    // Longest segment observed in this flush window
}

export type AttentionFlushHandler = (
  dwellUpdates: DwellUpdate[],
  scrollBuckets: ScrollBucket[]
) => void;

export class AttentionTracker {
  private observer: IntersectionObserver;
  private byElement = new Map<HTMLElement, TrackedPost>();
  private byPostId = new Map<string, TrackedPost>();
  private scrollBuckets = new Map<number, ScrollBucket>();
  private lastScrollY: number | null = null;
  private lastScrollTime = 0;
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(private onFlush: AttentionFlushHandler) {
    this.observer = new IntersectionObserver(
      (entries) => this.handleIntersections(entries),
      { threshold: [VISIBLE_RATIO] }
    );

    window.addEventListener('scroll', () => this.handleScroll(), { passive: true });

    document.addEventListener('visibilitychange', () => {
      const now = Date.now();
      if (document.visibilityState === 'hidden') {
        // Close all open segments and get the data out before the tab sleeps
        for (const post of this.byPostId.values()) {
          this.endSegment(post, now);
        }
        this.flush();
      } else {
        // Resume segments for posts still sitting in the viewport
        for (const post of this.byPostId.values()) {
          if (post.intersecting) this.startSegment(post, now);
        }
      }
    });

    window.addEventListener('pagehide', () => this.flush());

    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  // Register (or re-register) a post element. Twitter recreates DOM nodes for
  // existing tweets; calling track() again with the new element re-attaches
  // observation while accumulated-but-unflushed data is preserved.
  track(postId: string, element: HTMLElement): void {
    const existing = this.byPostId.get(postId);
    if (existing) {
      if (existing.element === element) return;
      this.observer.unobserve(existing.element);
      this.byElement.delete(existing.element);
      this.endSegment(existing, Date.now());
      existing.element = element;
      existing.intersecting = false;
      this.byElement.set(element, existing);
      this.observer.observe(element);
      return;
    }

    const post: TrackedPost = {
      postId,
      element,
      intersecting: false,
      attendedSince: null,
      lastAccrual: 0,
      dwellMs: 0,
      enters: 0,
      maxContinuousMs: 0,
    };
    this.byPostId.set(postId, post);
    this.byElement.set(element, post);
    this.observer.observe(element);
  }

  private handleIntersections(entries: IntersectionObserverEntry[]): void {
    const now = Date.now();
    for (const entry of entries) {
      const post = this.byElement.get(entry.target as HTMLElement);
      if (!post) continue;
      const visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_RATIO;
      post.intersecting = visible;
      if (visible && document.visibilityState === 'visible') {
        this.startSegment(post, now);
      } else {
        this.endSegment(post, now);
      }
    }
  }

  private startSegment(post: TrackedPost, now: number): void {
    if (post.attendedSince !== null) return;
    post.attendedSince = now;
    post.lastAccrual = now;
    post.enters++;
  }

  private endSegment(post: TrackedPost, now: number): void {
    if (post.attendedSince === null) return;
    this.accrue(post, now);
    post.attendedSince = null;
  }

  private accrue(post: TrackedPost, now: number): void {
    if (post.attendedSince === null) return;
    post.dwellMs += now - post.lastAccrual;
    post.lastAccrual = now;
    post.maxContinuousMs = Math.max(post.maxContinuousMs, now - post.attendedSince);
  }

  private handleScroll(): void {
    const now = Date.now();
    const y = window.scrollY;
    if (this.lastScrollY !== null) {
      const dy = Math.abs(y - this.lastScrollY);
      const dt = now - this.lastScrollTime;
      const minute = Math.floor(now / 60_000);
      let bucket = this.scrollBuckets.get(minute);
      if (!bucket) {
        bucket = { minute, scrolledPx: 0, maxVelocityPxS: 0, scrollActiveMs: 0 };
        this.scrollBuckets.set(minute, bucket);
      }
      bucket.scrolledPx += dy;
      // Velocity only meaningful for closely spaced events
      if (dt > 0 && dt < 1000 && dy > 0) {
        bucket.maxVelocityPxS = Math.max(bucket.maxVelocityPxS, Math.round((dy / dt) * 1000));
      }
      bucket.scrollActiveMs += Math.min(dt, SCROLL_ACTIVE_CAP_MS);
    }
    this.lastScrollY = y;
    this.lastScrollTime = now;
  }

  // Send accumulated deltas to the background and reset local accumulators.
  flush(): void {
    const now = Date.now();
    const dwellUpdates: DwellUpdate[] = [];

    for (const post of this.byPostId.values()) {
      // A virtualized-away node can miss its final observer callback; close
      // its segment here so an invisible post can't keep accruing dwell.
      if (!post.element.isConnected) {
        this.endSegment(post, now);
      }

      // Keep ongoing segments accruing across flush windows: report progress
      // so far; maxContinuousMs merges with max() in the background, so a
      // segment spanning windows still yields its true length.
      this.accrue(post, now);

      if (post.dwellMs > 0 || post.enters > 0) {
        dwellUpdates.push({
          postId: post.postId,
          dwellMs: post.dwellMs,
          enters: post.enters,
          maxContinuousMs: post.maxContinuousMs,
        });
        post.dwellMs = 0;
        post.enters = 0;
        post.maxContinuousMs = post.attendedSince !== null ? now - post.attendedSince : 0;
      }

      // Drop entries whose DOM node is gone (virtualized away) and fully reported
      if (!post.element.isConnected && post.attendedSince === null && post.dwellMs === 0) {
        this.byElement.delete(post.element);
        this.byPostId.delete(post.postId);
      }
    }

    const scrollBuckets = [...this.scrollBuckets.values()];
    this.scrollBuckets.clear();

    if (dwellUpdates.length === 0 && scrollBuckets.length === 0) return;

    log.debug(` Attention flush: ${dwellUpdates.length} dwell updates, ${scrollBuckets.length} scroll buckets`);
    this.onFlush(dwellUpdates, scrollBuckets);
  }

  destroy(): void {
    clearInterval(this.flushTimer);
    this.observer.disconnect();
    this.byElement.clear();
    this.byPostId.clear();
  }
}
