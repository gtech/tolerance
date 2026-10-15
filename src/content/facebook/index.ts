import { FacebookPost, EngagementScore, AppState, Settings, isTrustedExempt, pendingBlurTimeoutMs } from '../../shared/types';
import { log, setLogLevel } from '../../shared/constants';
import { scrapeVisiblePosts, serializePost, POST_ROOT_SELECTOR } from './scraper';
import { setupFacebookObserver, setupNavigationObserver, isValidFeedPage, disconnectObserver } from './observer';
import { FB_POST_ID_ATTR, FB_DONE_ATTR, fbGateCss } from './gate';
import { showFreeTierExhaustedDialog } from '../freeTierDialog';
import { heartbeatMessage, handleHeartbeatResponse } from '../grounding';

// Track processed posts to avoid re-processing
const processedPostIds = new Set<string>();

// Cache scores for badge re-injection when Facebook recreates DOM elements
const scoreCache = new Map<string, { score: EngagementScore; author: string }>();

// Processing lock to prevent concurrent processPosts calls
let isProcessing = false;
let pendingProcess = false;
let processingStartTime = 0;
const MAX_PROCESSING_TIME = 15000; // 15 second timeout

// Heartbeat tracking for progressive boredom
const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

// Adaptive blur threshold (score at or above this gets blurred)
let currentBlurThreshold = 55; // Default for 'normal' phase
let currentPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal' = 'normal';

// Quality Mode
let qualityModeEnabled = false;
const QUALITY_MODE_THRESHOLD = 21;

// Subscriptions Only
let subscriptionsOnlyMode = false;

// Opaque blur - solid gray overlay instead of semi-transparent
let opaqueBlurEnabled = false;

// Current settings
let currentSettings: Settings | null = null;

// Hover reveal delay (in ms)
let hoverRevealDelay = 3000;

// Hover timers for timed reveal
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

  if (document.visibilityState !== 'visible') return;

  try {
    chrome.runtime.sendMessage(heartbeatMessage(), (response) => {
      if (chrome.runtime.lastError) return; // Extension might be updating
      handleHeartbeatResponse(response);
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
          log.debug(`Facebook: Blur threshold updated - phase: ${newPhase}, threshold: ${newThreshold}`);
          currentBlurThreshold = newThreshold;
          currentPhase = newPhase;
          refreshBlurState();
        }
      }
    }
  } catch {
    // Silently fail - will use default threshold
  }
}

