import { YouTubeVideo, EngagementScore, AppState, Settings } from '../../shared/types';
import { log, setLogLevel } from '../../shared/constants';
import { scrapeVisibleVideos, serializeVideo } from './scraper';
import { setupYouTubeObserver, setupNavigationObserver } from './observer';
import { injectOnboardingStyles, showOnboardingTooltip } from '../onboarding';

// Track processed videos to avoid re-processing
const processedVideoIds = new Set<string>();

// Cache scores for badge re-injection when YouTube re-renders
const scoreCache = new Map<string, { score: EngagementScore; position: number }>();

// Processing lock to prevent concurrent processVideos calls
let isProcessing = false;
let pendingProcess = false;

// Recovery check for stuck states
const RECOVERY_CHECK_INTERVAL = 10_000;
let recoveryIntervalId: ReturnType<typeof setInterval> | null = null;
let lastProcessTime = Date.now();

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000;
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Check if extension context is still valid
function isExtensionValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function sendHeartbeat(): void {
  if (!isExtensionValid()) {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
    return;
  }

  // Don't count time when tab is not visible
  if (document.visibilityState !== 'visible') {
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'SOCIAL_MEDIA_HEARTBEAT' }, () => {
      if (chrome.runtime.lastError) {
        // Silent fail
      }
    });
  } catch {
    if (heartbeatIntervalId) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  }
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

  log.debug(' YouTube heartbeat tracking started');
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

    // Skip recovery on video watch pages (we only badge browse pages)
    if (isWatchPage()) return;

    const timeSinceProcess = Date.now() - lastProcessTime;
    const hasVisibleVideos = document.querySelectorAll('ytd-rich-item-renderer, ytd-compact-video-renderer').length > 0;
    const hasUnbadgedVideos = document.querySelectorAll('ytd-rich-item-renderer:not(:has(.tolerance-score-badge)), ytd-compact-video-renderer:not(:has(.tolerance-score-badge))').length > 0;

    if (timeSinceProcess > 15000 && hasVisibleVideos && hasUnbadgedVideos && !isProcessing) {
      log.debug(' Recovery check - detected unbadged videos, reprocessing');
      isProcessing = false;
      pendingProcess = false;
      processVideos();
    }
  }, RECOVERY_CHECK_INTERVAL);

  log.debug(' Recovery check started');
}

// Styles for badges and blur effect
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

