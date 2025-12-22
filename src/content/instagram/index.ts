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
let processingStartTime = 0;
const MAX_PROCESSING_TIME = 15000; // 15 second timeout to prevent stuck processing

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
  // Pre-filter: whitelisted sources bypass blur transform
  if (score.whitelisted) return false;

  const displayScore = score.apiScore ?? score.heuristicScore;
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return;

  sendHeartbeat();
  updateBlurThreshold();

  heartbeatIntervalId = setInterval(() => {
    // Skip heartbeat on non-feed pages
    if (!isValidFeedPage()) return;
    sendHeartbeat();
    updateBlurThreshold();
  }, HEARTBEAT_INTERVAL);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isValidFeedPage()) {
      sendHeartbeat();
      updateBlurThreshold();
    }
  });

  log.debug('Instagram: Heartbeat tracking started');
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
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      z-index: 50 !important;
      transition: opacity 0.3s ease;
      display: flex !important;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.1) !important;
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

    /* Block videos entirely when blurred - Instagram can't autoplay what doesn't exist */
    article.tolerance-video-blocked video {
      visibility: hidden !important;
      pointer-events: none !important;
    }

    /* Also mute any audio */
    article.tolerance-video-blocked audio {
      visibility: hidden !important;
    }

    /* Blur overlay for navigation buttons (Explore, Reels) */
    .tolerance-nav-blur {
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      backdrop-filter: blur(4px) !important;
      -webkit-backdrop-filter: blur(4px) !important;
      background: rgba(0, 0, 0, 0.3) !important;
      z-index: 9999 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      border-radius: 8px;
      transition: opacity 0.3s ease !important;
    }

    .tolerance-nav-blur::after {
      content: attr(data-countdown);
      color: white;
      font-size: 11px;
      font-weight: bold;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
    }

    .tolerance-nav-blur.revealed {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Pending blur (before scoring completes) */
    article.tolerance-pending {
      position: relative;
    }

    article.tolerance-pending .tolerance-blur-overlay::after {
      content: 'Scoring...';
    }

    /* Hide score badge while pending */
    article.tolerance-pending .tolerance-score-badge {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

function blurNavigationButtons(): void {
  // Find Explore and Reels links in the navigation
  const navLinks = document.querySelectorAll('a[href="/explore/"], a[href="/reels/"]');

  for (const link of navLinks) {
    if (!(link instanceof HTMLElement)) continue;
    if (link.querySelector('.tolerance-nav-blur')) continue; // Already blurred

    // Make the link container relative for positioning
    link.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'tolerance-nav-blur';
    overlay.setAttribute('data-countdown', '10s');

    // 10-second hover reveal for both
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    let countdownInterval: ReturnType<typeof setInterval> | null = null;
    let revealed = false;

    overlay.addEventListener('mouseenter', () => {
      if (revealed) return;

      let remaining = 10;
      overlay.setAttribute('data-countdown', `${remaining}s`);

      // Update countdown every second
      countdownInterval = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          overlay.setAttribute('data-countdown', `${remaining}s`);
        } else {
          overlay.setAttribute('data-countdown', '');
          if (countdownInterval) clearInterval(countdownInterval);
        }
      }, 1000);

      revealTimer = setTimeout(() => {
        revealed = true;
        overlay.classList.add('revealed');
        if (countdownInterval) clearInterval(countdownInterval);
      }, 10000);
    });

    overlay.addEventListener('mouseleave', () => {
      if (revealed) return;
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      overlay.setAttribute('data-countdown', '10s');
    });

    link.appendChild(overlay);
  }
}

// Apply pending blur (before scoring) to a post
function applyPendingBlur(post: InstagramPost): void {
  const element = post.element;
  if (!element) return;

  // Don't blur if already blurred or pending
  if (element.classList.contains('tolerance-blurred') ||
      element.classList.contains('tolerance-pending')) return;

  element.classList.add('tolerance-pending');
  element.classList.add('tolerance-video-blocked');
  element.style.position = 'relative';

  // Add overlay with "Scoring..." label
  if (!element.querySelector('.tolerance-blur-overlay')) {
    const overlay = document.createElement('div');
    overlay.className = 'tolerance-blur-overlay';

    // Block clicks on blurred content
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    element.appendChild(overlay);
  }
}

