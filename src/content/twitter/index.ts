import { Tweet, EngagementScore, AppState, Settings, PostImpression } from '../../shared/types';
import { log, setLogLevel } from '../../shared/constants';
import { scrapeVisibleTweets, serializeTweet } from './scraper';
import { reorderTweets, recordImpressions } from './reorder';
import { setupTwitterObserver, setupNavigationObserver } from './observer';

// Track processed tweets to avoid re-processing
const processedTweetIds = new Set<string>();

// Cache scores for badge re-injection when Twitter recreates DOM elements
const scoreCache = new Map<string, { score: EngagementScore; originalPosition: number }>();

// Processing lock to prevent concurrent processTweets calls
let isProcessing = false;
let pendingProcess = false;

// Pre-loading state
const MIN_TWEETS_FOR_REORDER = 12;
let hasPreloaded = false;
let isPreloading = false;

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Recovery check - detect and fix stuck state
const RECOVERY_CHECK_INTERVAL = 10_000; // 10 seconds
let recoveryIntervalId: ReturnType<typeof setInterval> | null = null;
let lastProcessTime = Date.now();

function sendHeartbeat(): void {
  if (!isExtensionValid()) {
    // Stop heartbeat if extension is invalidated
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
    // Extension context lost
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  }
}

// Check if extension context is still valid
function isExtensionValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// Update blur threshold based on current phase and adaptive settings
async function updateBlurThreshold(): Promise<void> {
  if (!isExtensionValid()) return;

  try {
    // Get current global session to determine phase
    const sessionResult = await sendMessage({ type: 'GET_GLOBAL_SESSION' });
    if (sessionResult && 'phase' in sessionResult) {
      const newPhase = sessionResult.phase as typeof currentPhase;

      // Get effective threshold for this phase
      const thresholdResult = await sendMessage({
        type: 'GET_EFFECTIVE_BLUR_THRESHOLD',
        phase: newPhase,
      });

      if (thresholdResult && 'threshold' in thresholdResult) {
        const newThreshold = thresholdResult.threshold as number;
        if (newThreshold !== currentBlurThreshold || newPhase !== currentPhase) {
          log.debug(` Blur threshold updated - phase: ${newPhase}, threshold: ${newThreshold}`);
          currentBlurThreshold = newThreshold;
          currentPhase = newPhase;
        }
      }
    }
  } catch (error) {
    // Silently fail - will use default threshold
  }
}

// Check if a score should be blurred based on current threshold
function shouldBlurScore(score: EngagementScore): boolean {
  // Pre-filter: whitelisted sources bypass blur transform
  if (score.whitelisted) return false;

  const displayScore = score.apiScore ?? score.heuristicScore;
  // Quality Mode uses aggressive threshold (20)
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return;

  sendHeartbeat();
  updateBlurThreshold(); // Update threshold on start

  heartbeatIntervalId = setInterval(() => {
    sendHeartbeat();
    updateBlurThreshold(); // Update threshold with each heartbeat
  }, HEARTBEAT_INTERVAL);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
      updateBlurThreshold();
    }
  });

  log.debug(' Twitter heartbeat tracking started');
}

// Recovery check - if processing seems stuck, try to unstick it
function startRecoveryCheck(): void {
  if (recoveryIntervalId) return;

  recoveryIntervalId = setInterval(() => {
    if (!isExtensionValid()) {
      if (recoveryIntervalId) {
        clearInterval(recoveryIntervalId);
        recoveryIntervalId = null;
      }
      return;
    }

    // Skip recovery on detail pages
    if (isTweetDetailPage()) return;

    const timeSinceProcess = Date.now() - lastProcessTime;
    const hasVisibleTweets = document.querySelectorAll('[data-testid="tweet"]').length > 0;
    const hasUnbadgedTweets = document.querySelectorAll('[data-testid="cellInnerDiv"]:not(:has(.tolerance-score-badge)) [data-testid="tweet"]').length > 0;

    // If it's been a while, there are tweets, and some don't have badges, try to recover
    if (timeSinceProcess > 15000 && hasVisibleTweets && hasUnbadgedTweets && !isProcessing) {
      log.debug(' Recovery check - detected unbadged tweets, reprocessing');
      isProcessing = false;
      pendingProcess = false;
      processTweets();
    }
  }, RECOVERY_CHECK_INTERVAL);

  log.debug(' Recovery check started');
}

// Loading indicator and badge styles
let stylesInjected = false;

