import { InstagramPost, EngagementScore, AppState, Settings } from '../../shared/types';
import { log, setLogLevel } from '../../shared/constants';
import { scrapeVisiblePosts, serializePost } from './scraper';
import { setupInstagramObserver, setupNavigationObserver, isValidFeedPage, disconnectObserver } from './observer';

// Track processed posts to avoid re-processing
const processedPostIds = new Set<string>();

// Cache scores for badge re-injection when Instagram recreates DOM elements
const scoreCache = new Map<string, { score: EngagementScore; originalPosition: number }>();

// Processing lock to prevent concurrent processPosts calls
let isProcessing = false;
let pendingProcess = false;

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Adaptive blur threshold (score at or above this gets blurred)
let currentBlurThreshold = 55; // Default for 'normal' phase
let currentPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal' = 'normal';

// Quality Mode - instant aggressive blur (scores > 20)
let qualityModeEnabled = false;
const QUALITY_MODE_THRESHOLD = 21;

// Hover reveal delay (in ms)
let hoverRevealDelay = 3000; // Default 3 seconds

// Track hover timers for timed reveal
const hoverTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

// Styles injected flag
let stylesInjected = false;

function sendHeartbeat(): void {
  if (!isExtensionValid()) {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'SOCIAL_MEDIA_HEARTBEAT' }, () => {
      if (chrome.runtime.lastError) {
        // Silent fail - extension might be updating
      }
    });
  } catch {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  }
}

function isExtensionValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

async function updateBlurThreshold(): Promise<void> {
  if (!isExtensionValid()) return;

  try {
    const sessionResult = await sendMessage({ type: 'GET_GLOBAL_SESSION' });
    if (sessionResult && 'phase' in sessionResult) {
      const newPhase = sessionResult.phase as typeof currentPhase;

      const thresholdResult = await sendMessage({
        type: 'GET_EFFECTIVE_BLUR_THRESHOLD',
        phase: newPhase,
      });

      if (thresholdResult && 'threshold' in thresholdResult) {
        const newThreshold = thresholdResult.threshold as number;
        if (newThreshold !== currentBlurThreshold || newPhase !== currentPhase) {
          log.debug(` Instagram: Blur threshold updated - phase: ${newPhase}, threshold: ${newThreshold}`);
          currentBlurThreshold = newThreshold;
          currentPhase = newPhase;
        }
      }
    }
  } catch {
    // Silently fail - will use default threshold
  }
}

function shouldBlurScore(score: EngagementScore): boolean {
  const displayScore = score.apiScore ?? score.heuristicScore;
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return;

  sendHeartbeat();
  updateBlurThreshold();

  heartbeatIntervalId = setInterval(() => {
    sendHeartbeat();
    updateBlurThreshold();
  }, HEARTBEAT_INTERVAL);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
      updateBlurThreshold();
    }
  });

  log.debug(' Instagram: Heartbeat tracking started');
}

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.id = 'tolerance-instagram-styles';
  style.textContent = `
    /* Score badge on posts */
    .tolerance-score-badge {
      position: absolute !important;
      top: 8px !important;
      left: 50% !important;
      right: auto !important;
      transform: translateX(-50%) !important;
      background: rgba(0, 0, 0, 0.7);
      color: white;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 4px;
      z-index: 100;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      pointer-events: none;
    }

    .tolerance-score-badge.low {
      background: rgba(76, 175, 80, 0.85);
    }

    .tolerance-score-badge.medium {
      background: rgba(255, 152, 0, 0.85);
    }

    .tolerance-score-badge.high {
      background: rgba(244, 67, 54, 0.85);
    }

    /* Blur overlay for high-engagement content */
    .tolerance-blur-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 50;
      transition: opacity 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .tolerance-blur-overlay::after {
      content: 'Hover 3s to reveal';
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      font-weight: 500;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .tolerance-blur-overlay.revealing::after {
      content: 'Revealing...';
    }

    .tolerance-blur-overlay.revealed {
      opacity: 0;
      pointer-events: none;
    }

    /* Container needs relative positioning for badge */
    article.tolerance-processed {
      position: relative;
    }
  `;
  document.head.appendChild(style);
}

