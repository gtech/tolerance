/**
 * Claude De-Validation Filter
 *
 * Intercepts Claude's responses and rewrites them through a second model to:
 * 1. Strip excessive praise/sycophancy
 * 2. Add gentle "take a break" suggestions based on time spent
 *
 * The original response stays in Claude's context - only what the user sees changes.
 */

// Debug logging
const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log('[Tolerance Claude Filter]', ...args);

// Track processed messages to avoid re-processing
const processedMessages = new WeakSet<Element>();

interface SuppressionState {
  target: HTMLElement;
  placeholder: HTMLElement;
  previousVisibility: string;
}

interface RewriteResponse {
  rewritten?: string;
  changed?: boolean;
  skippedReason?: string;
}

const suppressedContainers = new WeakMap<Element, SuppressionState>();

// Track if we're currently filtering (to show indicator)
let isFiltering = false;

// Track if we've completed initial load (don't filter existing messages)
let initialLoadComplete = false;

// Heartbeat for session tracking
const HEARTBEAT_INTERVAL = 30_000;

/**
 * Detect if Claude is currently streaming a response
 */
function isStreaming(): boolean {
  // Look for stop button or streaming indicators
  const stopButton = document.querySelector('[aria-label="Stop response"]');
  const streamingIndicator = document.querySelector('[data-is-streaming="true"]');

  // Also check for the pulsing cursor that appears during streaming
  const cursor = document.querySelector('.result-streaming');

  // Check if any response container is still streaming
  const anyStreaming = document.querySelector('.group[data-is-streaming="true"]');

  return !!(stopButton || streamingIndicator || cursor || anyStreaming);
}

/**
 * Get the assistant message container for a streaming/completed Claude response.
 */
function getAssistantMessageFromContainer(container: Element): Element | null {
  const candidates = Array.from(container.querySelectorAll('.font-claude-response'));
  if (candidates.length === 0) {
    log('No .font-claude-response in container');
    return null;
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i];
    if (candidate.querySelector('.standard-markdown p, .standard-markdown li, .progressive-markdown p, .progressive-markdown li')) {
      log('Found assistant message container');
      return candidate;
    }
  }

  log('No response markdown found in Claude response candidates');
  return candidates[candidates.length - 1];
}

/**
 * Check if an element is inside the CoT container (relative to the response container)
 */
