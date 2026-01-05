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

// Track if we're currently filtering (to show indicator)
let isFiltering = false;

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
 * Get the latest assistant message element
 */
function getLatestAssistantMessage(): Element | null {
  // Claude.ai uses .font-claude-response for assistant messages
  // Find the last one that has completed streaming
  const allResponses = document.querySelectorAll('.font-claude-response');

  if (allResponses.length === 0) {
    log('No .font-claude-response elements found');
    return null;
  }

  // Get the last response element
  const lastResponse = allResponses[allResponses.length - 1];

  // Check if it's done streaming by looking at parent's data-is-streaming
  const streamingParent = lastResponse.closest('[data-is-streaming]');
  if (streamingParent?.getAttribute('data-is-streaming') === 'true') {
    log('Latest response is still streaming');
    return null;
  }

  log('Found assistant message (.font-claude-response)');
  return lastResponse;
}

/**
 * Extract text content from a message element (excluding CoT/thinking)
 */
function extractMessageText(element: Element): string {
  // Claude renders markdown in .standard-markdown or .progressive-markdown
  // The response has multiple .standard-markdown elements:
  // 1. Inside a collapsible (the "thinking" / CoT) - we want to SKIP this
  // 2. The actual response - we want THIS one

  // Find all markdown containers
  const allMarkdown = element.querySelectorAll('.standard-markdown, .progressive-markdown');

  // Find the response markdown (not inside the collapsible thinking section)
  // The thinking is inside an element with overflow-hidden and height: 0
  // The response is a more direct child
  let responseMarkdown: Element | null = null;

  for (const md of allMarkdown) {
    // Skip if inside a collapsed/collapsible container (the thinking section)
    const collapsible = md.closest('.overflow-hidden');
    const thinkingContainer = md.closest('[class*="ease-out"][class*="transition-all"][class*="flex-col"]');

    // If not inside a collapsible thinking section, this is likely the response
    if (!collapsible && !thinkingContainer) {
      responseMarkdown = md;
      break;
    }
  }

  // If we didn't find one outside collapsibles, use the last one (usually the response)
  if (!responseMarkdown && allMarkdown.length > 0) {
    responseMarkdown = allMarkdown[allMarkdown.length - 1];
  }

  if (responseMarkdown) {
    // Get text from paragraphs, preserving structure
    const paragraphs = responseMarkdown.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6');
    if (paragraphs.length > 0) {
      const texts: string[] = [];
      paragraphs.forEach(p => {
        const text = p.textContent?.trim();
        if (text) texts.push(text);
      });
      log(`Extracted ${texts.length} paragraphs from response`);
      return texts.join('\n\n');
    }
  }

  // Fallback: get all text content
  const textContent = element.textContent || '';
  return textContent.trim();
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
async function processResponse(messageElement: Element): Promise<void> {
  if (processedMessages.has(messageElement)) {
    return;
  }
  processedMessages.add(messageElement);

  log('Processing response...');
  isFiltering = true;

  // Show indicator
  const indicator = showFilteringIndicator(messageElement);

  try {
    // Extract text
    const originalText = extractMessageText(messageElement);
    log('Original text length:', originalText.length);

    if (originalText.length < 20) {
      log('Response too short, skipping filter');
      return;
    }

    // Send to background for rewriting
    const response = await chrome.runtime.sendMessage({
      type: 'REWRITE_RESPONSE',
      text: originalText,
    });

    if (response?.rewritten) {
      log('Got filtered response, length:', response.rewritten.length);
      replaceWithFilteredContent(messageElement, response.rewritten);
    } else {
      log('No filtered response received:', response);
    }
  } catch (error) {
    log('Error filtering response:', error);
  } finally {
    // Remove indicator
    indicator.remove();
    isFiltering = false;
  }
}

/**
 * Watch for streaming to complete
 */
let wasStreaming = false;
let checkInterval: ReturnType<typeof setInterval> | null = null;

function startWatching(): void {
  if (checkInterval) return;

  log('Starting response watcher');

  checkInterval = setInterval(() => {
    const currentlyStreaming = isStreaming();

    // Detect transition from streaming to not streaming
    if (wasStreaming && !currentlyStreaming) {
      log('Streaming completed, processing response');
      const message = getLatestAssistantMessage();
      if (message) {
        processResponse(message);
      }
    }

    wasStreaming = currentlyStreaming;
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

  // Start watching for responses
  startWatching();

  // Also use MutationObserver for more reliable detection
  const observer = new MutationObserver((mutations) => {
    // Look for new assistant messages being added
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          // Check if this or a child is an assistant message (.font-claude-response)
          const assistantMsg =
            node.matches?.('.font-claude-response')
              ? node
              : node.querySelector?.('.font-claude-response');

          if (assistantMsg && !processedMessages.has(assistantMsg)) {
            // Wait a bit for streaming to complete
            setTimeout(() => {
              if (!isStreaming()) {
                processResponse(assistantMsg);
              }
            }, 1000);
          }
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
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