// Subscriptions Only - blur everything except subscribed sources
let subscriptionsOnlyMode = false;

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
          log.debug(` YouTube blur threshold updated - phase: ${newPhase}, threshold: ${newThreshold}`);
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
function shouldBlurScore(score: { apiScore: number; scoreFailed?: boolean; whitelisted?: boolean }): boolean {
  // Don't blur if scoring failed
  if (score.scoreFailed) return false;

  // Pre-filter: whitelisted sources bypass blur transform
  if (score.whitelisted) return false;

  // Subscriptions-only: blur ALL non-whitelisted content
  if (subscriptionsOnlyMode) return true;

  const displayScore = score.apiScore;
  // Quality Mode uses aggressive threshold (20)
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

// Track hover timers for timed reveal
const hoverTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.id = 'tolerance-youtube-styles';
  style.textContent = `
    /* Score badges */
    .tolerance-score-badge {
      position: absolute !important;
      bottom: -49px !important;
      right: 8px !important;
      padding: 2px 8px !important;
      border-radius: 12px !important;
      font-size: 11px !important;
      font-weight: 600 !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      color: white !important;
      opacity: 0.9 !important;
      z-index: 9999 !important;
      pointer-events: auto !important;
      cursor: help !important;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3) !important;
      display: block !important;
    }
    .tolerance-score-badge.high { background: #e74c3c !important; }
    .tolerance-score-badge.medium { background: #f39c12 !important; }
    .tolerance-score-badge.low { background: #27ae60 !important; }
    .tolerance-score-badge.pending { background: #95a5a6 !important; }
    .tolerance-score-badge.failed { background: #7f8c8d !important; color: #fff !important; }

    /* Ensure badge is not blurred on blurred videos */
    .tolerance-blurred .tolerance-score-badge,
    .tolerance-pending .tolerance-score-badge {
      filter: none !important;
      pointer-events: auto !important;
    }

    /* Sidebar video badge positioning (far right of card, vertically centered) */
    .tolerance-sidebar-video {
      position: relative !important;
    }
    .tolerance-sidebar-video > .tolerance-score-badge {
      position: absolute !important;
      top: 50% !important;
      bottom: auto !important;
      right: 8px !important;
      left: auto !important;
      transform: translateY(-50%) !important;
      font-size: 12px !important;
      padding: 4px 8px !important;
      z-index: 1000 !important;
    }

    /* Badge tooltip */
    .tolerance-score-badge .tolerance-tooltip {
      visibility: hidden;
      opacity: 0;
      position: absolute;
      bottom: 100%;
      right: 0;
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
    .tolerance-tooltip-meta {
      font-size: 11px;
      color: #aaa;
    }

    /* Blur effect - covers entire video card (title, description, thumbnail) */
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

// Show one-time tip about disabling video previews
function showVideoPreviewTip(): void {
  const tipShown = sessionStorage.getItem('tolerance-preview-tip');
  if (tipShown) return;

  log.info(
    'Tip: For best results, disable YouTube video previews:\n' +
    'Click your profile icon → Settings → Playback and performance → uncheck "Video previews"'
  );

  sessionStorage.setItem('tolerance-preview-tip', 'true');
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

// Badge info interface
interface BadgeInfo {
  score: number;
  bucket: string;
  reason?: string;
  channel?: string;
  viewCount?: number;
  scoringFailed?: boolean;
}

// Inject score badge on a video thumbnail
function injectScoreBadge(video: YouTubeVideo, info: BadgeInfo): void {
  if (!video.element) return;

  // Don't add duplicate badges
  if (video.element.querySelector('.tolerance-score-badge')) {
    return;
  }

  // Check if this is a sidebar/compact video (horizontal layout)
  const isSidebar = video.element.matches('yt-lockup-view-model, ytd-compact-video-renderer') ||
                    video.element.closest('ytd-watch-next-secondary-results-renderer') !== null;

  let badgeContainer: HTMLElement;

  if (isSidebar) {
    // For sidebar videos, append to the video element itself (positioned far right)
    badgeContainer = video.element as HTMLElement;
    video.element.classList.add('tolerance-sidebar-video');
  } else {
    // For homepage/grid videos, append to thumbnail
    const thumbnail = video.element.querySelector(
      'a.yt-lockup-view-model__content-image, ' +    // New lockup model (link wrapping thumbnail)
      'yt-thumbnail-view-model, ' +                   // New thumbnail component
      '.ytThumbnailViewModelImage, ' +                // New thumbnail image container
      '#thumbnail, ' +                                // Legacy selector
      'ytd-thumbnail'                                 // Legacy component
    ) as HTMLElement;
    if (!thumbnail) {
      log.debug(` No thumbnail found for video ${video.id}`);
      return;
    }
    badgeContainer = thumbnail;
  }

  // Ensure container has position for absolute positioning
  if (getComputedStyle(badgeContainer).position === 'static') {
    badgeContainer.style.position = 'relative';
  }

  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${info.scoringFailed ? 'failed' : info.bucket}`;
  badge.textContent = info.scoringFailed ? '?' : String(Math.round(info.score));

  // Build tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'tolerance-tooltip';

  if (info.scoringFailed) {
    const reasonDiv = document.createElement('div');
    reasonDiv.className = 'tolerance-tooltip-reason';
    const isOwnKey = currentSettings?.apiTier === 'own-key';
    reasonDiv.textContent = isOwnKey
      ? 'Error receiving score.'
      : 'Free tier exhausted. Click to upgrade to Pro, or use your own API key.';
    tooltip.appendChild(reasonDiv);

    // Make badge clickable and open account page
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open('https://tolerance.lol/account.html', '_blank');
    });
  } else if (info.reason) {
    const reasonDiv = document.createElement('div');
    reasonDiv.className = 'tolerance-tooltip-reason';
    reasonDiv.textContent = `"${info.reason}"`;
    tooltip.appendChild(reasonDiv);
  }

  const metaDiv = document.createElement('div');
  metaDiv.className = 'tolerance-tooltip-meta';
  const parts: string[] = [];
  if (info.channel) parts.push(info.channel);
  if (info.viewCount) parts.push(`${formatViewCount(info.viewCount)} views`);
  if (parts.length > 0) {
    metaDiv.textContent = parts.join(' • ');
    tooltip.appendChild(metaDiv);
  }

  badge.appendChild(tooltip);
  badgeContainer.appendChild(badge);

  log.debug(` Badge injected for video ${video.id}, score=${info.score}, bucket=${info.bucket}${isSidebar ? ' (sidebar)' : ''}`);
}