function isInsideCoT(md: Element, responseContainer: Element): boolean {
  // Walk up from the markdown to the response container
  // If we encounter a flex-col div with "ease-out" and "transition-all" classes, it's CoT
  let current = md.parentElement;

  while (current && current !== responseContainer) {
    const classes = current.className || '';
    // The CoT container has these specific classes together
    if (classes.includes('flex-col') && classes.includes('ease-out') && classes.includes('transition-all')) {
      return true;
    }
    // Also check for hidden content (collapsed CoT)
    const style = (current as HTMLElement).style;
    if (style?.display === 'none') {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}

/**
 * Extract text content from a message element (excluding CoT/thinking)
 */
function extractMessageText(element: Element): string {
  // The CoT is inside div.ease-out.transition-all.flex-col
  // The response .standard-markdown is NOT inside that container

  // Find all .standard-markdown elements within the response container
  const allMarkdown = element.querySelectorAll('.standard-markdown, .progressive-markdown');
  log(`Found ${allMarkdown.length} total markdown containers`);

  // Find the one that is NOT inside the CoT container
  for (let i = allMarkdown.length - 1; i >= 0; i--) {
    const md = allMarkdown[i];

    // Skip if inside the CoT container (check relative to this element)
    if (isInsideCoT(md, element)) {
      log(`Skipping markdown ${i} - inside CoT`);
      continue;
    }

    // This should be the response
    const paragraphs = md.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6');
    if (paragraphs.length > 0) {
      const texts: string[] = [];
      paragraphs.forEach(p => {
        const text = p.textContent?.trim();
        if (text) texts.push(text);
      });
      log(`Extracted ${texts.length} paragraphs from response markdown`);
      return texts.join('\n\n');
    }
  }

  log('No valid response markdown found');
  return '';
}

function suppressStreamingContainer(container: Element): void {
  if (suppressedContainers.has(container) || processedMessages.has(container)) {
    return;
  }

  const messageElement = getAssistantMessageFromContainer(container);
  const target = (messageElement || container) as HTMLElement;
  const placeholder = document.createElement('div');
  placeholder.className = 'tolerance-stream-placeholder';
  placeholder.innerHTML = `
    <style>
      .tolerance-stream-placeholder {
        margin: 8px 0;
        padding: 12px 14px;
        border: 1px solid rgba(125, 206, 160, 0.28);
        border-radius: 8px;
        background: rgba(125, 206, 160, 0.08);
        color: #7dcea0;
        font-size: 14px;
        line-height: 1.4;
      }
    </style>
    <span>Filtering response...</span>
  `;

  suppressedContainers.set(container, {
    target,
    placeholder,
    previousVisibility: target.style.visibility,
  });

  target.style.visibility = 'hidden';
  target.insertAdjacentElement('afterend', placeholder);
  log('Suppressed streaming response');
}

function clearStreamingSuppression(container: Element): void {
  const state = suppressedContainers.get(container);
  if (!state) {
    return;
  }

  state.placeholder.remove();
  state.target.style.visibility = state.previousVisibility;
  suppressedContainers.delete(container);
}

/**
 * Show filtering indicator
 */
function showFilteringIndicator(messageElement: Element): HTMLElement {
  const indicator = document.createElement('div');
  indicator.className = 'tolerance-filtering-indicator';
  indicator.innerHTML = `
    <style>
      .tolerance-filtering-indicator {
        position: absolute;
        top: 8px;
        right: 8px;
        background: rgba(125, 206, 160, 0.9);
        color: #0a0a0a;
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 12px;
        font-weight: 500;
        z-index: 1000;
        animation: tolerance-pulse 1s ease-in-out infinite;
      }
      @keyframes tolerance-pulse {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 1; }
      }
    </style>
    <span>filtering...</span>
  `;

  // Position relative to message
  const parent = messageElement.parentElement;
  if (parent) {
    parent.style.position = 'relative';
    parent.appendChild(indicator);
  }

  return indicator;
}

/**
 * Hide original message and show filtered version
 */
function replaceWithFilteredContent(
  originalElement: Element,
  filteredText: string
): void {
  // Option C from plan: hide original, inject our rendered version
  const originalHTML = originalElement as HTMLElement;
  originalHTML.style.display = 'none';

  // Create filtered container
  const filtered = document.createElement('div');
  filtered.className = 'tolerance-filtered-message';
  filtered.innerHTML = `
    <style>
      .tolerance-filtered-message {
        /* Match Claude's styling */
        font-family: inherit;
        line-height: 1.6;
      }
      .tolerance-filtered-message p {
        margin-bottom: 1em;
      }
      .tolerance-filter-badge {
        display: inline-block;
        background: rgba(125, 206, 160, 0.2);
        color: #7dcea0;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        margin-top: 12px;
      }
    </style>
    <div class="tolerance-filtered-content">${escapeHTML(filteredText).replace(/\n/g, '<br>')}</div>
    <span class="tolerance-filter-badge">filtered by Tolerance</span>
  `;

  // Insert after original
  originalHTML.insertAdjacentElement('afterend', filtered);

  log('Replaced message with filtered version');
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHTML(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Process a completed response
 */
async function processResponse(messageElement: Element, sourceContainer?: Element): Promise<void> {
  if (!initialLoadComplete) {
    log('Initial load not complete, skipping');
    if (sourceContainer) clearStreamingSuppression(sourceContainer);
    return;
  }

  log('Processing NEW response...');
  isFiltering = true;

  // Show indicator
  const indicator = showFilteringIndicator(messageElement);

  try {
    // Extract text
    const originalText = extractMessageText(messageElement);
    log('Original text length:', originalText.length);

    if (originalText.length < 20) {
      log('Response too short, skipping filter');
      if (sourceContainer) clearStreamingSuppression(sourceContainer);
      return;
    }

    // Send to background for rewriting
    const response = await chrome.runtime.sendMessage({
      type: 'REWRITE_RESPONSE',
      text: originalText,
    }) as RewriteResponse;

    if (response?.rewritten && response.changed) {
      log('Got filtered response, length:', response.rewritten.length);
      if (sourceContainer) clearStreamingSuppression(sourceContainer);
      replaceWithFilteredContent(messageElement, response.rewritten);
    } else {
      log('Rewrite skipped or unchanged:', response?.skippedReason || 'unchanged');
      if (sourceContainer) clearStreamingSuppression(sourceContainer);
    }
  } catch (error) {
    log('Error filtering response:', error);
    if (sourceContainer) clearStreamingSuppression(sourceContainer);
  } finally {
    // Remove indicator
    indicator.remove();
    isFiltering = false;
  }
}

/**
 * Watch for streaming to complete
 */
let currentStreamingContainer: Element | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;

function startWatching(): void {
  if (checkInterval) return;

  log('Starting response watcher');

  checkInterval = setInterval(() => {
    // Find any container that is currently streaming
    const streamingContainer = document.querySelector('[data-is-streaming="true"]');

    if (streamingContainer && streamingContainer !== currentStreamingContainer) {
      // New streaming started
      currentStreamingContainer = streamingContainer;
      suppressStreamingContainer(streamingContainer);
      log('New response streaming detected');
    } else if (!streamingContainer && currentStreamingContainer) {
      // Streaming just completed
      log('Streaming completed, processing response');

      // Check if this container was already processed
      if (!processedMessages.has(currentStreamingContainer)) {
        const completedContainer = currentStreamingContainer;
        const message = getAssistantMessageFromContainer(completedContainer);
        if (message) {
          // Mark the container as processed
          processedMessages.add(completedContainer);
          processResponse(message, completedContainer);
        } else {
          clearStreamingSuppression(completedContainer);
        }
      } else {
        log('Container already processed, skipping');
        clearStreamingSuppression(currentStreamingContainer);
      }

      currentStreamingContainer = null;
    }
  }, 500); // Check every 500ms
}

/**
 * Send heartbeat for session tracking
 */
function sendHeartbeat(): void {
  if (document.visibilityState !== 'visible') {
    return;
  }

  try {
    chrome.runtime.sendMessage({ type: 'CLAUDE_HEARTBEAT' }, () => {
      if (chrome.runtime.lastError) {
        // Silent fail
      }
    });
  } catch {
    // Extension context invalidated
  }
}

/**
 * Initialize
 */
function init(): void {
  log('Initializing Claude filter');

  // Mark all existing streaming containers as already processed (don't filter on page load)
  const existingContainers = document.querySelectorAll('[data-is-streaming]');
  existingContainers.forEach(container => {
    processedMessages.add(container);
  });
  log(`Marked ${existingContainers.length} existing message containers as processed`);

  // After a short delay, mark initial load as complete
  setTimeout(() => {
    initialLoadComplete = true;
    log('Initial load complete, now watching for NEW responses only');
  }, 2000);

  // Start watching for responses
  startWatching();

  // MutationObserver watches for attribute changes on data-is-streaming
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Watch for data-is-streaming attribute changes
      if (mutation.type === 'attributes' && mutation.attributeName === 'data-is-streaming') {
        const target = mutation.target as Element;
        const isStreaming = target.getAttribute('data-is-streaming');

        if (isStreaming === 'true') {
          suppressStreamingContainer(target);
        } else if (isStreaming === 'false' && !processedMessages.has(target)) {
          log('MutationObserver: streaming completed on container');
          processedMessages.add(target);
          if (target === currentStreamingContainer) {
            currentStreamingContainer = null;
          }

          // Small delay to ensure DOM is fully updated
          setTimeout(() => {
            const message = getAssistantMessageFromContainer(target);
            if (message) {
              processResponse(message, target);
            } else {
              clearStreamingSuppression(target);
            }
          }, 100);
        }
      }
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-is-streaming'],
    subtree: true,
  });

  // Start heartbeat
  sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

  // Track visibility changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sendHeartbeat();
    }
  });

  log('Claude filter initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
