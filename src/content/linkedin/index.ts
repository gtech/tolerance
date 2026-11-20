import { LinkedInPost, EngagementScore, AppState, Settings, MessageType, ResponseFor, isTrustedExempt, pendingBlurTimeoutMs } from '../../shared/types';
import { log, setLogLevel, QUALITY_MODE_THRESHOLD } from '../../shared/constants';
import { scrapeVisiblePosts, serializePost, findPostElements, extractAuthor } from './scraper';
import { setupLinkedInObserver, setupNavigationObserver, isValidFeedPage, disconnectObserver } from './observer';
import { LI_POST, LI_POST_ID_ATTR, LI_DONE_ATTR, liGateCss } from './gate';
import { showFreeTierExhaustedDialog } from '../freeTierDialog';
import { failedScoreNotice, linkFailedBadge } from '../failedScore';
import { startScrapeHealth, reportScraped } from '../scrapeHealth';
import { logShown, type ShownPost } from '../impressionLog';
import { heartbeatMessage, handleHeartbeatResponse } from '../grounding';
import { noteReveal } from '../burstCard';
import { attachHoldReveal } from '../holdReveal';
import { setOpaque } from '../opaqueBlur';
import { applyBlurPrefs, hoverRevealEnabled } from '../blurPrefs';
import { releaseIfStillUnscraped } from '../gateSwitch';
import { fetchImageAsBase64 } from '../fetchImage';
import { watchForReload } from '../reloadNotice';

// LinkedIn's home feed. Built the way Facebook's is (../facebook/index.ts): a CSS gate
// covers posts until they are scored, then each gets a score badge and, at or above
// the blur threshold, an overlay that a press-and-hold opens.
//
// LinkedIn is an optional site: this script only runs once it is switched on in the
// dashboard, which is what grants the extension access to linkedin.com.

const processedPostIds = new Set<string>();
const healthReported = new Set<string>();   // posts already counted by the scraper health check

// The feed removes posts as they scroll away and builds them again on the way back,
// so scores are kept here and put back on the new element
const scoreCache = new Map<string, { score: EngagementScore; author: string }>();

let isProcessing = false;
let pendingProcess = false;
let processingStartTime = 0;
const MAX_PROCESSING_TIME = 15000;

const HEARTBEAT_INTERVAL = 30_000;
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null;

let currentBlurThreshold = 55;
let currentPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal' = 'normal';
let qualityModeEnabled = false;
let subscriptionsOnlyMode = false;
let opaqueBlurEnabled = false;
let currentSettings: Settings | null = null;
let hoverRevealDelay = 3000;
const hoverTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let stylesInjected = false;

function isExtensionValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function stopHeartbeat(): void {
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
}

function sendHeartbeat(): void {
  if (!isExtensionValid()) { stopHeartbeat(); return; }
  if (document.visibilityState !== 'visible') return;
  try {
    chrome.runtime.sendMessage(heartbeatMessage(), (response) => {
      if (chrome.runtime.lastError) return; // Extension might be updating
      handleHeartbeatResponse(response);
    });
  } catch {
    stopHeartbeat();
  }
}