// Hover reveal delay (in ms) - configurable via settings
let hoverRevealDelay = 3000; // Default 3 seconds

// Adaptive blur threshold (score at or above this gets blurred)
// Fetched periodically based on current phase and user calibration
let currentBlurThreshold = 55; // Default for 'normal' phase
let currentPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal' = 'normal';

// Quality Mode - instant aggressive blur (scores > 20)
let qualityModeEnabled = false;
const QUALITY_MODE_THRESHOLD = 21;

// Track hover timers for timed reveal
const hoverTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.id = 'tolerance-twitter-styles';
  style.textContent = `
    /* Blur/fade effect on tweets during loading */
    [data-testid="primaryColumn"].tolerance-loading [data-testid="cellInnerDiv"] {
      filter: blur(2px);
      opacity: 0.5;
      transition: filter 0.2s ease, opacity 0.2s ease;
      pointer-events: none;
    }

    [data-testid="cellInnerDiv"] {
      transition: filter 0.2s ease, opacity 0.2s ease;
    }

    /* Loading spinner overlay */
    .tolerance-loader {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9999;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      background: rgba(30, 30, 30, 0.9);
      padding: 20px 28px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .tolerance-loader.visible {
      display: flex;
    }

    .tolerance-loader-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid rgba(29, 155, 240, 0.3);
      border-top-color: #1d9bf0;
      border-radius: 50%;
      animation: tolerance-spin 0.8s linear infinite;
    }

    .tolerance-loader-text {
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
    }

    @keyframes tolerance-spin {
      to { transform: rotate(360deg); }
    }

    /* Score badges - positioned below profile image */
    .tolerance-score-badge {
      position: absolute !important;
      top: 111px !important;
      left: 4px !important;
      right: auto !important;
      bottom: auto !important;
      width: fit-content !important;
      height: fit-content !important;
      max-width: 40px !important;
      min-width: 0 !important;
      padding: 2px 6px !important;
      margin: 0 !important;
      border-radius: 10px !important;
      font-size: 10px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      color: white !important;
      opacity: 0.9 !important;
      z-index: 9999 !important;
      pointer-events: auto !important;
      cursor: help !important;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
      display: block !important;
      flex: none !important;
      flex-grow: 0 !important;
      flex-shrink: 0 !important;
      flex-basis: auto !important;
      align-self: auto !important;
      justify-self: auto !important;
      grid-area: auto !important;
      line-height: 1.2 !important;
      text-align: center !important;
      box-sizing: border-box !important;
    }
    .tolerance-score-badge.high { background: #e74c3c !important; }
    .tolerance-score-badge.medium { background: #f39c12 !important; }
    .tolerance-score-badge.low { background: #27ae60 !important; }
    .tolerance-score-badge.pending { background: #95a5a6 !important; }

    /* Ensure badge is not blurred */
    .tolerance-blurred .tolerance-score-badge,
    .tolerance-pending .tolerance-score-badge {
      filter: none !important;
      pointer-events: auto !important;
    }

    /* Badge tooltip - appears to the right of badge */
    .tolerance-score-badge .tolerance-tooltip {
      visibility: hidden;
      opacity: 0;
      position: absolute;
      bottom: 100%;
      left: 0;
      transform: none;
      margin-bottom: 8px;
      padding: 8px 12px;
      background: rgba(20, 20, 20, 0.95);
      color: #e0e0e0;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 400;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      transition: opacity 0.15s ease, visibility 0.15s ease;
      z-index: 10000;
      pointer-events: none;
    }
    .tolerance-score-badge:hover .tolerance-tooltip {
      visibility: visible;
      opacity: 1;
    }
    .tolerance-tooltip-reason {
      margin-bottom: 4px;
      font-style: italic;
      max-width: 250px;
      white-space: normal;
    }
    .tolerance-tooltip-positions {
      font-size: 11px;
      color: #aaa;
    }
    .tolerance-tooltip-positions.moved-up { color: #7dcea0; }
    .tolerance-tooltip-positions.moved-down { color: #e67e73; }

    /* Blur effect (pending and high-engagement) */
    .tolerance-blurred,
    .tolerance-pending {
      filter: blur(var(--tolerance-blur, 8px)) !important;
      transition: filter 0.3s ease !important;
    }

    /* Revealed state (set by JS after hover delay) */
    .tolerance-blurred.tolerance-revealed,
    .tolerance-pending.tolerance-revealed {
      filter: blur(0px) !important;
    }

    .tolerance-blur-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.1);
      z-index: 100;
      pointer-events: auto;
      cursor: not-allowed;
      opacity: 1;
      transition: opacity 0.3s ease;
    }
    .tolerance-revealed .tolerance-blur-overlay {
      opacity: 0;
      pointer-events: none;
    }
    .tolerance-blur-label {
      background: rgba(231, 76, 60, 0.9);
      color: white;
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 12px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .tolerance-pending .tolerance-blur-label {
      background: rgba(149, 165, 166, 0.9);
    }
  `;
  document.head.appendChild(style);
}