function formatViewCount(count: number): string {
  if (count >= 1000000000) return (count / 1000000000).toFixed(1) + 'B';
  if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
  if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
  return count.toString();
}

// Apply pending blur (before scoring) to a video
function applyPendingBlur(video: YouTubeVideo, blurIntensity: number = 8): void {
  if (!video.element) return;

  // Don't blur if already blurred or pending
  if (video.element.classList.contains('tolerance-blurred') ||
      video.element.classList.contains('tolerance-pending')) return;

  video.element.style.setProperty('--tolerance-blur', `${blurIntensity}px`);
  video.element.classList.add('tolerance-pending');

  // Set up timed hover reveal
  setupHoverReveal(video.element);

  // Find thumbnail for overlay
  const thumbnail = video.element.querySelector(
    'a.yt-lockup-view-model__content-image, ' +
    'yt-thumbnail-view-model, ' +
    '.ytThumbnailViewModelImage, ' +
    '#thumbnail, ' +
    'ytd-thumbnail'
  ) as HTMLElement;

  if (thumbnail) {
    if (getComputedStyle(thumbnail).position === 'static') {
      thumbnail.style.position = 'relative';
    }

    // Add overlay with "scoring..." label
    if (!thumbnail.querySelector('.tolerance-blur-overlay')) {
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
      thumbnail.appendChild(overlay);
    }
  }
}

// Remove pending blur (after scoring reveals it's not high-engagement)
function removePendingBlur(video: YouTubeVideo): void {
  if (!video.element) return;

  video.element.classList.remove('tolerance-pending');
  video.element.classList.remove('tolerance-revealed');
  video.element.style.removeProperty('--tolerance-blur');

  // Remove overlay
  const overlay = video.element.querySelector('.tolerance-blur-overlay');
  if (overlay) overlay.remove();
}

// Apply blur effect to high-engagement videos
function applyBlurToVideo(video: YouTubeVideo, score: number, reason?: string, blurIntensity: number = 8): void {
  if (!video.element) return;

  // Remove pending state if present
  video.element.classList.remove('tolerance-pending');

  // Don't blur twice
  if (video.element.classList.contains('tolerance-blurred')) return;

  video.element.style.setProperty('--tolerance-blur', `${blurIntensity}px`);
  video.element.classList.add('tolerance-blurred');

  // Set up timed hover reveal
  setupHoverReveal(video.element);

  // Find thumbnail for overlay - try new and legacy selectors
  const thumbnail = video.element.querySelector(
    'a.yt-lockup-view-model__content-image, ' +    // New lockup model
    'yt-thumbnail-view-model, ' +                   // New thumbnail component
    '.ytThumbnailViewModelImage, ' +                // New thumbnail image container
    '#thumbnail, ' +                                // Legacy selector
    'ytd-thumbnail'                                 // Legacy component
  ) as HTMLElement;
  if (thumbnail) {
    if (getComputedStyle(thumbnail).position === 'static') {
      thumbnail.style.position = 'relative';
    }

    // Remove any existing overlay first
    const existingOverlay = thumbnail.querySelector('.tolerance-blur-overlay');
    if (existingOverlay) existingOverlay.remove();

    const overlay = document.createElement('div');
    overlay.className = 'tolerance-blur-overlay';

    // Block clicks on blurred content
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    const label = document.createElement('div');
    label.className = 'tolerance-blur-label';
    if (subscriptionsOnlyMode) {
      label.textContent = 'Not subscribed';
    } else {
      label.textContent = reason
        ? `High engagement (${Math.round(score)}): ${reason}`
        : `High engagement (${Math.round(score)})`;
    }
    label.style.maxWidth = '80%';
    label.style.textAlign = 'center';

    overlay.appendChild(label);
    thumbnail.appendChild(overlay);

    // Show onboarding tooltip on first blur (one-time)
    showOnboardingTooltip(thumbnail);
  }

  log.debug(` Blurred high-engagement video ${video.id}, score=${score}`);
}

