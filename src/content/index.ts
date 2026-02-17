import { RedditPost, EngagementScore, AppState, Settings, PostImpression } from '../shared/types';
import { log, setLogLevel } from '../shared/constants';
import { scrapeVisiblePosts, serializePost } from './scraper';
import { scrapeNewRedditPosts, serializeNewRedditPost } from './scraper-new';
import { reorderPosts, recordImpressions } from './reorder';
import { setupObserver, setupRESObserver } from './observer';
import { setupNewRedditObserver } from './observer-new';
import { injectReminderCard, CardData } from './reminderCard';
import { injectOnboardingStyles, showOnboardingTooltip } from './onboarding';

// Track which Reddit version we're on
let redditVersion: 'old' | 'new' | null = null;

// Track processed posts to avoid re-processing
const processedPostIds = new Set<string>();

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Adaptive blur threshold (score at or above this gets blurred)
let currentBlurThreshold = 55; // Default for 'normal' phase
let currentPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal' = 'normal';

// Quality Mode - instant aggressive blur (scores > 20)
let qualityModeEnabled = false;
const QUALITY_MODE_THRESHOLD = 21;

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

  chrome.runtime.sendMessage({ type: 'SOCIAL_MEDIA_HEARTBEAT' }, () => {
    // Ignore errors (extension might be updating)
    if (chrome.runtime.lastError) {
      // Silent fail
    }
  });
}

async function updateBlurThreshold(): Promise<void> {
  if (!isExtensionValid()) return;

  try {
    const response = await sendMessage({ type: 'GET_GLOBAL_SESSION' });
    if (response && 'phase' in response) {
      const newPhase = response.phase as typeof currentPhase;
      const settings = response.settings as { progressiveBoredomEnabled?: boolean };

      // Get effective threshold for this phase
      const thresholdResult = await sendMessage({
        type: 'GET_EFFECTIVE_BLUR_THRESHOLD',
        phase: newPhase,
      });

      if (thresholdResult && 'threshold' in thresholdResult) {
        const newThreshold = thresholdResult.threshold as number;
        if (newThreshold !== currentBlurThreshold || newPhase !== currentPhase) {
          log.debug(` Reddit: Blur threshold updated - phase: ${newPhase}, threshold: ${newThreshold}`);
          currentBlurThreshold = newThreshold;
          currentPhase = newPhase;
        }
      }
    }
  } catch (err) {
    // Ignore errors
  }
}

function shouldBlurScore(score: EngagementScore): boolean {
  // Don't blur if scoring failed (no API score when API is expected)
  if (score.apiScore === undefined) return false;

  // Whitelisted sources bypass blur
  if (score.whitelisted) return false;

  const displayScore = score.apiScore;
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return; // Already running

  // Send immediately
  sendHeartbeat();
  updateBlurThreshold();

  // Then every 30 seconds
  heartbeatIntervalId = setInterval(() => {
    sendHeartbeat();
    updateBlurThreshold();
  }, HEARTBEAT_INTERVAL);

  // Also send when tab becomes visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
      updateBlurThreshold();
    }
  });

  log.debug(' Heartbeat tracking started');
}

// Loading indicator state
let loadingStylesInjected = false;