async function sendMessage<M extends MessageType>(message: M): Promise<ResponseFor<M> | null> {
  return new Promise((resolve, reject) => {
    if (!isExtensionValid()) {
      reject(new Error('Extension context invalid'));
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function updateBlurThreshold(): Promise<void> {
  if (!isExtensionValid()) return;
  try {
    const sessionResult = await sendMessage({ type: 'GET_GLOBAL_SESSION' });
    if (sessionResult && 'phase' in sessionResult) {
      const newPhase = sessionResult.phase as typeof currentPhase;
      const thresholdResult = await sendMessage({ type: 'GET_EFFECTIVE_BLUR_THRESHOLD', phase: newPhase });
      if (thresholdResult && 'threshold' in thresholdResult) {
        const newThreshold = thresholdResult.threshold as number;
        if (newThreshold !== currentBlurThreshold || newPhase !== currentPhase) {
          currentBlurThreshold = newThreshold;
          currentPhase = newPhase;
          refreshBlurState();
        }
      }
    }
  } catch {
    // Keep the threshold we have
  }
}

function blurThreshold(): number {
  return qualityModeEnabled ? QUALITY_MODE_THRESHOLD : currentBlurThreshold;
}

function shouldBlurScore(score: EngagementScore): boolean {
  if (score.apiScore === undefined) return false;
  // Trusted sources bypass blur until the configured phase
  if (score.whitelisted && isTrustedExempt(currentPhase, currentSettings?.trustedBlurPhase)) return false;
  if (subscriptionsOnlyMode && !score.whitelisted) return true;
  return score.apiScore >= blurThreshold();
}

function startHeartbeat(): void {
  if (heartbeatIntervalId) return;
  sendHeartbeat();
  heartbeatIntervalId = setInterval(() => {
    if (!isValidFeedPage()) return;
    sendHeartbeat();
    void updateBlurThreshold();
  }, HEARTBEAT_INTERVAL);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isValidFeedPage()) {
      sendHeartbeat();
      void updateBlurThreshold();
    }
  });
}

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.id = 'tolerance-linkedin-styles';
  style.textContent = `
    /* Gate: feed posts stay blurred until handled (pending, badged, or unscorable) */
    ${liGateCss('tolerance-li-gate')}

    .tolerance-li-post { position: relative; }

    .tolerance-li-post > .tolerance-score-badge {
      position: absolute !important;
      top: 8px !important;
      left: 50% !important;
      transform: translateX(-50%) !important;
      background: rgba(60, 60, 60, 0.85);
      color: white;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 8px;
      border-radius: 4px;
      z-index: 100;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      pointer-events: none;
    }
    .tolerance-li-post > .tolerance-score-badge.failed { background: rgba(127, 140, 141, 0.85); }

    .tolerance-li-post > .tolerance-blur-overlay {
      position: absolute !important;
      inset: 0 !important;
      backdrop-filter: blur(40px) !important;
      -webkit-backdrop-filter: blur(40px) !important;
      z-index: 50 !important;
      transition: opacity 0.3s ease;
      display: flex !important;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.15) !important;
      border-radius: inherit;
    }
    .tolerance-li-post .tolerance-blur-label {
      max-width: 80%;
      text-align: center;
      background: rgba(60, 60, 60, 0.9);
      color: white;
      padding: 6px 12px;
      border-radius: 16px;
      font-size: 13px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .tolerance-li-post .tolerance-blur-label.failed { background: rgba(127, 140, 141, 0.9); }
    .tolerance-li-post > .tolerance-blur-overlay::after {
      content: var(--tolerance-hover-text, 'Hover to reveal');
      color: rgba(255, 255, 255, 0.9);
      font-size: 14px;
      font-weight: 500;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .tolerance-li-post > .tolerance-blur-overlay.revealing::after { content: 'Revealing...'; }
    .tolerance-li-post > .tolerance-blur-overlay.revealed { opacity: 0; pointer-events: none; }
    .tolerance-li-post.tolerance-pending > .tolerance-blur-overlay::after { content: 'Scoring...'; }
    .tolerance-li-post.tolerance-pending > .tolerance-score-badge { display: none; }

    /* No video or sound from a blurred post */
    .tolerance-li-post.tolerance-video-blocked video,
    .tolerance-li-post.tolerance-video-blocked audio {
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
}

// CSS gate on where pending blur applies
function updateGate(): void {
  const on = isExtensionValid() && isValidFeedPage() && currentSettings?.blurUntilScored !== false;
  document.documentElement.classList.toggle('tolerance-li-gate', on);
}

function removeEarlyBlur(): void {
  document.getElementById('tolerance-early-blur')?.remove();
  document.documentElement.classList.remove('tolerance-li-early');
}

// Mark a post root as handled for this post
function claimPost(element: HTMLElement, id: string): void {
  element.classList.add('tolerance-li-post');
  element.setAttribute(LI_POST_ID_ATTR, id);
}

function clearOurs(element: HTMLElement): void {
  element.querySelector(':scope > .tolerance-score-badge')?.remove();
  element.querySelector(':scope > .tolerance-blur-overlay')?.remove();
  element.classList.remove('tolerance-video-blocked');
}

// Re-apply badge and blur on every scored post in the page (threshold or mode changed)
function refreshBlurState(): void {
  for (const element of document.querySelectorAll<HTMLElement>(`[${LI_POST_ID_ATTR}]`)) {
    const id = element.getAttribute(LI_POST_ID_ATTR)!;
    const cached = scoreCache.get(id);
    if (cached && !element.classList.contains('tolerance-pending')) injectBadge(element, id, cached.score);
  }
}

function applyPendingBlur(post: LinkedInPost): void {
  const element = post.element;
  claimPost(element, post.id);
  if (element.classList.contains('tolerance-pending')) return;

  element.classList.add('tolerance-pending', 'tolerance-video-blocked');
  if (element.querySelector(':scope > .tolerance-blur-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';
  if (opaqueBlurEnabled) setOpaque(overlay, true);
  overlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  element.appendChild(overlay);

  // Give up on the pending blur if scoring never resolves it (null = wait until scored)
  const pendingTimeoutMs = pendingBlurTimeoutMs(currentSettings?.blurUntilScoredTimeout);
  if (pendingTimeoutMs !== null) setTimeout(() => {
    if (element.classList.contains('tolerance-pending')) {
      element.classList.remove('tolerance-pending', 'tolerance-video-blocked');
      overlay.remove();
    }
  }, pendingTimeoutMs);
}

async function processPosts(): Promise<void> {
  if (!isExtensionValid()) {
    // The extension was updated or reloaded under this tab and can no longer score.
    // Drop the gate, or every new post stays blurred and unclickable until a reload.
    updateGate();
    return;
  }
  if (!isValidFeedPage()) {
    disconnectObserver();
    return;
  }

  if (isProcessing) {
    if (Date.now() - processingStartTime > MAX_PROCESSING_TIME) {
      isProcessing = false;   // the last pass got stuck
    } else {
      pendingProcess = true;
      return;
    }
  }
  isProcessing = true;
  processingStartTime = Date.now();

  try {
    const posts = scrapeVisiblePosts();

    // Post cards with nothing to score yet are usually still loading. One that stays
    // that way is released from the gate so it doesn't sit blurred for good.
    const scraped = new Set(posts.map(p => p.element));
    for (const item of findPostElements()) {
      if (scraped.has(item) || item.hasAttribute(LI_POST_ID_ATTR) || item.hasAttribute(LI_DONE_ATTR)) continue;
      if ((item.textContent?.trim().length ?? 0) > 0) releaseIfStillUnscraped(item, processPosts);
    }

    const newPosts = posts.filter(p => !processedPostIds.has(p.id));
    reportScraped('linkedin', newPosts.filter(p => !healthReported.has(p.id)));
    for (const p of newPosts) healthReported.add(p.id);

    // Posts seen before whose element was rebuilt: put the badge back, or keep the
    // pending cover on one that is still being scored
    for (const post of posts) {
      if (!processedPostIds.has(post.id)) continue;
      const cached = scoreCache.get(post.id);
      if (cached) {
        if (!post.element.querySelector(':scope > .tolerance-score-badge') ||
            post.element.classList.contains('tolerance-pending')) {
          injectBadge(post.element, post.id, cached.score);
        }
      } else if (!post.element.hasAttribute(LI_POST_ID_ATTR) && currentSettings?.blurUntilScored !== false) {
        applyPendingBlur(post);
      }
    }

    if (newPosts.length === 0) return;

    const needScoring: LinkedInPost[] = [];
    for (const post of newPosts) {
      processedPostIds.add(post.id);
      const cached = scoreCache.get(post.id);
      if (cached) {
        injectBadge(post.element, post.id, cached.score);
      } else {
        if (currentSettings?.blurUntilScored !== false) applyPendingBlur(post);
        else claimPost(post.element, post.id);
        needScoring.push(post);
      }
    }
    if (needScoring.length === 0) return;

    let response: { scores?: EngagementScore[] } | null;
    try {
      response = await Promise.race([
        sendMessage({ type: 'SCORE_LINKEDIN_POSTS', posts: needScoring.map(serializePost) }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Scoring timeout')), 10000)),
      ]) as { scores?: EngagementScore[] } | null;
    } catch {
      // Keep the pending blur (its own timeout setting decides when to reveal) and retry
      retryUnscored(needScoring);
      return;
    }
    if (!response?.scores) {
      retryUnscored(needScoring);
      return;
    }

    const scoreMap = new Map(response.scores.map(s => [s.postId, s]));
    const missing: LinkedInPost[] = [];
    const shown: ShownPost[] = [];
    for (const post of needScoring) {
      const score = scoreMap.get(post.id);
      if (!score) { missing.push(post); continue; }
      scoreCache.set(post.id, { score, author: post.authorDisplayName });
      // The element may have been rebuilt while scoring; badge the live one
      const live = post.element.isConnected ? post.element
        : document.querySelector<HTMLElement>(`[${LI_POST_ID_ATTR}="${CSS.escape(post.id)}"]`);
      if (live) injectBadge(live, post.id, score);
      else pendingProcess = true;
      shown.push({
        id: post.id, element: live, source: post.authorDisplayName, score,
        blurThreshold: blurThreshold(), blurred: shouldBlurScore(score),
      });
    }
    if (missing.length > 0) retryUnscored(missing);
    logShown('linkedin', shown);
  } catch (error) {
    log.error('LinkedIn: Error processing posts:', error);
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
function retryUnscored(posts: LinkedInPost[]): void {
  for (const post of posts) processedPostIds.delete(post.id);
  if (!retryTimer) {
    retryTimer = setTimeout(() => { retryTimer = null; void processPosts(); }, 3000);
  }
}

function injectBadge(element: HTMLElement, id: string, score: EngagementScore): void {
  claimPost(element, id);
  element.classList.add('tolerance-processed');
  element.classList.remove('tolerance-pending');
  clearOurs(element);

  // A failed score carries the placeholder 50; show it as "?" with the error instead
  const scoringFailed = score.apiScore === undefined || !!score.scoreFailed;
  const badge = document.createElement('div');
  badge.className = `tolerance-score-badge ${scoringFailed ? 'failed' : score.bucket}`;
  badge.textContent = scoringFailed ? '?' : score.apiScore.toString();

  if (scoringFailed) {
    void showFreeTierExhaustedDialog(currentSettings);
    const notice = failedScoreNotice(currentSettings, score.apiReason);
    badge.title = notice.text;
    linkFailedBadge(badge, notice);
  } else if (score.apiReason) {
    badge.title = score.apiReason;
    badge.style.cursor = 'default';
    badge.style.pointerEvents = 'auto';
  }
  element.appendChild(badge);

  if (shouldBlurScore(score)) applyBlur(element, score);
}

// "<score>: <reason>" pill shown on the blur
function buildBlurLabel(score: EngagementScore): HTMLElement {
  const label = document.createElement('div');
  label.className = `tolerance-blur-label ${score.scoreFailed ? 'failed' : score.bucket}`;
  const rounded = Math.round(score.apiScore);
  let text = subscriptionsOnlyMode && !score.whitelisted
    ? 'Not following'
    : score.scoreFailed
      ? `Couldn't score, counted as ${rounded}: ${(score.apiReason ?? '').replace(/^Scoring failed: /, '')}`
      : score.apiReason ? `${rounded}: ${score.apiReason}` : `Score ${rounded}`;
  if (score.whitelisted && !subscriptionsOnlyMode) text += ' (trusted, blurred late in session)';
  label.textContent = text;
  return label;
}