// Set up timed hover reveal for an element
function setupHoverReveal(element: HTMLElement): void {
  // Avoid duplicate listeners
  if (element.dataset.hoverSetup) return;
  element.dataset.hoverSetup = 'true';

  element.addEventListener('mouseenter', () => {
    // Clear any existing timer
    const existingTimer = hoverTimers.get(element);
    if (existingTimer) clearTimeout(existingTimer);

    // Start new timer
    const timer = setTimeout(() => {
      element.classList.add('tolerance-revealed');
    }, hoverRevealDelay);
    hoverTimers.set(element, timer);
  });

  element.addEventListener('mouseleave', () => {
    // Clear timer
    const timer = hoverTimers.get(element);
    if (timer) {
      clearTimeout(timer);
      hoverTimers.delete(element);
    }
    // Re-blur on mouse leave
    element.classList.remove('tolerance-revealed');
  });
}

function createLoaderElement(): HTMLElement {
  let loader = document.querySelector('.tolerance-loader') as HTMLElement;
  if (loader) return loader;

  loader = document.createElement('div');
  loader.className = 'tolerance-loader';
  loader.innerHTML = `
    <div class="tolerance-loader-spinner"></div>
    <div class="tolerance-loader-text">Loading tweets...</div>
  `;
  document.body.appendChild(loader);
  return loader;
}

function showLoading(text?: string): void {
  injectStyles();
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  if (primaryColumn) {
    primaryColumn.classList.add('tolerance-loading');
  }
  const loader = createLoaderElement();
  if (text) {
    const textEl = loader.querySelector('.tolerance-loader-text');
    if (textEl) textEl.textContent = text;
  }
  loader.classList.add('visible');
}

function hideLoading(): void {
  const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
  if (primaryColumn) {
    primaryColumn.classList.remove('tolerance-loading');
  }
  const loader = document.querySelector('.tolerance-loader');
  if (loader) {
    loader.classList.remove('visible');
  }
}

// Badge info for injection
interface BadgeInfo {
  score: number;
  bucket: string;
  reason?: string;
  originalPosition: number;
  newPosition: number;
  // Debug info
  hasImage?: boolean;
  hasQuote?: boolean;
  mediaType?: string;
}