// Remove pending blur (after scoring reveals it's not high-engagement)
function removePendingBlur(post: InstagramPost): void {
  const element = post.element;
  if (!element) return;

  element.classList.remove('tolerance-pending');
  element.classList.remove('tolerance-video-blocked');

  // Remove overlay
  const overlay = element.querySelector('.tolerance-blur-overlay');
  if (overlay) overlay.remove();
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

  const pathname = window.location.pathname;
  log.debug('Instagram: processPosts called, pathname:', pathname);

  // Extra safety: disconnect observer if we somehow end up on reels
  if (!isValidFeedPage()) {
    log.debug('Instagram: processPosts bailing - not valid feed page');
    disconnectObserver();
    return;
  }

  // Check if previous processing got stuck (timeout protection)
  if (isProcessing) {
    const elapsed = Date.now() - processingStartTime;
    if (elapsed > MAX_PROCESSING_TIME) {
      log.debug(`Instagram: Processing stuck for ${elapsed}ms, forcing unlock`);
      isProcessing = false;
    } else {
      pendingProcess = true;
      return;
    }
  }

  isProcessing = true;
  processingStartTime = Date.now();

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
      log.debug('Instagram: No new posts to process');
      return;
    }

    log.debug(` Instagram: Processing ${newPosts.length} new posts`);

    // Mark as processed and apply pending blur immediately
    // But check cache first - if we have a score, use it instead of showing "Scoring..."
    const postsNeedingScoring: typeof newPosts = [];
    for (const post of newPosts) {
      processedPostIds.add(post.id);

      // Check if we already have a cached score (handles ID inconsistency edge cases)
      const cached = scoreCache.get(post.id);
      if (cached) {
        log.debug(`Instagram: Using cached score for ${post.id}`);
        injectBadge(post, cached.score);
      } else {
        applyPendingBlur(post);
        postsNeedingScoring.push(post);
      }
    }

    // If all posts were served from cache, we're done
    if (postsNeedingScoring.length === 0) {
      log.debug('Instagram: All posts served from cache');
      return;
    }

    // Serialize only posts that need scoring
    const serializedPosts = postsNeedingScoring.map(p => serializePost(p));

    // Send to background for scoring (with timeout to prevent hanging)
    const scorePromise = sendMessage({
      type: 'SCORE_INSTAGRAM_POSTS',
      posts: serializedPosts,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Scoring timeout')), 10000)
    );

    let response;
    try {
      response = await Promise.race([scorePromise, timeoutPromise]);
    } catch (timeoutError) {
      log.debug('Instagram: Scoring timed out, will retry on next scroll');
      // Remove pending blur from posts that timed out so they're visible
      for (const post of postsNeedingScoring) {
        removePendingBlur(post);
        processedPostIds.delete(post.id); // Allow retry
      }
      return;
    }

    if (!response || !(response as { scores?: EngagementScore[] }).scores) {
      log.debug('Instagram: No scores returned');
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
    for (const post of postsNeedingScoring) {
      const score = scoreMap.get(post.id);
      if (score) {
        scoreCache.set(post.id, { score, originalPosition: 0 });
        injectBadge(post, score);
      }
    }
  } catch (error) {
    log.error('Instagram: Error processing posts:', error);
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

  // Mark as processed and remove pending state
  element.classList.add('tolerance-processed');
  element.classList.remove('tolerance-pending');

  // Remove existing badge if any
  const existingBadge = element.querySelector('.tolerance-score-badge');
  if (existingBadge) {
    existingBadge.remove();
  }

  // Remove existing blur overlay (will re-add if needed)
  const existingBlur = element.querySelector('.tolerance-blur-overlay');
  if (existingBlur) {
    existingBlur.remove();
  }

  // Remove video-blocked class (will re-add if score is high)
  element.classList.remove('tolerance-video-blocked');

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
  // Mark element as blurred for CSS targeting
  element.classList.add('tolerance-video-blocked');

  // Store the cleanup function for when blur is revealed
  (element as HTMLElement & { _toleranceUnblockVideo?: () => void })._toleranceUnblockVideo = () => {
    element.classList.remove('tolerance-video-blocked');
  };

  // Create blur overlay - append to article element for stability
  element.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';

  // Add hover reveal functionality
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let revealed = false;

  const revealContent = () => {
    revealed = true;
    overlay.classList.add('revealed');
    // Unblock video when revealed
    const unblock = (element as HTMLElement & { _toleranceUnblockVideo?: () => void })._toleranceUnblockVideo;
    if (unblock) {
      unblock();
    }
  };

  overlay.addEventListener('mouseenter', () => {
    if (revealed) return;
    overlay.classList.add('revealing');
    revealTimer = setTimeout(() => {
      revealContent();
    }, hoverRevealDelay);
    hoverTimers.set(overlay, revealTimer);
  });

  overlay.addEventListener('mouseleave', () => {
    if (revealed) return;
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
  });

  // Click on overlay reveals immediately
  overlay.addEventListener('click', (e) => {
    if (!revealed) {
      e.stopPropagation();
      revealContent();
    }
  });

  element.appendChild(overlay);
}

async function init(): Promise<void> {
  log.debug('Instagram: init() called, pathname:', window.location.pathname);

  // Inject styles
  injectStyles();

  // Blur navigation buttons (Explore, Reels) with 10-second hover reveal
  blurNavigationButtons();
  // Re-check periodically in case Instagram recreates the nav
  setInterval(blurNavigationButtons, 2000);

  // Check if we should run feed processing on this page
  if (!isValidFeedPage()) {
    log.debug('Instagram: Not a valid feed page, skipping feed processing');
    return;
  }
  log.debug('Instagram: Valid feed page, continuing init');

  // Get settings
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response) {
      const { settings } = response as { state: AppState; settings: Settings };

      // Check if Instagram is enabled (default to true if not set)
      if (settings.platforms?.instagram === false) {
        log.debug('Instagram: Platform disabled in settings');
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
    log.error('Instagram: Failed to get settings:', error);
  }

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

  log.debug('Instagram: Initialization complete');
}

// Start when DOM is ready, with delay to let React hydrate first
// Instagram uses React SSR with hydration - modifying DOM too early causes React error #418
const HYDRATION_DELAY = 2000; // Wait 2 seconds for React hydration

log.debug('Instagram: Content script loaded');

function startWithDelay(): void {
  log.debug('Instagram: Starting init in', HYDRATION_DELAY, 'ms');
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