function applyBlur(element: HTMLElement, score: EngagementScore): void {
  element.classList.add('tolerance-video-blocked');

  const overlay = document.createElement('div');
  overlay.className = 'tolerance-blur-overlay';
  if (opaqueBlurEnabled) setOpaque(overlay, true);

  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let revealed = false;
  const revealContent = () => {
    revealed = true;
    overlay.classList.add('revealed');
    noteReveal(overlay);
    element.classList.remove('tolerance-video-blocked');
  };

  overlay.addEventListener('mouseenter', () => {
    if (revealed || !hoverRevealEnabled()) return;
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
    hoverTimers.delete(overlay);
  });
  // Clicks don't reveal; holding does
  overlay.addEventListener('click', (e) => {
    if (!revealed) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  overlay.appendChild(buildBlurLabel(score));
  element.appendChild(overlay);
  attachHoldReveal(overlay, { post: element, reveal: revealContent, isRevealed: () => revealed });
}

function applySettings(settings: Settings): void {
  currentSettings = settings;
  qualityModeEnabled = settings.qualityMode ?? false;
  subscriptionsOnlyMode = settings.subscriptionsOnly ?? false;
  hoverRevealDelay = (settings.twitter?.hoverRevealDelay ?? 3) * 1000;
  applyBlurPrefs(settings);
  const opaque = settings.twitter?.opaqueBlur ?? true;
  if (opaque !== opaqueBlurEnabled) {
    opaqueBlurEnabled = opaque;
    for (const overlay of document.querySelectorAll<HTMLElement>('.tolerance-blur-overlay')) {
      setOpaque(overlay, opaque);
    }
  }
}

async function init(): Promise<void> {
  injectStyles();

  // Settings are fetched on every page, so a tab opened on a profile or a single post
  // is ready when the person reaches the feed
  try {
    const response = await sendMessage({ type: 'GET_STATE' });
    if (response) {
      const { settings } = response as { state: AppState; settings: Settings };
      if (settings.logLevel) setLogLevel(settings.logLevel);
      applySettings(settings);
      startScrapeHealth('linkedin', settings, isValidFeedPage());
    }
  } catch (error) {
    log.error('LinkedIn: Failed to get settings:', error);
  }

  let feedStarted = false;
  const startFeed = async (): Promise<void> => {
    if (!feedStarted) {
      feedStarted = true;
      await updateBlurThreshold();
      startHeartbeat();
      watchForReload();
    }
    await processPosts();
    setupLinkedInObserver(processPosts);
  };

  setupNavigationObserver(() => {
    processedPostIds.clear();
    updateGate();
    if (isValidFeedPage()) void startFeed();
    else disconnectObserver();
  });

  // Switch from early.ts's CSS blur to our own gate
  updateGate();
  removeEarlyBlur();

  if (isValidFeedPage()) await startFeed();
}

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings?.newValue) return;
  applySettings(changes.settings.newValue as Settings);
  updateGate();
  refreshBlurState();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}