async function sendMessage(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isExtensionValid()) {
      reject(new Error('Extension context invalid'));
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function processPosts(): Promise<void> {
  if (!isExtensionValid()) return;
  if (!isValidFeedPage()) return;

  if (isProcessing) {
    pendingProcess = true;
    return;
  }

  isProcessing = true;

  try {
    // Scrape visible posts
    const posts = scrapeVisiblePosts();
    log.debug(` Instagram: Found ${posts.length} posts`);

    // Filter to unprocessed posts
    const newPosts = posts.filter(p => !processedPostIds.has(p.id));

    // Re-inject badges for posts that were processed but DOM was recreated
    for (const post of posts) {
      if (processedPostIds.has(post.id)) {
        const cached = scoreCache.get(post.id);
        if (cached && !post.element.querySelector('.tolerance-score-badge')) {
          injectBadge(post, cached.score);
        }
      }
    }

    if (newPosts.length === 0) {
      log.debug(' Instagram: No new posts to process');
      return;
    }

    log.debug(` Instagram: Processing ${newPosts.length} new posts`);

    // Mark as processed
    for (const post of newPosts) {
      processedPostIds.add(post.id);
    }

    // Serialize for messaging
    const serializedPosts = newPosts.map(p => serializePost(p));

    // Send to background for scoring
    const response = await sendMessage({
      type: 'SCORE_INSTAGRAM_POSTS',
      posts: serializedPosts,
    });

    if (!response || !(response as { scores?: EngagementScore[] }).scores) {
      log.warn(' Instagram: No scores returned');
      return;
    }

    const scores = (response as { scores: EngagementScore[] }).scores;
    log.debug(` Instagram: Received ${scores.length} scores`);

    // Create score map
    const scoreMap = new Map<string, EngagementScore>();
    for (const score of scores) {
      scoreMap.set(score.postId, score);
    }

    // Inject badges and apply blur
    for (const post of newPosts) {
      const score = scoreMap.get(post.id);
      if (score) {
        scoreCache.set(post.id, { score, originalPosition: 0 });
        injectBadge(post, score);
      }
    }
  } catch (error) {
    log.error(' Instagram: Error processing posts:', error);
  } finally {
    isProcessing = false;

    // Process pending if any
    if (pendingProcess) {
      pendingProcess = false;
      setTimeout(processPosts, 100);
    }
  }
}

function injectBadge(post: InstagramPost, score: EngagementScore): void {
  const element = post.element;
  if (!element) return;

  // Mark as processed
  element.classList.add('tolerance-processed');

  // Remove existing badge if any
  const existingBadge = element.querySelector('.tolerance-score-badge');
  if (existingBadge) {
    existingBadge.remove();
  }

  // Remove existing blur overlay
  const existingBlur = element.querySelector('.tolerance-blur-overlay');
  if (existingBlur) {
    existingBlur.remove();
  }

  // Create badge
  const displayScore = score.apiScore ?? score.heuristicScore;
  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${score.bucket}`;
  badge.textContent = displayScore.toString();

  // Add tooltip with reason
  if (score.apiReason) {
    badge.title = score.apiReason;
    badge.style.cursor = 'help';
    badge.style.pointerEvents = 'auto';
  }

  // Always append to the article element for consistent positioning
  element.style.position = 'relative';
  element.appendChild(badge);

  // Apply blur if score exceeds threshold
  if (shouldBlurScore(score)) {
    applyBlur(element);
  }
}

function applyBlur(element: HTMLElement): void {
  // Find the main content image (not profile pic) to locate the media area
  const contentImages = element.querySelectorAll('img');
  let mediaContainer: HTMLElement | null = null;

  for (const img of contentImages) {
    const alt = img.alt || '';
    // Skip profile pictures
    if (alt.includes('profile picture')) continue;
    // Skip small images (icons, etc)
    if (img.width < 100 && img.height < 100) continue;

    // Found a content image - get a parent that's likely the media container
    // Go up a few levels to find a container that spans the content area
    let parent = img.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      // Look for a container with significant width
      if (parent.offsetWidth > 300) {
        mediaContainer = parent;
        break;
      }
      parent = parent.parentElement;
    }
    if (mediaContainer) break;
  }

  // Fallback: look for video element's container
  if (!mediaContainer) {
    const video = element.querySelector('video');
    if (video) {
      let parent = video.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.offsetWidth > 300) {
          mediaContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
  }

  if (!mediaContainer) {
    return;
  }

  // Ensure container has relative positioning
  mediaContainer.style.position = 'relative';

  // Find and pause any videos in this post
  const video = element.querySelector('video');
  if (video) {
    video.pause();
    // Prevent autoplay by removing autoplay attribute and setting preload
    video.removeAttribute('autoplay');
    video.preload = 'none';
  }

  // Create blur overlay
  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';

  // Add hover reveal functionality
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  overlay.addEventListener('mouseenter', () => {
    overlay.classList.add('revealing');
    revealTimer = setTimeout(() => {
      overlay.classList.add('revealed');
      // Resume video when revealed
      if (video) {
        video.play().catch(() => {
          // Ignore autoplay errors
        });
      }
    }, hoverRevealDelay);
    hoverTimers.set(overlay, revealTimer);
  });

  overlay.addEventListener('mouseleave', () => {
    overlay.classList.remove('revealing');
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    const timer = hoverTimers.get(overlay);
    if (timer) {
      clearTimeout(timer);
      hoverTimers.delete(overlay);
    }
    // Pause video again if not fully revealed
    if (video && !overlay.classList.contains('revealed')) {
      video.pause();
    }
  });

  mediaContainer.appendChild(overlay);
}

async function init(): Promise<void> {
  log.warn(' Instagram: init() called');

  // Check if we should run on this page
  if (!isValidFeedPage()) {
    log.warn(' Instagram: Not a valid feed page, skipping');
    return;
  }
  log.warn(' Instagram: Valid feed page, continuing init');

  // Get settings
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response) {
      const { settings } = response as { state: AppState; settings: Settings };

      // Check if Instagram is enabled (default to true if not set)
      if (settings.platforms?.instagram === false) {
        log.debug(' Instagram: Platform disabled in settings');
        return;
      }

      // Set log level
      if (settings.logLevel) {
        setLogLevel(settings.logLevel);
      }

      // Quality mode
      qualityModeEnabled = settings.qualityMode ?? false;

      // Hover reveal delay
      hoverRevealDelay = (settings.twitter?.hoverRevealDelay ?? 3) * 1000;
    }
  } catch (error) {
    log.error(' Instagram: Failed to get settings:', error);
  }

  // Inject styles
  injectStyles();

  // Start heartbeat for session tracking
  startHeartbeat();

  // Initial process
  await processPosts();

  // Set up observers
  setupInstagramObserver(processPosts);
  setupNavigationObserver(() => {
    processedPostIds.clear();
    processPosts();
  });

  log.debug(' Instagram: Initialization complete');
}

// Start when DOM is ready, with delay to let React hydrate first
// Instagram uses React SSR with hydration - modifying DOM too early causes React error #418
const HYDRATION_DELAY = 2000; // Wait 2 seconds for React hydration

log.warn(' Instagram: Content script loaded');

function startWithDelay(): void {
  log.warn(' Instagram: Starting init in', HYDRATION_DELAY, 'ms');
  setTimeout(init, HYDRATION_DELAY);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startWithDelay);
} else {
  startWithDelay();
}

// Clean up on unload
window.addEventListener('unload', () => {
  disconnectObserver();
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
  }
});