// Current state
let currentState: AppState | null = null;
let currentSettings: Settings | null = null;

// Check if we're on a video watch page
function isWatchPage(): boolean {
  return window.location.pathname.startsWith('/watch');
}

// Check if we're on a Shorts page
function isShortsPage(): boolean {
  return window.location.pathname.startsWith('/shorts');
}

// Initialize content script
async function init(): Promise<void> {
  log.debug(' YouTube content script loaded on', window.location.href);

  // Wait for YouTube's app to load
  await waitForYouTubeApp();

  await initCore();
}

async function waitForYouTubeApp(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      // Wait for the main app element
      const app = document.querySelector('ytd-app');
      if (app) {
        resolve();
      } else {
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

  // Check if YouTube platform is enabled
  if (currentSettings.platforms?.youtube === false) {
    log.debug(' YouTube platform disabled in settings, extension inactive');
    return;
  }

  // Inject styles only if platform is enabled
  injectStyles();
  injectOnboardingStyles();

  // Show tip about disabling video previews
  showVideoPreviewTip();

  log.debug(' Mode =', currentState.mode);

  // Update hover reveal delay from settings (convert seconds to ms)
  const settingsDelay = currentSettings?.twitter?.hoverRevealDelay ?? 3;
  hoverRevealDelay = settingsDelay * 1000;
  log.debug(` Hover reveal delay = ${settingsDelay}s`);

  // Initialize quality mode from settings
  qualityModeEnabled = currentSettings.qualityMode ?? false;
  log.debug(` Quality Mode = ${qualityModeEnabled}`);

  // Initialize subscriptions-only mode from settings
  subscriptionsOnlyMode = currentSettings.subscriptionsOnly ?? false;
  log.debug(` Subscriptions Only = ${subscriptionsOnlyMode}`);

  // Ensure we have a session
  const sessionResult = await sendMessage({ type: 'ENSURE_SESSION' });
  log.debug(' Session result:', sessionResult);

  // Fetch initial blur threshold BEFORE processing videos
  await updateBlurThreshold();

  // Start heartbeat tracking
  startHeartbeat();

  // Start recovery check
  startRecoveryCheck();

  // Process initial videos (skip only shorts pages)
  if (!isShortsPage()) {
    await processVideos();
  }

  // Set up observer for infinite scroll
  setupYouTubeObserver(handleNewVideos);

  // Set up navigation observer for SPA navigation
  setupNavigationObserver(() => {
    log.debug(' Navigation detected, resetting state');
    processedVideoIds.clear();
    scoreCache.clear();
    isProcessing = false;
    pendingProcess = false;

    // Re-initialize after navigation
    setTimeout(async () => {
      log.debug(' Re-initializing after navigation, path:', window.location.pathname);

      // Re-setup observer for new DOM
      setupYouTubeObserver(handleNewVideos);

      if (!isShortsPage()) {
        await processVideos();
      }
    }, 500);
  });
}

async function handleNewVideos(): Promise<void> {
  log.debug(' New videos detected');
  await processVideos();
}

// Main processing function
async function processVideos(): Promise<void> {
  // Skip shorts pages entirely (no sidebar)
  if (isShortsPage()) {
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

    // Scrape all visible videos
    const allVideos = scrapeVisibleVideos();
    const t1 = performance.now();

    // Separate into new videos and videos needing badge re-injection
    const newVideos: YouTubeVideo[] = [];
    const videosNeedingBadge: YouTubeVideo[] = [];

    for (const video of allVideos) {
      if (!processedVideoIds.has(video.id)) {
        newVideos.push(video);
      } else {
        // Check if this processed video needs badge re-injection
        const thumbnail = video.element?.querySelector('#thumbnail, ytd-thumbnail');
        if (thumbnail && !thumbnail.querySelector('.tolerance-score-badge') && scoreCache.has(video.id)) {
          videosNeedingBadge.push(video);
        }
      }
    }

    // Re-inject badges for processed videos that lost them
    if (videosNeedingBadge.length > 0) {
      log.debug(` Re-injecting ${videosNeedingBadge.length} badges for processed videos`);
      for (const video of videosNeedingBadge) {
        const cached = scoreCache.get(video.id);
        if (cached) {
          const displayScore = cached.score.apiScore ?? cached.score.heuristicScore;
          const scoringFailed = cached.score.apiScore === undefined;
          injectScoreBadge(video, {
            score: displayScore,
            bucket: cached.score.bucket,
            reason: cached.score.apiReason,
            channel: video.channel,
            viewCount: video.viewCount,
            scoringFailed,
          });

          // Re-apply blur if needed (based on adaptive threshold)
          if (shouldBlurScore(cached.score)) {
            applyBlurToVideo(video, displayScore, cached.score.apiReason, 8);
          }
        }
      }
    }

    if (newVideos.length === 0) {
      return;
    }

    log.debug(` Processing ${newVideos.length} new videos (scrape: ${(t1 - t0).toFixed(0)}ms)`);
    lastProcessTime = Date.now();

    // Apply pending blur to all new videos immediately (blur until scored)
    if (currentSettings?.blurUntilScored !== false) {
      for (const video of newVideos) {
        applyPendingBlur(video, 8);
      }
    }

    // Get scores from background
    const serializedVideos = newVideos.map(serializeVideo);
    const t2 = performance.now();
    const scoreResult = await sendMessage({
      type: 'SCORE_VIDEOS',
      videos: serializedVideos,
    });
    const t3 = performance.now();
    log.debug(` SCORE_VIDEOS took ${(t3 - t2).toFixed(0)}ms`);

    if (!scoreResult || !('scores' in scoreResult)) {
      log.error(' Failed to get scores - videos will be retried');
      return;
    }

    // Mark as processed
    for (const video of newVideos) {
      processedVideoIds.add(video.id);
    }

    const scores = new Map<string, EngagementScore>();
    for (const score of scoreResult.scores) {
      scores.set(score.postId, score);
    }

    // Log score distribution
    const buckets = { high: 0, medium: 0, low: 0 };
    for (const score of scoreResult.scores) {
      buckets[score.bucket]++;
    }
    log.debug(` Scores - High: ${buckets.high}, Medium: ${buckets.medium}, Low: ${buckets.low}`);

    // Inject badges and handle blur based on score
    for (let i = 0; i < newVideos.length; i++) {
      const video = newVideos[i];
      const score = scores.get(video.id);

      if (score) {
        // Cache for re-injection
        scoreCache.set(video.id, { score, position: i });

        const displayScore = score.apiScore ?? score.heuristicScore;
        const scoringFailed = score.apiScore === undefined;

        // Inject badge
        injectScoreBadge(video, {
          score: displayScore,
          bucket: score.bucket,
          reason: score.apiReason,
          channel: video.channel,
          viewCount: video.viewCount,
          scoringFailed,
        });

        // Handle blur based on engagement level (uses adaptive threshold)
        if (shouldBlurScore(score)) {
          // Blur videos above threshold (threshold lowers as session progresses)
          applyBlurToVideo(video, displayScore, score.apiReason, 8);
        } else {
          // Remove blur for videos below threshold
          removePendingBlur(video);
        }
      }
    }
  } catch (error) {
    log.error(' Error processing videos:', error);
  } finally {
    // Release lock
    isProcessing = false;

    // Process pending requests
    if (pendingProcess) {
      pendingProcess = false;
      log.debug(' Processing queued videos');
      setTimeout(() => processVideos(), 50);
    }
  }
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

// Handle quality mode / subscriptions-only changes from popup
function refreshBlurState(): void {
  log.debug(` Refreshing blur state, qualityMode=${qualityModeEnabled}, subscriptionsOnly=${subscriptionsOnlyMode}`);

  // Get all videos that have been scored (have badges)
  const videoElements = document.querySelectorAll('ytd-rich-item-renderer, ytd-compact-video-renderer, yt-lockup-view-model');

  for (const element of videoElements) {
    const badge = element.querySelector('.tolerance-score-badge');
    if (!badge) continue;

    const scoreText = badge.textContent?.trim();
    const score = parseInt(scoreText || '0', 10);
    if (isNaN(score)) continue;

    // Look up cached score to check whitelisted status
    const videoId = findVideoIdFromElement(element as HTMLElement);
    const cached = videoId ? scoreCache.get(videoId) : null;
    const isWhitelisted = cached?.score?.whitelisted ?? false;

    // Determine if should blur
    let shouldBlur = false;
    if (score !== undefined && !isNaN(score)) {
      if (isWhitelisted) {
        shouldBlur = false;
      } else if (subscriptionsOnlyMode) {
        shouldBlur = true;
      } else {
        const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
        shouldBlur = score >= threshold;
      }
    }

    const isBlurred = element.classList.contains('tolerance-blurred');

    if (shouldBlur && !isBlurred) {
      // Need to blur this video
      const htmlElement = element as HTMLElement;
      htmlElement.style.setProperty('--tolerance-blur', '8px');
      htmlElement.classList.add('tolerance-blurred');

      // Set up hover reveal
      setupHoverReveal(htmlElement);

      // Find thumbnail for overlay
      const thumbnail = htmlElement.querySelector(
        'a.yt-lockup-view-model__content-image, ' +
        'yt-thumbnail-view-model, ' +
        '.ytThumbnailViewModelImage, ' +
        '#thumbnail, ' +
        'ytd-thumbnail'
      ) as HTMLElement;

      if (thumbnail) {
        if (getComputedStyle(thumbnail).position === 'static') {
          thumbnail.style.position = 'relative';
        }

        // Remove any existing overlay first
        const existingOverlay = thumbnail.querySelector('.tolerance-blur-overlay');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.className = 'tolerance-blur-overlay';
        overlay.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });

        const label = document.createElement('div');
        label.className = 'tolerance-blur-label';
        label.textContent = subscriptionsOnlyMode
          ? 'Not subscribed'
          : `High engagement content (${score})`;
        label.style.maxWidth = '80%';
        label.style.textAlign = 'center';

        overlay.appendChild(label);
        thumbnail.appendChild(overlay);
      }
    } else if (!shouldBlur && isBlurred) {
      // Need to unblur this video
      element.classList.remove('tolerance-blurred');
      element.classList.remove('tolerance-revealed');
      (element as HTMLElement).style.removeProperty('--tolerance-blur');

      // Remove overlay
      const overlay = element.querySelector('.tolerance-blur-overlay');
      if (overlay) overlay.remove();
    }
  }
}