window.addEventListener('unload', () => {
  disconnectObserver();
  stopHeartbeat();
});

// "Trust this author" in the right-click menu
let lastRightClickedElement: HTMLElement | null = null;
document.addEventListener('contextmenu', (e) => {
  lastRightClickedElement = e.target as HTMLElement;
}, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'FETCH_IMAGE_BASE64') {
    fetchImageAsBase64(message.url)
      .then(base64 => sendResponse({ success: true, base64 }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_CLICKED_AUTHOR') {
    const post = lastRightClickedElement?.closest<HTMLElement>(LI_POST);
    const author = post ? extractAuthor(post) : '';
    sendResponse(author ? { sourceId: author, platform: 'linkedin' } : { sourceId: null, platform: null });
    return true;
  }

  if (message.type === 'AUTHOR_WHITELISTED') {
    for (const cached of scoreCache.values()) {
      if (cached.author === message.sourceId) cached.score.whitelisted = true;
    }
    refreshBlurState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'QUALITY_MODE_CHANGED') {
    qualityModeEnabled = message.enabled;
    refreshBlurState();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SUBSCRIPTIONS_ONLY_CHANGED') {
    subscriptionsOnlyMode = message.enabled;
    refreshBlurState();
    sendResponse({ success: true });
    return true;
  }

  return true;
});