// Inject score badge on a tweet
function injectScoreBadge(tweet: Tweet, info: BadgeInfo): void {
  if (!tweet.element) {
    log.debug(` Badge injection failed - no element for tweet ${tweet.id}`);
    return;
  }

  const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
  if (!cell) {
    log.debug(` Badge injection failed - no cellInnerDiv for tweet ${tweet.id}`);
    return;
  }

  // Don't add duplicate badges
  if (cell.querySelector('.tolerance-score-badge')) {
    log.debug(` Badge already exists for tweet ${tweet.id}`);
    return;
  }

  // Ensure cell has position for absolute positioning to work
  if (getComputedStyle(cell).position === 'static') {
    cell.style.position = 'relative';
  }

  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${info.bucket}`;
  badge.textContent = String(Math.round(info.score));

  // Build tooltip content
  const tooltip = document.createElement('div');
  tooltip.className = 'tolerance-tooltip';

  // Reason
  if (info.reason) {
    const reasonDiv = document.createElement('div');
    reasonDiv.className = 'tolerance-tooltip-reason';
    reasonDiv.textContent = `"${info.reason}"`;
    tooltip.appendChild(reasonDiv);
  }

  // Positions
  const posDiv = document.createElement('div');
  const posDiff = info.originalPosition - info.newPosition;
  if (posDiff > 0) {
    posDiv.className = 'tolerance-tooltip-positions moved-up';
    posDiv.textContent = `Position: ${info.originalPosition + 1} → ${info.newPosition + 1} (↑${posDiff})`;
  } else if (posDiff < 0) {
    posDiv.className = 'tolerance-tooltip-positions moved-down';
    posDiv.textContent = `Position: ${info.originalPosition + 1} → ${info.newPosition + 1} (↓${Math.abs(posDiff)})`;
  } else {
    posDiv.className = 'tolerance-tooltip-positions';
    posDiv.textContent = `Position: ${info.newPosition + 1} (unchanged)`;
  }
  tooltip.appendChild(posDiv);

  // Debug info - media/quote status
  const debugDiv = document.createElement('div');
  debugDiv.className = 'tolerance-tooltip-positions';
  debugDiv.style.marginTop = '4px';
  const parts: string[] = [];
  if (info.mediaType) parts.push(`type:${info.mediaType}`);
  if (info.hasImage) parts.push('📷');
  if (info.hasQuote) parts.push('💬');
  if (parts.length > 0) {
    debugDiv.textContent = parts.join(' ');
    tooltip.appendChild(debugDiv);
  }

  badge.appendChild(tooltip);
  cell.appendChild(badge);
  log.debug(` Badge injected for tweet ${tweet.id}, score=${info.score}, bucket=${info.bucket}`);
}

// Apply pending blur (before scoring) to a tweet
function applyPendingBlur(tweet: Tweet, blurIntensity: number = 8): void {
  if (!tweet.element) return;

  const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
  if (!cell) return;

  // Don't blur if already blurred or pending
  if (cell.classList.contains('tolerance-blurred') ||
      cell.classList.contains('tolerance-pending')) return;

  cell.style.setProperty('--tolerance-blur', `${blurIntensity}px`);
  cell.classList.add('tolerance-pending');

  // Set up timed hover reveal
  setupHoverReveal(cell);

  // Ensure cell has position for overlay
  if (getComputedStyle(cell).position === 'static') {
    cell.style.position = 'relative';
  }

  // Add overlay with "scoring..." label
  if (!cell.querySelector('.tolerance-blur-overlay')) {
    const overlay = document.createElement('div');
    overlay.className = 'tolerance-blur-overlay';

    // Block clicks on blurred content
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const label = document.createElement('div');
    label.className = 'tolerance-blur-label';
    label.textContent = 'Scoring...';

    overlay.appendChild(label);
    cell.appendChild(overlay);
  }
}

// Remove pending blur (after scoring reveals it's not high-engagement)
function removePendingBlur(tweet: Tweet): void {
  if (!tweet.element) return;

  const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
  if (!cell) return;

  cell.classList.remove('tolerance-pending');
  cell.classList.remove('tolerance-revealed');
  cell.style.removeProperty('--tolerance-blur');

  // Remove overlay
  const overlay = cell.querySelector('.tolerance-blur-overlay');
  if (overlay) overlay.remove();
}

// Apply blur effect to high-engagement tweets
function applyBlurToTweet(tweet: Tweet, score: number, reason?: string, blurIntensity: number = 8): void {
  if (!tweet.element) return;

  const cell = tweet.element.closest('[data-testid="cellInnerDiv"]') as HTMLElement;
  if (!cell) return;

  // Remove pending state if present
  cell.classList.remove('tolerance-pending');

  // Don't blur twice
  if (cell.classList.contains('tolerance-blurred')) return;

  // Set blur intensity via CSS variable
  cell.style.setProperty('--tolerance-blur', `${blurIntensity}px`);
  cell.classList.add('tolerance-blurred');

  // Set up timed hover reveal
  setupHoverReveal(cell);

  // Ensure cell has position for overlay
  if (getComputedStyle(cell).position === 'static') {
    cell.style.position = 'relative';
  }

  // Remove any existing overlay first
  const existingOverlay = cell.querySelector('.tolerance-blur-overlay');
  if (existingOverlay) existingOverlay.remove();

  // Add overlay with label
  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';

  // Block clicks on blurred content
  overlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const label = document.createElement('div');
  label.className = 'tolerance-blur-label';
  label.textContent = reason
    ? `High engagement (${Math.round(score)}): ${reason}`
    : `High engagement content (${Math.round(score)})`;
  label.style.maxWidth = '80%';
  label.style.textAlign = 'center';

  overlay.appendChild(label);
  cell.appendChild(overlay);

  log.debug(` Blurred high-engagement tweet ${tweet.id}, score=${score}`);
}

// Helper for async delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pre-load tweets by scrolling down then back up
async function preloadTweets(): Promise<void> {
  if (hasPreloaded || isPreloading) return;
  if (isTweetDetailPage()) return;

  isPreloading = true;
  log.debug(' Starting tweet preload...');

  const MAX_SCROLL_ATTEMPTS = 10;
  const SCROLL_STEP = 600; // pixels per scroll
  const SCROLL_DELAY = 250; // ms between scrolls

  let attempts = 0;
  let currentScroll = 0;

  showLoading('Loading tweets...');

  try {
    while (attempts < MAX_SCROLL_ATTEMPTS) {
      const tweets = scrapeVisibleTweets();
      log.debug(` Preload attempt ${attempts + 1}, found ${tweets.length} tweets`);

      if (tweets.length >= MIN_TWEETS_FOR_REORDER) {
        log.debug(` Preload complete - got ${tweets.length} tweets`);
        break;
      }

      // Scroll down
      currentScroll += SCROLL_STEP;
      window.scrollTo({ top: currentScroll, behavior: 'instant' });

      // Wait for tweets to load
      await sleep(SCROLL_DELAY);
      attempts++;
    }

    // Scroll back to top
    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(150);

  } finally {
    hideLoading();
    hasPreloaded = true;
    isPreloading = false;
  }
}

// Current state
let currentState: AppState | null = null;
let currentSettings: Settings | null = null;

// Check if we're on a timeline page (not a tweet detail page)
function isTimelinePage(): boolean {
  const path = window.location.pathname;
  // Timeline pages: /home, /explore, /@username (without /status/)
  return (
    path === '/home' ||
    path === '/explore' ||
    path.startsWith('/i/') ||
    (path.match(/^\/\w+$/) !== null && !path.includes('/status/'))
  );
}

// Check if we're on a tweet detail page
function isTweetDetailPage(): boolean {
  return window.location.pathname.includes('/status/');
}

// Initialize content script
async function init(): Promise<void> {
  log.debug(' Twitter content script loaded on', window.location.href);

  // Wait for Twitter's SPA to load the timeline
  await waitForTimeline();

  await initCore();
}

async function waitForTimeline(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const timeline = document.querySelector('[data-testid="primaryColumn"]');
      if (timeline) {
        resolve();
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

// Wait for tweets to actually appear (they load after the timeline container)
async function waitForTweets(): Promise<void> {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 20; // 10 seconds max

    const check = () => {
      const tweets = document.querySelectorAll('[data-testid="tweet"]');
      if (tweets.length > 0) {
        log.debug(` Found ${tweets.length} initial tweets`);
        resolve();
      } else if (attempts >= maxAttempts) {
        log.debug(' Timeout waiting for tweets, proceeding anyway');
        resolve();
      } else {
        attempts++;
        setTimeout(check, 500);
      }
    };
    check();
  });
}

async function initCore(): Promise<void> {
  // Get initial state from background
  const stateResult = await sendMessage({ type: 'GET_STATE' });
  if (!stateResult || !('state' in stateResult)) {
    log.debug(' Failed to get state, extension inactive');
    return;
  }

  currentState = stateResult.state;
  currentSettings = stateResult.settings;

  // Initialize log level from settings
  if (currentSettings.logLevel) {
    setLogLevel(currentSettings.logLevel);
  }

  // Check if Twitter platform is enabled
  if (currentSettings.platforms?.twitter === false) {
    log.debug(' Twitter platform disabled in settings, extension inactive');
    return;
  }

  // Inject styles only if platform is enabled
  injectStyles();

  log.debug(' Mode =', currentState.mode);

  // Update hover reveal delay from settings (convert seconds to ms)
  const settingsDelay = currentSettings?.twitter?.hoverRevealDelay ?? 3;
  hoverRevealDelay = settingsDelay * 1000;
  log.debug(` Hover reveal delay = ${settingsDelay}s`);

  // Initialize quality mode from settings
  qualityModeEnabled = currentSettings.qualityMode ?? false;
  log.debug(` Quality Mode = ${qualityModeEnabled}`);

  if (currentState.mode === 'baseline') {
    const daysRemaining = calculateBaselineDaysRemaining();
    log.debug(` Baseline mode - ${daysRemaining.toFixed(1)} days remaining`);
  }

  // Ensure we have a session
  const sessionResult = await sendMessage({ type: 'ENSURE_SESSION' });
  log.debug(' Session result:', sessionResult);

  // Start heartbeat tracking
  startHeartbeat();

  // Start recovery check for stuck states
  startRecoveryCheck();

  // Pre-load tweets via scrolling (only needed when reordering is enabled)
  const twitterReorderEnabled = currentSettings?.twitter?.reorderEnabled ?? false;
  if (currentState?.mode === 'active' && !isTweetDetailPage() && twitterReorderEnabled) {
    await preloadTweets();
  }

  // Wait for tweets to appear before processing
  if (!isTweetDetailPage()) {
    await waitForTweets();
  }

  // Process initial tweets
  await processTweets();

  // Set up observer for infinite scroll
  setupTwitterObserver(handleNewTweets);

  // Set up navigation observer for SPA navigation
  setupNavigationObserver(() => {
    log.debug(' Navigation detected, resetting state');
    // Reset state on navigation
    processedTweetIds.clear();
    scoreCache.clear();
    hasPreloaded = false;
    isProcessing = false; // Reset lock in case it got stuck
    pendingProcess = false;

    // Re-initialize after navigation (Twitter needs time to render new content)
    setTimeout(async () => {
      log.debug(' Re-initializing after navigation, path:', window.location.pathname);

      // Re-setup timeline observer for new DOM
      setupTwitterObserver(handleNewTweets);

      const reorderEnabled = currentSettings?.twitter?.reorderEnabled ?? false;
      if (currentState?.mode === 'active' && !isTweetDetailPage() && reorderEnabled) {
        await preloadTweets();
      }

      // Wait for tweets to appear after navigation
      if (!isTweetDetailPage()) {
        await waitForTweets();
      }

      await processTweets();
    }, 500);
  });
}

function calculateBaselineDaysRemaining(): number {
  if (!currentState) return 7;
  const msElapsed = Date.now() - currentState.baselineStartDate;
  const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
  return Math.max(0, currentState.baselineDurationDays - daysElapsed);
}

async function handleNewTweets(): Promise<void> {
  log.debug(' New tweets detected');
  await processTweets();
}

// Main processing function
async function processTweets(): Promise<void> {
  // Don't process on tweet detail pages (like Reddit comments)
  if (isTweetDetailPage()) {
    return;
  }

  // Prevent concurrent processing
  if (isProcessing) {
    pendingProcess = true;
    log.debug(' Processing already in progress, queued for later');
    return;
  }

  isProcessing = true;

  try {
    const t0 = performance.now();

    // Scrape all visible tweets
    const allTweets = scrapeVisibleTweets();
    const t1 = performance.now();

    // Separate into new tweets (need scoring) and processed tweets (may need badge re-injection)
    const newTweets: Tweet[] = [];
    const tweetsNeedingBadge: Tweet[] = [];

    for (const tweet of allTweets) {
      if (!processedTweetIds.has(tweet.id)) {
        newTweets.push(tweet);
      } else {
        // Check if this processed tweet needs badge re-injection
        // (Twitter may have recreated the DOM element)
        const cell = tweet.element?.closest('[data-testid="cellInnerDiv"]');
        if (cell && !cell.querySelector('.tolerance-score-badge') && scoreCache.has(tweet.id)) {
          tweetsNeedingBadge.push(tweet);
        }
      }
    }

    // Re-inject badges for processed tweets that lost them
    if (tweetsNeedingBadge.length > 0) {
      log.debug(` Re-injecting ${tweetsNeedingBadge.length} badges for processed tweets`);
      for (const tweet of tweetsNeedingBadge) {
        const cached = scoreCache.get(tweet.id);
        if (cached) {
          const displayScore = cached.score.apiScore ?? cached.score.heuristicScore;
          injectScoreBadge(tweet, {
            score: displayScore,
            bucket: cached.score.bucket,
            reason: cached.score.apiReason,
            originalPosition: cached.originalPosition,
            newPosition: cached.originalPosition, // Same position for re-injection
            hasImage: !!tweet.imageUrl,
            hasQuote: tweet.isQuoteTweet,
            mediaType: tweet.mediaType,
          });

          // Re-apply blur if needed (based on adaptive threshold)
          const twitterSettings = currentSettings?.twitter;
          if (twitterSettings?.blurHighEngagement && !twitterSettings?.reorderEnabled && shouldBlurScore(cached.score)) {
            applyBlurToTweet(tweet, displayScore, cached.score.apiReason, twitterSettings.blurIntensity);
          }
        }
      }
    }

    if (newTweets.length === 0) {
      return;
    }

    log.debug(` Processing ${newTweets.length} new tweets (scrape: ${(t1 - t0).toFixed(0)}ms)`);
    lastProcessTime = Date.now();

    // Apply pending blur to all new tweets immediately (blur until scored)
    const earlyTwitterSettings = currentSettings?.twitter;
    if (earlyTwitterSettings?.blurHighEngagement && !earlyTwitterSettings?.reorderEnabled) {
      for (const tweet of newTweets) {
        applyPendingBlur(tweet, earlyTwitterSettings.blurIntensity ?? 8);
      }
    }

    // Debug: log media info for each tweet
    for (const tweet of newTweets) {
      const quoteInfo = tweet.quotedTweet
        ? `quotedAuthor=${tweet.quotedTweet.author}, quotedText="${tweet.quotedTweet.text?.slice(0, 30)}...", quotedImage=${!!tweet.quotedTweet.imageUrl}`
        : 'no quote';
      log.debug(` Tweet ${tweet.id.slice(0, 8)}... mediaType=${tweet.mediaType}, hasImage=${!!tweet.imageUrl}, isQuote=${tweet.isQuoteTweet}, ${quoteInfo}, text="${tweet.text.slice(0, 30)}..."`);
    }

    // Get scores from background (don't mark as processed yet!)
    const serializedTweets = newTweets.map(serializeTweet);
    const t2 = performance.now();
    const scoreResult = await sendMessage({
      type: 'SCORE_TWEETS',
      tweets: serializedTweets,
    });
    const t3 = performance.now();
    log.debug(` SCORE_TWEETS took ${(t3 - t2).toFixed(0)}ms`);

    if (!scoreResult || !('scores' in scoreResult)) {
      log.error(' Failed to get scores - tweets will be retried');
      return;
    }

    // NOW mark as processed since we got scores successfully
    for (const tweet of newTweets) {
      processedTweetIds.add(tweet.id);
    }

    const scores = new Map<string, EngagementScore>();
    for (const score of scoreResult.scores) {
      scores.set(score.postId, score);
    }

    // Create tweet map for badge injection after reordering
    const tweetMap = new Map(newTweets.map(t => [t.id, t]));

    // Log score distribution
    logScoreDistribution(scoreResult.scores);

    let impressions: PostImpression[];

    // Get Twitter-specific settings
    const twitterSettings = currentSettings?.twitter ?? {
      reorderEnabled: false,
      blurHighEngagement: true,
      blurIntensity: 8,
    };

    if (currentState?.mode === 'baseline') {
      // Baseline mode: just record, don't reorder
      impressions = recordImpressions(newTweets, scores);
    } else if (twitterSettings.reorderEnabled) {
      // Active mode with reordering enabled
      const orderResult = await sendMessage({
        type: 'GET_SCHEDULER_ORDER',
        postIds: newTweets.map(t => t.id),
        scores: scoreResult.scores,
      });

      if (orderResult && 'orderedIds' in orderResult) {
        impressions = reorderTweets(newTweets, scores, orderResult.orderedIds as string[]);
        const reorderedCount = impressions.filter(i => i.wasReordered).length;
        if (reorderedCount > 0) {
          log.debug(` Reordered ${reorderedCount} tweets`);
        }
      } else {
        impressions = recordImpressions(newTweets, scores);
      }
    } else {
      // Reordering disabled - just record impressions
      log.debug(' Twitter reordering disabled, using blur instead');
      impressions = recordImpressions(newTweets, scores);
    }

    // Handle blur based on engagement level (when enabled and not reordering)
    // Uses adaptive threshold that varies by phase and user calibration
    if (twitterSettings.blurHighEngagement && !twitterSettings.reorderEnabled) {
      for (const tweet of newTweets) {
        const score = scores.get(tweet.id);
        if (score) {
          if (shouldBlurScore(score)) {
            // Blur tweets above threshold (threshold lowers as session progresses)
            const displayScore = score.apiScore ?? score.heuristicScore;
            applyBlurToTweet(tweet, displayScore, score.apiReason, twitterSettings.blurIntensity);
          } else {
            // Remove blur for tweets below threshold
            removePendingBlur(tweet);
          }
        }
      }
    }

    // Inject badges with full info (reason + positions + debug)
    // Also cache scores for re-injection when Twitter recreates DOM elements
    for (const impression of impressions) {
      const tweet = tweetMap.get(impression.postId);
      const score = scores.get(impression.postId);
      if (tweet && score) {
        // Cache for re-injection
        scoreCache.set(tweet.id, {
          score,
          originalPosition: impression.originalPosition,
        });

        const displayScore = score.apiScore ?? score.heuristicScore;
        injectScoreBadge(tweet, {
          score: displayScore,
          bucket: score.bucket,
          reason: score.apiReason,
          originalPosition: impression.originalPosition,
          newPosition: impression.position,
          // Debug info
          hasImage: !!tweet.imageUrl,
          hasQuote: tweet.isQuoteTweet,
          mediaType: tweet.mediaType,
        });
      }
    }

    // Log impressions to storage
    await sendMessage({
      type: 'LOG_IMPRESSIONS',
      impressions,
    });
  } catch (error) {
    log.error(' Error processing tweets:', error);
  } finally {
    // Release lock
    isProcessing = false;

    // Process pending requests
    if (pendingProcess) {
      pendingProcess = false;
      log.debug(' Processing queued tweets');
      // Use setTimeout to avoid deep recursion
      setTimeout(() => processTweets(), 50);
    }
  }
}

function logScoreDistribution(scores: EngagementScore[]): void {
  const buckets = { high: 0, medium: 0, low: 0 };
  for (const score of scores) {
    buckets[score.bucket]++;
  }
  log.debug(
    `Scores - High: ${buckets.high}, Medium: ${buckets.medium}, Low: ${buckets.low}`
  );
}

// Send message to background script
async function sendMessage(message: unknown): Promise<unknown> {
  if (!isExtensionValid()) {
    log.warn(' Extension context invalidated - please refresh the page');
    return null;
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errorMsg = chrome.runtime.lastError.message || '';
          if (errorMsg.includes('Extension context invalidated')) {
            log.warn(' Extension was reloaded - please refresh the page');
          } else {
            log.error(' Message error:', chrome.runtime.lastError);
          }
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      log.warn(' Extension context lost:', error);
      resolve(null);
    }
  });
}

// Handle quality mode changes from popup
function refreshBlurState(): void {
  const twitterSettings = currentSettings?.twitter;
  if (!twitterSettings?.blurHighEngagement || twitterSettings?.reorderEnabled) return;

  log.debug(` Refreshing blur state, qualityMode=${qualityModeEnabled}`);

  // Get all tweets that have been scored (have badges)
  const cells = document.querySelectorAll('[data-testid="cellInnerDiv"]');

  for (const cell of cells) {
    const badge = cell.querySelector('.tolerance-score-badge');
    if (!badge) continue;

    const scoreText = badge.textContent?.trim();
    const score = parseInt(scoreText || '0', 10);
    if (isNaN(score)) continue;

    const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
    const shouldBlur = score >= threshold;
    const isBlurred = cell.classList.contains('tolerance-blurred');

    if (shouldBlur && !isBlurred) {
      // Need to blur this tweet
      const htmlCell = cell as HTMLElement;
      htmlCell.style.setProperty('--tolerance-blur', `${twitterSettings.blurIntensity ?? 8}px`);
      htmlCell.classList.add('tolerance-blurred');

      // Ensure cell has position for overlay
      if (getComputedStyle(htmlCell).position === 'static') {
        htmlCell.style.position = 'relative';
      }

      // Add overlay if not present
      if (!htmlCell.querySelector('.tolerance-blur-overlay')) {
        const overlay = document.createElement('div');
        overlay.className = 'tolerance-blur-overlay';
        overlay.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        const label = document.createElement('div');
        label.className = 'tolerance-blur-label';
        label.textContent = `High engagement content (${score})`;
        label.style.maxWidth = '80%';
        label.style.textAlign = 'center';

        overlay.appendChild(label);
        htmlCell.appendChild(overlay);
      }

      // Set up hover reveal
      setupHoverReveal(htmlCell);
    } else if (!shouldBlur && isBlurred) {
      // Need to unblur this tweet
      cell.classList.remove('tolerance-blurred');
      cell.classList.remove('tolerance-revealed');
      (cell as HTMLElement).style.removeProperty('--tolerance-blur');

      // Remove overlay
      const overlay = cell.querySelector('.tolerance-blur-overlay');
      if (overlay) overlay.remove();
    }
  }
}

// Listen for quality mode changes from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'QUALITY_MODE_CHANGED') {
    qualityModeEnabled = message.enabled;
    log.debug(` Quality mode ${qualityModeEnabled ? 'enabled' : 'disabled'}`);
    refreshBlurState();
    sendResponse({ success: true });
  }
  return true;
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