// Find video ID from a video element (for looking up cached scores)
function findVideoIdFromElement(element: HTMLElement): string | null {
  // Try to find a link to the video
  const link = element.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') as HTMLAnchorElement | null;
  if (link) {
    const href = link.getAttribute('href') || '';
    const watchMatch = href.match(/[?&]v=([^&]+)/);
    if (watchMatch) return watchMatch[1];
    const shortsMatch = href.match(/\/shorts\/([^?&]+)/);
    if (shortsMatch) return shortsMatch[1];
  }
  return null;
}

// Track right-clicked element for context menu
let lastRightClickedElement: HTMLElement | null = null;

document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as HTMLElement;
});

// Extract channel name from a video element
function extractChannelFromElement(element: HTMLElement | null): string | null {
  if (!element) return null;

  // Walk up to find the video container
  const videoContainer = element.closest(
    'ytd-rich-item-renderer, ' +
    'ytd-compact-video-renderer, ' +
    'yt-lockup-view-model'
  );
  if (!videoContainer) return null;

  // Prefer extracting @handle from href for consistent matching with scraper
  const channelAnchor = videoContainer.querySelector('a[href^="/@"]') as HTMLAnchorElement | null;
  if (channelAnchor) {
    const href = channelAnchor.getAttribute('href');
    if (href) {
      const match = href.match(/^\/@([^/?]+)/);
      if (match) return match[1];
    }
  }

  // Fallback to text content from channel name elements
  const channelLink = videoContainer.querySelector(
    'a[href^="/@"] yt-formatted-string, ' +
    'ytd-channel-name a, ' +
    'a.yt-formatted-string[href^="/@"], ' +
    '.ytd-channel-name yt-formatted-string'
  ) as HTMLElement | null;

  if (channelLink) {
    const text = channelLink.textContent?.trim();
    if (text) return text;
  }

  return null;
}