function injectLoadingStyles(): void {
  if (loadingStylesInjected) return;
  loadingStylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
    /* Blur/fade effect on posts during loading - Old Reddit */
    #siteTable.tolerance-loading .thing {
      filter: blur(2px);
      opacity: 0.5;
      transition: filter 0.2s ease, opacity 0.2s ease;
      pointer-events: none;
    }

    #siteTable .thing {
      transition: filter 0.2s ease, opacity 0.2s ease;
    }

    /* Blur/fade effect on posts during loading - New Reddit */
    shreddit-feed.tolerance-loading shreddit-post {
      filter: blur(2px);
      opacity: 0.5;
      transition: filter 0.2s ease, opacity 0.2s ease;
      pointer-events: none;
    }

    shreddit-post {
      transition: filter 0.2s ease, opacity 0.2s ease;
      position: relative;
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
      border: 3px solid rgba(125, 206, 160, 0.3);
      border-top-color: #7dcea0;
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

    /* Score badges - base styles */
    .tolerance-score-badge {
      position: absolute !important;
      padding: 2px 6px !important;
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
      display: inline-block !important;
      width: auto !important;
      height: auto !important;
      min-width: 0 !important;
      max-width: none !important;
      line-height: 1.2 !important;
    }
    .tolerance-score-badge.high { background: #e74c3c !important; }
    .tolerance-score-badge.medium { background: #f39c12 !important; }
    .tolerance-score-badge.low { background: #27ae60 !important; }
    .tolerance-score-badge.failed { background: #7f8c8d !important; color: #fff !important; }

    /* Old Reddit badges - below post rank on left */
    .thing .tolerance-score-badge {
      top: 37px !important;
      left: 0 !important;
    }

    /* New Reddit badges - left of subreddit icon */
    shreddit-post .tolerance-score-badge {
      top: 8px !important;
      left: -12px !important;
    }

    /* Badge tooltip - appears to the right */
    .tolerance-score-badge .tolerance-tooltip {
      visibility: hidden;
      opacity: 0;
      position: absolute;
      top: 50%;
      left: 100%;
      transform: translateY(-50%);
      margin-left: 8px;
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
      align-items: center !important;
      justify-content: center !important;
      background: rgba(0, 0, 0, 0.1) !important;
    }

    .tolerance-blur-overlay::after {
      content: 'Hover 3s to reveal';
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      font-weight: 500;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      padding: 8px 16px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .tolerance-blur-overlay.revealing::after {
      content: 'Revealing...';
    }

    .tolerance-blur-overlay.revealed {
      opacity: 0;
      pointer-events: none;
    }

    /* Pending blur (before scoring completes) */
    .thing.tolerance-pending,
    shreddit-post.tolerance-pending {
      position: relative;
    }

    .tolerance-pending .tolerance-blur-overlay::after {
      content: 'Scoring...';
    }

    /* Hide score badge while pending */
    .tolerance-pending .tolerance-score-badge {
      display: none !important;
    }

    /* Blurred state */
    .thing.tolerance-blurred,
    shreddit-post.tolerance-blurred {
      position: relative;
    }
  `;
  document.head.appendChild(style);
}

// Badge info for injection
interface BadgeInfo {
  score: number;
  bucket: string;
  reason?: string;
  originalPosition: number;
  newPosition: number;
  scoringFailed?: boolean;
}

// Inject score badge on a Reddit post
function injectScoreBadge(post: RedditPost, info: BadgeInfo): void {
  const element = post.element;
  if (!element) {
    log.debug(` Badge injection failed - no element for post ${post.id}`);
    return;
  }

  // Don't add duplicate badges
  if (element.querySelector('.tolerance-score-badge')) {
    log.debug(` Badge already exists for post ${post.id}`);
    return;
  }

  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${info.scoringFailed ? 'failed' : info.bucket}`;
  badge.textContent = info.scoringFailed ? '?' : String(Math.round(info.score));

  // Handle different DOM structures for old vs new Reddit
  if (element.tagName === 'SHREDDIT-POST') {
    // New Reddit: shreddit-post already has position:relative from our CSS
    // Badge positioning handled by CSS
  } else {
    // Old Reddit: ensure element has position for absolute positioning
    if (getComputedStyle(element).position === 'static') {
      element.style.position = 'relative';
    }
  }

  // Build tooltip content
  const tooltip = document.createElement('div');
  tooltip.className = 'tolerance-tooltip';

  // Reason
  if (info.scoringFailed) {
    const reasonDiv = document.createElement('div');
    reasonDiv.className = 'tolerance-tooltip-reason';
    const isOwnKey = currentSettings?.apiTier === 'own-key';
    reasonDiv.textContent = isOwnKey
      ? 'Error receiving score.'
      : 'Free tier exhausted. Click to upgrade to Pro. Or add your own API key in the dashboard.';
    tooltip.appendChild(reasonDiv);

    // Make badge clickable and open account page
    badge.style.cursor = 'pointer';
    badge.style.pointerEvents = 'auto';
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

  badge.appendChild(tooltip);
  element.appendChild(badge);
  log.debug(` Badge injected for post ${post.id}, score=${info.score}, bucket=${info.bucket}`);
}

// Apply pending blur (before scoring) to a post
function applyPendingBlur(post: RedditPost): void {
  const element = post.element;
  if (!element) return;

  // Safety check: make sure element is attached to DOM
  // Note: Don't check offsetParent - it can be null for web components like shreddit-post
  if (!element.isConnected) return;

  // Don't blur if already blurred or pending
  if (element.classList.contains('tolerance-blurred') ||
      element.classList.contains('tolerance-pending')) return;

  try {
    element.classList.add('tolerance-pending');

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
  } catch (err) {
    log.debug(` Failed to apply pending blur: ${err}`);
  }
}

// Remove pending blur (after scoring reveals it's not high-engagement)
function removePendingBlur(post: RedditPost): void {
  const element = post.element;
  if (!element) return;

  element.classList.remove('tolerance-pending');

  // Remove overlay if post doesn't need blur
  const overlay = element.querySelector('.tolerance-blur-overlay');
  if (overlay) overlay.remove();
}

// Apply blur to high-engagement content with hover reveal
function applyBlur(post: RedditPost): void {
  const element = post.element;
  if (!element) return;

  // Mark as blurred
  element.classList.add('tolerance-blurred');
  element.classList.remove('tolerance-pending');

  // Check if overlay already exists (from pending state)
  let overlay = element.querySelector('.tolerance-blur-overlay') as HTMLElement;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'tolerance-blur-overlay';
    element.appendChild(overlay);
  }

  // Remove the "Scoring..." label by removing pending class effect
  overlay.classList.remove('revealing', 'revealed');

  // Add hover reveal functionality
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let isRevealed = false;

  overlay.addEventListener('mouseenter', () => {
    if (isRevealed) return;
    overlay.classList.add('revealing');

    revealTimer = setTimeout(() => {
      overlay.classList.remove('revealing');
      overlay.classList.add('revealed');
      isRevealed = true;
    }, 3000); // 3 seconds to reveal
  });

  overlay.addEventListener('mouseleave', () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
    if (!isRevealed) {
      overlay.classList.remove('revealing');
    }
  });

  // Block clicks on blurred content
  overlay.addEventListener('click', (e) => {
    if (!isRevealed) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // Show onboarding tooltip on first blur (one-time)
  showOnboardingTooltip(element);
}

function createLoaderElement(): HTMLElement {
  let loader = document.querySelector('.tolerance-loader') as HTMLElement;
  if (loader) return loader;

  loader = document.createElement('div');
  loader.className = 'tolerance-loader';
  loader.innerHTML = `
    <div class="tolerance-loader-spinner"></div>
    <div class="tolerance-loader-text">Analyzing posts...</div>
  `;
  document.body.appendChild(loader);
  return loader;
}

function showLoading(): void {
  injectLoadingStyles();
  // Add loading class to appropriate container based on Reddit version
  const container = redditVersion === 'new'
    ? document.querySelector('shreddit-feed')
    : document.querySelector('#siteTable');
  if (container) {
    container.classList.add('tolerance-loading');
  }
  const loader = createLoaderElement();
  loader.classList.add('visible');
}

function hideLoading(): void {
  // Remove loading class from appropriate container
  const container = redditVersion === 'new'
    ? document.querySelector('shreddit-feed')
    : document.querySelector('#siteTable');
  if (container) {
    container.classList.remove('tolerance-loading');
  }
  const loader = document.querySelector('.tolerance-loader');
  if (loader) {
    loader.classList.remove('visible');
  }
}

// Current state
let currentState: AppState | null = null;
let currentSettings: Settings | null = null;

// Check if we're on old Reddit (has the siteTable element)
function isOldReddit(): boolean {
  return document.querySelector('#siteTable') !== null;
}

// Check if we're on new Reddit (uses shreddit-* custom elements)
function isNewReddit(): boolean {
  return document.querySelector('shreddit-feed') !== null ||
         document.querySelector('shreddit-post') !== null;
}

// Check if we're on a comments page (not the main feed)
function isCommentsPage(): boolean {
  return window.location.pathname.includes('/comments/');
}

// Initialize content script
async function init(): Promise<void> {
  log.debug(' Content script loaded on', window.location.href);

  // Detect Reddit version
  if (isOldReddit()) {
    redditVersion = 'old';
    log.debug(' Old Reddit detected');
    await initOldReddit();
  } else if (isNewReddit()) {
    redditVersion = 'new';
    log.debug(' New Reddit detected');
    await initNewReddit();
  } else {
    // Page might still be loading, wait and try again
    log.debug(' Reddit version not detected, waiting for DOM...');
    setTimeout(() => {
      if (isOldReddit()) {
        redditVersion = 'old';
        log.debug(' Old Reddit detected (delayed)');
        initOldReddit();
      } else if (isNewReddit()) {
        redditVersion = 'new';
        log.debug(' New Reddit detected (delayed)');
        initNewReddit();
      } else {
        log.debug(' Could not detect Reddit version, extension inactive');
      }
    }, 1000);
  }
}

// Initialize for old Reddit
async function initOldReddit(): Promise<void> {
  await initCore();
  setupObserver(handleNewPosts);
  setupRESObserver(handleNewPosts);
}

// Initialize for new Reddit
async function initNewReddit(): Promise<void> {
  await initCore();
  setupNewRedditObserver(handleNewPosts, () => {
    // Clear processed posts on navigation so new page's posts get analyzed
    log.debug(' Clearing processed posts for new Reddit navigation');
    processedPostIds.clear();
  });
}

async function initCore(): Promise<void> {
  // Inject onboarding tooltip styles
  injectOnboardingStyles();

  // Get initial state from background
  const stateResult = await sendMessage({ type: 'GET_STATE' });
  if (stateResult && 'state' in stateResult) {
    currentState = stateResult.state;
    currentSettings = stateResult.settings;

    // Initialize log level from settings
    if (currentSettings.logLevel) {
      setLogLevel(currentSettings.logLevel);
    }

    // Check if Reddit platform is enabled
    if (currentSettings.platforms?.reddit === false) {
      log.debug(' Reddit platform disabled in settings, extension inactive');
      return;
    }

    log.debug(' Mode =', currentState.mode);

    if (currentState.mode === 'baseline') {
      const daysRemaining = calculateBaselineDaysRemaining();
      log.debug(` Baseline mode - ${daysRemaining.toFixed(1)} days remaining`);
    }
  }

  // Ensure we have a session
  const sessionResult = await sendMessage({ type: 'ENSURE_SESSION' });
  log.debug(' Session result:', sessionResult);

  // Fetch initial blur threshold BEFORE processing posts
  await updateBlurThreshold();

  // Start heartbeat tracking for progressive boredom
  startHeartbeat();

  // Process initial posts
  await processPosts();
}

function calculateBaselineDaysRemaining(): number {
  if (!currentState) return 7;
  const msElapsed = Date.now() - currentState.baselineStartDate;
  const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
  return Math.max(0, currentState.baselineDurationDays - daysElapsed);
}

// Handle new posts from infinite scroll
async function handleNewPosts(): Promise<void> {
  log.debug(' New posts detected');
  await processPosts();
}

// Extract base64 from DOM images that are already loaded (no fetch needed)
// This works because Reddit images are displayed on the page - we just grab them from DOM
function extractImagesFromDOM(posts: RedditPost[]): Omit<RedditPost, 'element'>[] {
  return posts.map(post => {
    const { element, ...serialized } = post;

    if (!element) {
      return serialized;
    }

    try {
      // For image posts: extract main image
      if (post.mediaType === 'image' && !serialized.imageUrl?.startsWith('data:')) {
        const imgEl = element.querySelector('[slot="post-media-container"] img, shreddit-post-image img') as HTMLImageElement | null;
        if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
          const base64 = imageElementToBase64(imgEl);
          if (base64) {
            serialized.imageUrl = base64;
            log.debug(` Extracted image from DOM for post ${post.id}`);
          }
        }
      }

      // For video/gif posts: extract thumbnail
      if ((post.mediaType === 'video' || post.mediaType === 'gif') && !serialized.thumbnailUrl?.startsWith('data:')) {
        const thumbEl = element.querySelector('[slot="thumbnail"] img, shreddit-post-thumbnail img, video[poster]') as HTMLImageElement | HTMLVideoElement | null;
        if (thumbEl) {
          if (thumbEl instanceof HTMLImageElement && thumbEl.complete && thumbEl.naturalWidth > 0) {
            const base64 = imageElementToBase64(thumbEl);
            if (base64) {
              serialized.thumbnailUrl = base64;
              log.debug(` Extracted video thumbnail from DOM for post ${post.id}`);
            }
          } else if (thumbEl instanceof HTMLVideoElement && thumbEl.poster) {
            // Video has poster attribute - try to load it
            const posterImg = new Image();
            posterImg.src = thumbEl.poster;
            if (posterImg.complete && posterImg.naturalWidth > 0) {
              const base64 = imageElementToBase64(posterImg);
              if (base64) {
                serialized.thumbnailUrl = base64;
                log.debug(` Extracted video poster from DOM for post ${post.id}`);
              }
            }
          }
        }
      }

      // Also try thumbnail slot for any post type as fallback
      if (!serialized.imageUrl?.startsWith('data:') && !serialized.thumbnailUrl?.startsWith('data:')) {
        const fallbackThumb = element.querySelector('[slot="thumbnail"] img') as HTMLImageElement | null;
        if (fallbackThumb && fallbackThumb.complete && fallbackThumb.naturalWidth > 0) {
          const base64 = imageElementToBase64(fallbackThumb);
          if (base64) {
            if (post.mediaType === 'image' || post.mediaType === 'gallery') {
              serialized.imageUrl = base64;
            } else {
              serialized.thumbnailUrl = base64;
            }
            log.debug(` Extracted fallback thumbnail from DOM for post ${post.id}`);
          }
        }
      }
    } catch (err) {
      log.debug(` Failed to extract image from DOM: ${err}`);
    }

    return serialized;
  });
}

// Convert an already-loaded img element to base64 (no network request)
function imageElementToBase64(img: HTMLImageElement): string | null {
  try {
    // Limit size to reduce memory/bandwidth
    const maxDim = 1024;
    let width = img.naturalWidth;
    let height = img.naturalHeight;

    if (width === 0 || height === 0) {
      return null;
    }

    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    // Canvas tainted by cross-origin image - expected for Reddit images
    // The fetchImageAsBase64 path will be used instead via background script
    return null;
  }
}

// Main processing function
async function processPosts(): Promise<void> {
  if (!isExtensionValid()) return;

  const t0 = performance.now();

  // Scrape all visible posts using appropriate scraper
  const allPosts = redditVersion === 'new'
    ? scrapeNewRedditPosts()
    : scrapeVisiblePosts();
  const t1 = performance.now();

  // Filter to only new posts we haven't processed
  const newPosts = allPosts.filter(p => !processedPostIds.has(p.id));

  if (newPosts.length === 0) {
    return;
  }

  // Show loading indicator (but not on comments pages, and not if blurUntilScored is off)
  const showLoader = !isCommentsPage() && currentSettings?.blurUntilScored !== false;
  if (showLoader) {
    showLoading();
  }

  try {
    log.debug(` Processing ${newPosts.length} new posts (scrape: ${(t1 - t0).toFixed(0)}ms)`);

    // Mark as processed
    for (const post of newPosts) {
      processedPostIds.add(post.id);
    }

    // Apply pending blur synchronously (if blurUntilScored is enabled)
    // Note: We used to delay for new Reddit, but this caused race conditions
    // where scoring completed before blur was applied, leaving permanent "Scoring..." overlay
    if (currentSettings?.blurUntilScored !== false) {
      for (const post of newPosts) {
        applyPendingBlur(post);
      }
    }

    // Serialize posts - for new Reddit, extract images directly from DOM
    // (Reddit blocks fetching image URLs, but we can grab already-loaded images)
    const serializedPosts = redditVersion === 'new'
      ? extractImagesFromDOM(newPosts)
      : newPosts.map(serializePost);

    // Get scores from background
    const t2 = performance.now();
    const scoreResult = await sendMessage({
      type: 'SCORE_POSTS',
      posts: serializedPosts,
    });
    const t3 = performance.now();
    log.debug(` SCORE_POSTS took ${(t3 - t2).toFixed(0)}ms`);

    if (!scoreResult || !('scores' in scoreResult)) {
      console.error('Tolerance: Failed to get scores');
      return;
    }

    const scores = new Map<string, EngagementScore>();
    for (const score of scoreResult.scores) {
      scores.set(score.postId, score);
    }

    // Create post map for badge injection after reordering
    const postMap = new Map(newPosts.map(p => [p.id, p]));

    // Ensure badge CSS is loaded
    injectLoadingStyles();

    // Log score distribution
    logScoreDistribution(scoreResult.scores);

    let impressions: PostImpression[];

    log.debug(` Current mode = ${currentState?.mode}, redditVersion = ${redditVersion}`);

    if (currentState?.mode === 'baseline') {
      // Baseline mode: just record, don't reorder
      log.debug(' Baseline mode - skipping reorder');
      impressions = recordImpressions(newPosts, scores);
    } else if (redditVersion === 'new') {
      // New Reddit: skip reordering (SPA architecture makes it complex)
      // Just record impressions and show badges
      log.debug(' New Reddit - skipping reorder, badges only');
      impressions = recordImpressions(newPosts, scores);
    } else {
      // Active mode: reorder according to fixed interval schedule
      const orderResult = await sendMessage({
        type: 'GET_SCHEDULER_ORDER',
        postIds: newPosts.map(p => p.id),
        scores: scoreResult.scores,
      });

      if (orderResult && 'orderedIds' in orderResult) {
        const orderedIds = orderResult.orderedIds as string[];
        const hiddenIds = (orderResult.hiddenIds as string[]) || [];

        log.debug(` Scheduler returned order (first 10): ${orderedIds.slice(0, 10).map(id => {
          const s = scores.get(id);
          return s?.apiScore ?? s?.heuristicScore ?? '?';
        }).join(', ')}`);

        if (hiddenIds.length > 0) {
          log.debug(` Hiding ${hiddenIds.length} posts: ${hiddenIds.slice(0, 5).join(', ')}${hiddenIds.length > 5 ? '...' : ''}`);
        }

        impressions = reorderPosts(newPosts, scores, orderedIds, hiddenIds);
        log.debug(` Reordered ${impressions.filter(i => i.wasReordered).length} posts, hidden ${hiddenIds.length}`);
      } else {
        log.debug(' No order result from scheduler');
        impressions = recordImpressions(newPosts, scores);
      }
    }

    // Inject badges and apply/remove blur based on scores
    for (const impression of impressions) {
      const post = postMap.get(impression.postId);
      const score = scores.get(impression.postId);
      if (post && score) {
        const displayScore = score.apiScore;
        const scoringFailed = score.apiScore === undefined;

        // Apply or remove blur based on score
        if (shouldBlurScore(score)) {
          applyBlur(post);
          log.debug(` Post ${post.id} blurred (score: ${displayScore}, threshold: ${currentBlurThreshold})`);
        } else {
          removePendingBlur(post);
        }

        // Inject badge
        injectScoreBadge(post, {
          score: displayScore,
          bucket: score.bucket,
          reason: score.apiReason,
          originalPosition: impression.originalPosition,
          newPosition: impression.position,
          scoringFailed,
        });
      }
    }

    // Log impressions to storage
    await sendMessage({
      type: 'LOG_IMPRESSIONS',
      impressions,
    });

    // Inject/update reminder card
    await injectProductivityCard();
  } finally {
    // Always hide loading indicator (if it was shown)
    if (showLoader) {
      hideLoading();
    }
  }
}

// Fetch card data and inject the productivity reminder card
async function injectProductivityCard(): Promise<void> {
  try {
    const result = await sendMessage({ type: 'GET_CARD_DATA' }) as {
      type: string;
      productivity: CardData['productivity'];
      settings: CardData['settings'];
      state: CardData['state'];
      highEngagementToday: number;
    } | null;

    if (result && result.type === 'CARD_DATA_RESULT') {
      // Only show productivity card if enabled in settings
      if (!result.settings.productivityCardEnabled) {
        return;
      }

      const cardData: CardData = {
        productivity: result.productivity,
        settings: result.settings,
        state: result.state,
        highEngagementToday: result.highEngagementToday,
      };

      injectReminderCard(cardData);
    }
  } catch (error) {
    console.error('Tolerance: Failed to inject productivity card:', error);
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
    return null;
  }

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          // Silent fail - extension might be reloading
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch {
      // Extension context invalidated
      resolve(null);
    }
  });
}

// Track right-clicked element for context menu
let lastRightClickedElement: HTMLElement | null = null;

document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as HTMLElement;
});

// Extract author from a Reddit post element
function extractAuthorFromElement(element: HTMLElement | null): string | null {
  if (!element) return null;

  // Walk up to find the post container
  const postElement = element.closest('.thing, shreddit-post');
  if (!postElement) return null;

  // New Reddit: shreddit-post has author attribute
  if (postElement.tagName === 'SHREDDIT-POST') {
    const author = postElement.getAttribute('author');
    if (author) return author;
  }

  // Old Reddit: find .author link
  const authorLink = postElement.querySelector('.author') as HTMLAnchorElement | null;
  if (authorLink) {
    // Extract username from href or text
    const text = authorLink.textContent?.trim();
    if (text) return text;
  }

  return null;
}

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_IMAGE_BASE64') {
    // Fetch image and convert to base64 (content script can bypass CORS)
    fetchImageAsBase64(message.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_CLICKED_AUTHOR') {
    // Return author from the right-clicked element
    const author = extractAuthorFromElement(lastRightClickedElement);
    if (author) {
      sendResponse({ sourceId: `u/${author}`, platform: 'reddit' });
    } else {
      sendResponse({ sourceId: null, platform: null });
    }
    return false;
  }

  if (message.type === 'AUTHOR_WHITELISTED') {
    log.info(`Author ${message.sourceId} added to whitelist`);
    // sourceId is "u/username", strip the "u/" prefix
    const username = message.sourceId?.replace(/^u\//, '') || '';
    // Find all blurred posts by this author and unblur them
    const blurredPosts = document.querySelectorAll('.tolerance-blurred');
    for (const post of blurredPosts) {
      let postAuthor: string | null = null;
      if (post.tagName === 'SHREDDIT-POST') {
        postAuthor = post.getAttribute('author');
      } else {
        const authorLink = post.querySelector('.author') as HTMLElement | null;
        postAuthor = authorLink?.textContent?.trim() || null;
      }
      if (postAuthor === username) {
        post.classList.remove('tolerance-blurred');
        const overlay = post.querySelector('.tolerance-blur-overlay');
        if (overlay) overlay.remove();
      }
    }
    sendResponse({ success: true });
    return true;
  }
});

// Fetch image, resize to max 512px, and convert to base64
// Resizing reduces token cost from ~2000 to ~200-400 tokens
// Note: This often fails with 403 for Reddit images - galleries fall back to text-only scoring
async function fetchImageAsBase64(url: string): Promise<string> {
  const MAX_SIZE = 512;

  try {
    const response = await fetch(url, {
      credentials: 'omit',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const blob = await response.blob();

    // Load image to get dimensions
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
    if (!ctx) {
      throw new Error('Could not get canvas context');
    }
    ctx.drawImage(img, 0, 0, width, height);

    // Convert to blob then base64
    const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        log.debug(` Image resized ${img.width}x${img.height} -> ${width}x${height}, ${result.length} chars`);
        resolve(result);
      };
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(resizedBlob);
    });
  } catch (fetchError) {
    // For Reddit images, fetch often fails with 403
    // This is expected - galleries will fall back to text-only scoring
    throw new Error(`Fetch failed: ${fetchError}`);
  }
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
