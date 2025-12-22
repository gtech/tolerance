import { RedditPost, EngagementScore, AppState, Settings, PostImpression } from '../shared/types';
import { log, setLogLevel } from '../shared/constants';
import { scrapeVisiblePosts, serializePost } from './scraper';
import { scrapeNewRedditPosts, serializeNewRedditPost } from './scraper-new';
import { reorderPosts, recordImpressions } from './reorder';
import { setupObserver, setupRESObserver } from './observer';
import { setupNewRedditObserver } from './observer-new';
import { injectReminderCard, CardData } from './reminderCard';

// Track which Reddit version we're on
let redditVersion: 'old' | 'new' | null = null;

// Track processed posts to avoid re-processing
const processedPostIds = new Set<string>();

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

function sendHeartbeat(): void {
  chrome.runtime.sendMessage({ type: 'SOCIAL_MEDIA_HEARTBEAT' }, () => {
    // Ignore errors (extension might be updating)
    if (chrome.runtime.lastError) {
      // Silent fail
    }
  });
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return; // Already running

  // Send immediately
  sendHeartbeat();

  // Then every 30 seconds
  heartbeatIntervalId = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // Also send when tab becomes visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
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

    /* Score badges - positioned left of subreddit icon */
    .tolerance-score-badge {
      position: absolute !important;
      top: 8px !important;
      left: 8px !important;
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
      display: block !important;
    }
    .tolerance-score-badge.high { background: #e74c3c !important; }
    .tolerance-score-badge.medium { background: #f39c12 !important; }
    .tolerance-score-badge.low { background: #27ae60 !important; }

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
  badge.className = `tolerance-score-badge ${info.bucket}`;
  badge.textContent = String(Math.round(info.score));

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

  badge.appendChild(tooltip);
  element.appendChild(badge);
  log.debug(` Badge injected for post ${post.id}, score=${info.score}, bucket=${info.bucket}`);
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

// Main processing function
async function processPosts(): Promise<void> {
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

  // Show loading indicator (but not on comments pages)
  const showLoader = !isCommentsPage();
  if (showLoader) {
    showLoading();
  }

  try {
    log.debug(` Processing ${newPosts.length} new posts (scrape: ${(t1 - t0).toFixed(0)}ms)`);

    // Mark as processed
    for (const post of newPosts) {
      processedPostIds.add(post.id);
    }

    // Get scores from background
    const serializedPosts = redditVersion === 'new'
      ? newPosts.map(serializeNewRedditPost)
      : newPosts.map(serializePost);
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

    // Inject badges with full info (reason + positions)
    for (const impression of impressions) {
      const post = postMap.get(impression.postId);
      const score = scores.get(impression.postId);
      if (post && score) {
        const displayScore = score.apiScore ?? score.heuristicScore;
        // Debug: log reason availability
        if (score.apiReason) {
          log.debug(` Post ${post.id} has apiReason: "${score.apiReason}"`);
        } else {
          log.debug(` Post ${post.id} has NO apiReason, apiScore=${score.apiScore}`);
        }
        injectScoreBadge(post, {
          score: displayScore,
          bucket: score.bucket,
          reason: score.apiReason,
          originalPosition: impression.originalPosition,
          newPosition: impression.position,
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
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Tolerance: Message error:', chrome.runtime.lastError);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
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
});

// Fetch image and convert to base64
async function fetchImageAsBase64(url: string): Promise<string> {
  // Transform preview.redd.it URLs to i.redd.it (often more accessible)
  let fetchUrl = url;
  if (url.includes('preview.redd.it')) {
    // Extract the image ID and extension from preview URL
    const match = url.match(/preview\.redd\.it\/([^?]+)/);
    if (match) {
      fetchUrl = `https://i.redd.it/${match[1]}`;
      log.debug(` Transformed URL from preview to i.redd.it: ${fetchUrl}`);
    }
  }

  // Try loading via img element and canvas
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const timeout = setTimeout(() => {
      reject(new Error('Image load timeout'));
    }, 10000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        // Limit size to reduce memory/bandwidth
        const maxDim = 1024;
        let width = img.naturalWidth;
        let height = img.naturalHeight;

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
          reject(new Error('Could not get canvas context'));
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        log.debug(` Image converted successfully: ${width}x${height}, ${dataUrl.length} chars`);
        resolve(dataUrl);
      } catch (e) {
        reject(new Error(`Canvas export failed: ${e}`));
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Image load failed'));
    };

    img.src = fetchUrl;
  });
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