function shouldBlurScore(score: EngagementScore): boolean {
  if (score.apiScore === undefined || score.scoreFailed) return false;
  // Trusted sources bypass blur until the configured phase
  if (score.whitelisted && isTrustedExempt(currentPhase, currentSettings?.trustedBlurPhase)) return false;
  if (subscriptionsOnlyMode && !score.whitelisted) return true;
  const displayScore = score.apiScore;
  const threshold = qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
  return displayScore >= threshold;
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return;

  sendHeartbeat();
  updateBlurThreshold();

  heartbeatIntervalId = setInterval(() => {
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

  log.debug('Facebook: Heartbeat tracking started');
}

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.id = 'tolerance-facebook-styles';
  style.textContent = `
    /* Gate: feed items stay blurred until handled (pending, badged, or unscorable) */
    ${fbGateCss('tolerance-fb-gate')}

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

    .tolerance-score-badge.failed {
      background: rgba(127, 140, 141, 0.85);
    }

    /* Blur overlay for high-engagement content */
    .tolerance-blur-overlay {
      position: absolute !important;
      top: -10px !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 10px !important;
      backdrop-filter: blur(40px) !important;
      -webkit-backdrop-filter: blur(40px) !important;
      z-index: 50 !important;
      transition: opacity 0.3s ease;
      display: flex !important;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.15) !important;
    }

    .tolerance-blur-overlay {
      flex-direction: column;
      gap: 8px;
    }
    .tolerance-blur-label {
      max-width: 80%;
      text-align: center;
      background: rgba(231, 76, 60, 0.9);
      color: white;
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .tolerance-blur-label.medium { background: rgba(243, 156, 18, 0.9); }
    .tolerance-blur-label.low { background: rgba(39, 174, 96, 0.9); }
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
    .tolerance-fb-post.tolerance-processed {
      position: relative;
    }

    /* Block videos when blurred */
    .tolerance-fb-post.tolerance-video-blocked video {
      visibility: hidden !important;
      pointer-events: none !important;
    }

    .tolerance-fb-post.tolerance-video-blocked audio {
      visibility: hidden !important;
    }

    /* Pending blur (before scoring completes) */
    .tolerance-fb-post.tolerance-pending {
      position: relative;
    }

    .tolerance-fb-post.tolerance-pending .tolerance-blur-overlay::after {
      content: 'Scoring...';
    }

    /* Hide score badge while pending */
    .tolerance-fb-post.tolerance-pending .tolerance-score-badge {
      display: none;
    }
  `;
  document.head.appendChild(style);
}

// CSS gate on where pending blur applies
function updateGate(): void {
  const on = isExtensionValid() && isValidFeedPage() &&
    currentSettings?.platforms?.facebook !== false &&
    currentSettings?.blurUntilScored !== false;
  document.documentElement.classList.toggle('tolerance-fb-gate', on);
}

function removeEarlyBlur(): void {
  document.getElementById('tolerance-early-blur')?.remove();
  document.documentElement.classList.remove('tolerance-fb-early');
}

// Mark a post root as handled for this post
function claimPost(post: FacebookPost): void {
  post.element.classList.add('tolerance-fb-post');
  post.element.setAttribute(FB_POST_ID_ATTR, post.id);
}

// Re-apply badge/blur for every visible scored post (threshold or mode changed)
function refreshBlurState(): void {
  for (const element of document.querySelectorAll<HTMLElement>(`[${FB_POST_ID_ATTR}]`)) {
    const cached = scoreCache.get(element.getAttribute(FB_POST_ID_ATTR)!);
    if (cached && !element.classList.contains('tolerance-pending')) {
      injectBadge({ element } as FacebookPost, cached.score);
    }
  }
}

function applyPendingBlur(post: FacebookPost): void {
  const element = post.element;
  if (!element) return;
  claimPost(post);

  if (element.classList.contains('tolerance-blurred') ||
      element.classList.contains('tolerance-pending')) return;

  element.classList.add('tolerance-pending');
  element.classList.add('tolerance-video-blocked');
  element.style.position = 'relative';

  if (!element.querySelector('.tolerance-blur-overlay')) {
    const overlay = document.createElement('div');
    overlay.className = 'tolerance-blur-overlay';
    if (opaqueBlurEnabled) {
      overlay.style.background = 'rgb(140, 140, 140)';
    }
    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    element.appendChild(overlay);

    // Auto-remove pending blur if scoring hasn't resolved it (null = wait until scored)
    const pendingTimeoutMs = pendingBlurTimeoutMs(currentSettings?.blurUntilScoredTimeout);
    if (pendingTimeoutMs !== null) setTimeout(() => {
      if (element.classList.contains('tolerance-pending')) {
        element.classList.remove('tolerance-pending');
        element.classList.remove('tolerance-video-blocked');
        overlay.remove();
      }
    }, pendingTimeoutMs);
  }
}

function removePendingBlur(post: FacebookPost): void {
  const element = post.element;
  if (!element) return;

  element.classList.remove('tolerance-pending');
  element.classList.remove('tolerance-video-blocked');

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

  log.debug('Facebook: processPosts called, pathname:', window.location.pathname);

  if (!isValidFeedPage()) {
    log.debug('Facebook: processPosts bailing - not valid feed page');
    disconnectObserver();
    return;
  }

  // Check if previous processing got stuck
  if (isProcessing) {
    const elapsed = Date.now() - processingStartTime;
    if (elapsed > MAX_PROCESSING_TIME) {
      log.debug(`Facebook: Processing stuck for ${elapsed}ms, forcing unlock`);
      isProcessing = false;
    } else {
      pendingProcess = true;
      return;
    }
  }

  isProcessing = true;
  processingStartTime = Date.now();

  try {
    const posts = scrapeVisiblePosts();
    log.debug(`Facebook: Found ${posts.length} posts`);

    // Feed items that aren't posts (suggestions, reels trays...) will never be
    // scored; release them from the CSS gate. Empty items (still loading or
    // virtualized offscreen) stay gated until they have content.
    const scraped = new Set(posts.map(p => p.element));
    for (const item of document.querySelectorAll<HTMLElement>(POST_ROOT_SELECTOR)) {
      if (scraped.has(item) || item.hasAttribute(FB_POST_ID_ATTR) || item.hasAttribute(FB_DONE_ATTR)) continue;
      if ((item.textContent?.trim().length ?? 0) > 0) item.setAttribute(FB_DONE_ATTR, '');
    }

    const newPosts = posts.filter(p => !processedPostIds.has(p.id));

    // Re-inject badges for posts that were processed but DOM was recreated, and
    // settle any whose result landed on a detached element (stuck on "Scoring...")
    for (const post of posts) {
      if (processedPostIds.has(post.id)) {
        const cached = scoreCache.get(post.id);
        if (cached && (!post.element.querySelector('.tolerance-score-badge') ||
                       post.element.classList.contains('tolerance-pending'))) {
          injectBadge(post, cached.score);
        }
      }
    }

    if (newPosts.length === 0) {
      log.debug('Facebook: No new posts to process');
      return;
    }

    log.debug(`Facebook: Processing ${newPosts.length} new posts`);

    const postsNeedingScoring: typeof newPosts = [];
    for (const post of newPosts) {
      processedPostIds.add(post.id);

      const cached = scoreCache.get(post.id);
      if (cached) {
        log.debug(`Facebook: Using cached score for ${post.id}`);
        injectBadge(post, cached.score);
      } else {
        if (currentSettings?.blurUntilScored !== false) {
          applyPendingBlur(post);
        }
        postsNeedingScoring.push(post);
      }
    }

    if (postsNeedingScoring.length === 0) {
      log.debug('Facebook: All posts served from cache');
      return;
    }

    const serializedPosts = postsNeedingScoring.map(p => serializePost(p));

    const scorePromise = sendMessage({
      type: 'SCORE_FACEBOOK_POSTS',
      posts: serializedPosts,
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Scoring timeout')), 10000)
    );

    let response;
    try {
      response = await Promise.race([scorePromise, timeoutPromise]);
    } catch {
      // Keep the pending blur (its own timeout setting decides when to reveal) and retry
      log.debug('Facebook: Scoring timed out, retrying');
      retryUnscored(postsNeedingScoring);
      return;
    }

    if (!response || !(response as { scores?: EngagementScore[] }).scores) {
      log.debug('Facebook: No scores returned, retrying');
      retryUnscored(postsNeedingScoring);
      return;
    }

    const scores = (response as { scores: EngagementScore[] }).scores;
    log.debug(`Facebook: Received ${scores.length} scores`);

    const scoreMap = new Map<string, EngagementScore>();
    for (const score of scores) {
      scoreMap.set(score.postId, score);
    }

    const missing: FacebookPost[] = [];
    for (const post of postsNeedingScoring) {
      const score = scoreMap.get(post.id);
      if (score) {
        scoreCache.set(post.id, { score, author: post.authorDisplayName });
        // The element may have been re-rendered while scoring; badge the live one
        const live = post.element.isConnected ? post.element
          : document.querySelector<HTMLElement>(`[${FB_POST_ID_ATTR}="${CSS.escape(post.id)}"]`);
        if (live) injectBadge({ ...post, element: live }, score);
        else pendingProcess = true;
      } else {
        missing.push(post);
      }
    }
    if (missing.length > 0) retryUnscored(missing);
  } catch (error) {
    log.error('Facebook: Error processing posts:', error);
  } finally {
    isProcessing = false;

    if (pendingProcess) {
      pendingProcess = false;
      setTimeout(processPosts, 100);
    }
  }
}

// Posts that didn't get a score: forget them so the next pass sends them again
let retryTimer: ReturnType<typeof setTimeout> | null = null;
function retryUnscored(posts: FacebookPost[]): void {
  for (const post of posts) processedPostIds.delete(post.id);
  if (!retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = null; void processPosts(); }, 3000);
  }
}

