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
    }

    .tolerance-nav-blur.revealed {
      opacity: 0 !important;
      pointer-events: none !important;
    }

    /* Tooltip for Reels button */
    .tolerance-reels-tooltip {
      position: fixed;
      background: #1a1a1a;
      color: white;
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      z-index: 10000;
      width: 280px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      display: none;
    }

    .tolerance-reels-tooltip.visible {
      display: block;
    }

    .tolerance-reels-tooltip p {
      margin: 0 0 12px 0;
    }

    .tolerance-reels-tooltip .tolerance-btn {
      display: block;
      width: 100%;
      padding: 10px;
      margin-top: 8px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.2s;
    }

    .tolerance-reels-tooltip .tolerance-btn-primary {
      background: #0095f6;
      color: white;
    }

    .tolerance-reels-tooltip .tolerance-btn-primary:hover {
      background: #0086e0;
    }

    .tolerance-reels-tooltip .tolerance-btn-secondary {
      background: #363636;
      color: white;
    }

    .tolerance-reels-tooltip .tolerance-btn-secondary:hover {
      background: #444;
    }
  `;
  document.head.appendChild(style);
}

// Create tooltip element once
let reelsTooltip: HTMLElement | null = null;

function createReelsTooltip(): HTMLElement {
  if (reelsTooltip) return reelsTooltip;

  reelsTooltip = document.createElement('div');
  reelsTooltip.className = 'tolerance-reels-tooltip';
  reelsTooltip.innerHTML = `
    <p><strong>Reels is currently broken.</strong></p>
    <p>You can disable Tolerance on Instagram temporarily if you want to view Reels.</p>
    <button class="tolerance-btn tolerance-btn-primary" data-action="disable-10">Disable for 10 minutes</button>
    <button class="tolerance-btn tolerance-btn-secondary" data-action="disable-session">Disable for this session</button>
  `;

  reelsTooltip.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const action = target.getAttribute('data-action');

    if (action === 'disable-10') {
      try {
        await sendMessage({ type: 'DISABLE_INSTAGRAM_TEMP', duration: 10 * 60 * 1000 });
        window.location.reload();
      } catch (err) {
        log.error('Failed to disable Instagram:', err);
      }
    } else if (action === 'disable-session') {
      try {
        await sendMessage({ type: 'DISABLE_INSTAGRAM_TEMP', duration: 24 * 60 * 60 * 1000 });
        window.location.reload();
      } catch (err) {
        log.error('Failed to disable Instagram:', err);
      }
    }
  });

  document.body.appendChild(reelsTooltip);
  return reelsTooltip;
}

let tooltipHideTimeout: ReturnType<typeof setTimeout> | null = null;

function showReelsTooltip(anchorElement: HTMLElement): void {
  // Cancel any pending hide
  if (tooltipHideTimeout) {
    clearTimeout(tooltipHideTimeout);
    tooltipHideTimeout = null;
  }

  const tooltip = createReelsTooltip();
  const rect = anchorElement.getBoundingClientRect();

  // Position to the right of the nav item
  tooltip.style.left = `${rect.right + 10}px`;
  tooltip.style.top = `${rect.top}px`;

  tooltip.classList.add('visible');

  // Add mouseleave handler to tooltip itself
  tooltip.onmouseenter = () => {
    if (tooltipHideTimeout) {
      clearTimeout(tooltipHideTimeout);
      tooltipHideTimeout = null;
    }
  };

  tooltip.onmouseleave = () => {
    hideReelsTooltip();
  };
}

function hideReelsTooltip(): void {
  // Delay hide slightly to allow moving to tooltip
  tooltipHideTimeout = setTimeout(() => {
    if (reelsTooltip) {
      reelsTooltip.classList.remove('visible');
    }
  }, 200);
}

function blurNavigationButtons(): void {
  // Find Explore and Reels links in the navigation
  const navLinks = document.querySelectorAll('a[href="/explore/"], a[href="/reels/"]');

  for (const link of navLinks) {
    if (!(link instanceof HTMLElement)) continue;
    if (link.querySelector('.tolerance-nav-blur')) continue; // Already blurred

    const isReels = link.getAttribute('href') === '/reels/';

    // Make the link container relative for positioning
    link.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'tolerance-nav-blur';

    if (isReels) {
      // Reels gets the tooltip
      overlay.addEventListener('mouseenter', () => {
        showReelsTooltip(link);
      });

      overlay.addEventListener('mouseleave', (e) => {
        // Don't hide if moving to tooltip
        const related = e.relatedTarget as HTMLElement;
        if (related?.closest('.tolerance-reels-tooltip')) return;
        hideReelsTooltip();
      });

      overlay.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showReelsTooltip(link);
      });
    } else {
      // Explore gets the 10-second reveal
      let revealTimer: ReturnType<typeof setTimeout> | null = null;
      let revealed = false;

      overlay.addEventListener('mouseenter', () => {
        if (revealed) return;
        revealTimer = setTimeout(() => {
          revealed = true;
          overlay.classList.add('revealed');
        }, 10000);
      });

      overlay.addEventListener('mouseleave', () => {
        if (revealed) return;
        if (revealTimer) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }
      });
    }

    link.appendChild(overlay);
  }

  // Hide tooltip when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.tolerance-reels-tooltip') && !target.closest('.tolerance-nav-blur')) {
      hideReelsTooltip();
    }
  }, { once: false });

  // Hide tooltip when mouse leaves tooltip itself
  if (reelsTooltip) {
    reelsTooltip.addEventListener('mouseleave', hideReelsTooltip);
  }
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
  log.warn(' Instagram: processPosts called, pathname:', pathname);

  // Extra safety: disconnect observer if we somehow end up on reels
  if (!isValidFeedPage()) {
    log.warn(' Instagram: processPosts bailing - not valid feed page');
    disconnectObserver();
    return;
  }

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
  log.warn(' Instagram: init() called, pathname:', window.location.pathname);

  // Check if Instagram is temporarily disabled
  try {
    const result = await sendMessage({ type: 'CHECK_INSTAGRAM_DISABLED' });
    if (result && (result as { isDisabled: boolean }).isDisabled) {
      log.warn(' Instagram: Temporarily disabled, skipping all processing');
      return;
    }
  } catch {
    // Continue if check fails
  }

  // Always inject styles first (needed for nav blur on any page)
  injectStyles();

  // Always blur navigation buttons (Explore, Reels) on any Instagram page
  blurNavigationButtons();
  // Re-check periodically in case Instagram recreates the nav
  setInterval(blurNavigationButtons, 2000);

  // Check if we should run feed processing on this page
  if (!isValidFeedPage()) {
    log.warn(' Instagram: Not a valid feed page, skipping feed processing');
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

// EARLY BAIL: Don't run anything on reels pages to prevent lockup
const pathname = window.location.pathname;
if (pathname.startsWith('/reels') || pathname.startsWith('/reel/')) {
  log.warn(' Instagram: On reels page, skipping ALL content script execution');
} else {
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
}

// Clean up on unload
window.addEventListener('unload', () => {
  disconnectObserver();
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
  }
});