// Listen for quality mode changes and context menu queries from popup/background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'QUALITY_MODE_CHANGED') {
    qualityModeEnabled = message.enabled;
    log.debug(` Quality mode ${qualityModeEnabled ? 'enabled' : 'disabled'}`);
    refreshBlurState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SUBSCRIPTIONS_ONLY_CHANGED') {
    subscriptionsOnlyMode = message.enabled;
    log.debug(` Subscriptions-only mode ${subscriptionsOnlyMode ? 'enabled' : 'disabled'}`);
    refreshBlurState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'FETCH_IMAGE_BASE64') {
    // Fetch image, resize to 512px, and convert to base64
    fetchImageAsBase64(message.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_CLICKED_AUTHOR') {
    // Return channel from the right-clicked element
    const channel = extractChannelFromElement(lastRightClickedElement);
    if (channel) {
      sendResponse({ sourceId: channel, platform: 'youtube' });
    } else {
      sendResponse({ sourceId: null, platform: null });
    }
    return false;
  }

  if (message.type === 'AUTHOR_WHITELISTED') {
    // Optional: show visual feedback that channel was whitelisted
    log.info(`Channel ${message.sourceId} added to whitelist`);
    return false;
  }

  return true;
});

// Fetch image, resize to max 512px, and convert to base64 (reduces token cost)
async function fetchImageAsBase64(url: string): Promise<string> {
  const MAX_SIZE = 512;

  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  const img = await createImageBitmap(blob);

  // Calculate scaled dimensions (max 512px, preserve aspect ratio)
  let width = img.width;
  let height = img.height;

  if (width > MAX_SIZE || height > MAX_SIZE) {
    if (width > height) {
      height = Math.round((height / width) * MAX_SIZE);
      width = MAX_SIZE;
    } else {
      width = Math.round((width / height) * MAX_SIZE);
      height = MAX_SIZE;
    }
  }

  // Draw to canvas at reduced size
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(img, 0, 0, width, height);

  // Convert to blob then base64
  const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      log.debug(` Image resized ${img.width}x${img.height} -> ${width}x${height}`);
      resolve(result);
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(resizedBlob);
  });
}

// Keep currentSettings in sync when changed from dashboard
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) {
    currentSettings = changes.settings.newValue;
  }
});

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