function injectBadge(post: FacebookPost, score: EngagementScore): void {
  const element = post.element;
  if (!element) return;
  if (post.id) claimPost(post);

  element.classList.add('tolerance-processed');
  element.classList.remove('tolerance-pending');

  // Remove existing badge/overlay
  const existingBadge = element.querySelector('.tolerance-score-badge');
  if (existingBadge) existingBadge.remove();
  const existingBlur = element.querySelector('.tolerance-blur-overlay');
  if (existingBlur) existingBlur.remove();
  element.classList.remove('tolerance-video-blocked');

  // Create badge
  const displayScore = score.apiScore;
  // A failed score carries the placeholder 50; show it as "?" with the error instead
  const scoringFailed = score.apiScore === undefined || !!score.scoreFailed;
  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${scoringFailed ? 'failed' : score.bucket}`;
  badge.textContent = scoringFailed ? '?' : displayScore.toString();

  if (scoringFailed) {
    void showFreeTierExhaustedDialog(currentSettings);

    const isOwnKey = currentSettings?.apiTier === 'own-key';
    badge.title = score.apiReason ||
      (isOwnKey ? 'Error receiving score.' : 'Free tier exhausted. Click to upgrade to Pro, or use your own API key.');
    badge.style.cursor = 'pointer';
    badge.style.pointerEvents = 'auto';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open('https://tolerance.lol/account.html', '_blank');
    });
  } else if (score.apiReason) {
    badge.title = score.apiReason;
    badge.style.cursor = 'default';
    badge.style.pointerEvents = 'auto';
  }

  element.style.position = 'relative';
  element.appendChild(badge);

  // Apply blur if score exceeds threshold
  if (shouldBlurScore(score)) {
    applyBlur(element, score);
  }
}

// "<score>: <reason>" pill shown on the blur, colored by bucket (as on Twitter)
function buildBlurLabel(score: EngagementScore): HTMLElement {
  const label = document.createElement('div');
  label.className = `tolerance-blur-label ${score.bucket}`;
  const rounded = Math.round(score.apiScore);
  let text = subscriptionsOnlyMode && !score.whitelisted
    ? 'Not following'
    : score.apiReason ? `${rounded}: ${score.apiReason}` : `Score ${rounded}`;
  if (score.whitelisted && !subscriptionsOnlyMode) text += ' (trusted, blurred late in session)';
  label.textContent = text;
  return label;
}

function applyBlur(element: HTMLElement, score: EngagementScore): void {
  element.classList.add('tolerance-video-blocked');

  (element as HTMLElement & { _toleranceUnblockVideo?: () => void })._toleranceUnblockVideo = () => {
    element.classList.remove('tolerance-video-blocked');
  };

  element.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';
  if (opaqueBlurEnabled) {
    overlay.style.background = 'rgb(140, 140, 140)';
  }

  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let revealed = false;

  const revealContent = () => {
    revealed = true;
    overlay.classList.add('revealed');
    const unblock = (element as HTMLElement & { _toleranceUnblockVideo?: () => void })._toleranceUnblockVideo;
    if (unblock) unblock();
  };

  overlay.addEventListener('mouseenter', () => {
    if (revealed) return;
    overlay.classList.add('revealing');
    revealTimer = setTimeout(revealContent, hoverRevealDelay);
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

  overlay.addEventListener('click', (e) => {
    if (!revealed) {
      e.stopPropagation();
      revealContent();
    }
  });

  overlay.appendChild(buildBlurLabel(score));
  element.appendChild(overlay);
}

async function init(): Promise<void> {
  log.debug('Facebook: init() called, pathname:', window.location.pathname);

  injectStyles();

  // Navigation is watched from every page, so arriving at the feed from elsewhere works
  setupNavigationObserver(() => {
    processedPostIds.clear();
    updateGate();
    if (isValidFeedPage()) {
      setupFacebookObserver(processPosts);
      void processPosts();
    } else {
      disconnectObserver();
    }
  });

  if (!isValidFeedPage()) {
    log.debug('Facebook: Not a valid feed page, waiting for navigation');
    removeEarlyBlur();
    return;
  }
  log.debug('Facebook: Valid feed page, continuing init');

  // Get settings
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response) {
      const { settings } = response as { state: AppState; settings: Settings };
      currentSettings = settings;

      if (settings.platforms?.facebook === false) {
        log.debug('Facebook: Platform disabled in settings');
        removeEarlyBlur();
        return;
      }

      if (settings.logLevel) {
        setLogLevel(settings.logLevel);
      }

      qualityModeEnabled = settings.qualityMode ?? false;
      subscriptionsOnlyMode = settings.subscriptionsOnly ?? false;
      hoverRevealDelay = (settings.twitter?.hoverRevealDelay ?? 3) * 1000;
      opaqueBlurEnabled = settings.twitter?.opaqueBlur ?? false;
    }
  } catch (error) {
    log.error('Facebook: Failed to get settings:', error);
  }

  // Switch from early.ts's CSS blur to our own gate
  updateGate();
  removeEarlyBlur();

  // Fetch initial blur threshold
  await updateBlurThreshold();

  // Start heartbeat
  startHeartbeat();

  // Initial process
  await processPosts();

  // Set up observer for new feed items
  setupFacebookObserver(processPosts);

  log.debug('Facebook: Initialization complete');
}


log.debug('Facebook: Content script loaded');

function startWithDelay(): void {
  // No hydration wait: the CSS gate covers posts until they're scored, and the
  // observer picks up whatever React renders next
  void init();
}

// Keep settings in sync
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) {
    const newSettings = changes.settings.newValue as Settings;
    currentSettings = newSettings;
    updateGate();
    qualityModeEnabled = newSettings.qualityMode ?? false;
    subscriptionsOnlyMode = newSettings.subscriptionsOnly ?? false;
    refreshBlurState();

    // Update opaque blur setting and apply to existing overlays
    const newOpaqueBlur = newSettings.twitter?.opaqueBlur ?? false;
    if (newOpaqueBlur !== opaqueBlurEnabled) {
      opaqueBlurEnabled = newOpaqueBlur;
      const overlays = document.querySelectorAll('.tolerance-blur-overlay') as NodeListOf<HTMLElement>;
      for (const overlay of overlays) {
        overlay.style.background = opaqueBlurEnabled ? 'rgb(140, 140, 140)' : '';
      }
    }
  }
});

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

// Track right-clicked element for context menu (capture: true like YouTube fix)
let lastRightClickedElement: HTMLElement | null = null;

document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as HTMLElement;
}, true);

// Extract author display name from a Facebook post element
function extractAuthorFromElement(element: HTMLElement | null): string | null {
  if (!element) return null;

  // Walk up to find the article container
  const article = element.closest('div[role="article"]');
  if (!article) return null;

  // Look for profile links
  const profilePatterns = [
    'a[href*="/user/"]',
    'a[href*="/profile.php"]',
  ];

  for (const pattern of profilePatterns) {
    const links = article.querySelectorAll<HTMLAnchorElement>(pattern);
    for (const link of links) {
      const text = link.textContent?.trim() || '';
      if (text && text.length >= 2 &&
          !/^(Like|Comment|Share|Reply|\d)/.test(text)) {
        return text;
      }
    }
  }

  // Fallback: strong/heading links
  const strongLinks = article.querySelectorAll<HTMLAnchorElement>('strong a[role="link"], h2 a[role="link"], h3 a[role="link"]');
  for (const link of strongLinks) {
    const text = link.textContent?.trim() || '';
    if (text && text.length >= 2) return text;
  }

  return null;
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_IMAGE_BASE64') {
    fetchImageAsBase64(message.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_CLICKED_AUTHOR') {
    const author = extractAuthorFromElement(lastRightClickedElement);
    if (author) {
      sendResponse({ sourceId: author, platform: 'facebook' });
    } else {
      sendResponse({ sourceId: null, platform: null });
    }
    return true;
  }

  if (message.type === 'AUTHOR_WHITELISTED') {
    log.info(`Author ${message.sourceId} added to whitelist`);
    for (const [postId, cached] of scoreCache) {
      if (cached.author === message.sourceId) {
        cached.score.whitelisted = true;
        scoreCache.set(postId, cached);
      }
    }
    // Unblur articles by this author
    const articles = document.querySelectorAll('div[role="article"]');
    for (const article of articles) {
      const profileLinks = article.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"], a[href*="/profile.php"], strong a[role="link"], h2 a[role="link"]');
      for (const link of profileLinks) {
        const text = link.textContent?.trim() || '';
        if (text === message.sourceId) {
          article.classList.remove('tolerance-blurred');
          const overlay = article.querySelector('.tolerance-blur-overlay');
          if (overlay) overlay.remove();
          break;
        }
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'QUALITY_MODE_CHANGED') {
    qualityModeEnabled = message.enabled;
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SUBSCRIPTIONS_ONLY_CHANGED') {
    subscriptionsOnlyMode = message.enabled;
    sendResponse({ success: true });
    return true;
  }

  return true;
});

// Fetch image, resize to max 512px, and convert to base64
async function fetchImageAsBase64(url: string): Promise<string> {
  const MAX_SIZE = 512;

  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const blob = await response.blob();
  const img = await createImageBitmap(blob);

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

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(img, 0, 0, width, height);

  const resizedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      log.debug(`Image resized ${img.width}x${img.height} -> ${width}x${height}`);
      resolve(result);
    };
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(resizedBlob);
  });
}
