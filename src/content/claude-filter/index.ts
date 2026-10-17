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

interface FilterStatus {
  willRewrite: boolean;
  hideWhileStreaming: boolean;
}

interface Replacement {
  container: Element;
  filtered: HTMLElement;
}

const suppressedContainers = new WeakMap<Element, SuppressionState>();

// Filter status fetched when a response starts streaming, reused when it finishes
const containerStatus = new WeakMap<Element, Promise<FilterStatus>>();

// Responses we've replaced; claude.ai re-renders messages, so the swap is re-applied when it does
const replacements: Replacement[] = [];

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
 * Convert a rendered markdown block back to Markdown, keeping code blocks and lists
 */
function blockToMarkdown(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || '').trim();
  if (/^h[1-6]$/.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${text}`;
  if (tag === 'pre') {
    const lang = el.querySelector('code')?.className.match(/language-(\S+)/)?.[1] ?? '';
    return '```' + lang + '\n' + (el.querySelector('code')?.textContent ?? el.textContent ?? '').replace(/\n$/, '') + '\n```';
  }
  if (tag === 'ul' || tag === 'ol') {
    return Array.from(el.children)
      .filter(li => li.tagName === 'LI')
      .map((li, i) => `${tag === 'ol' ? `${i + 1}.` : '-'} ${(li.textContent || '').trim()}`)
      .join('\n');
  }
  if (tag === 'blockquote') return text.split('\n').map(l => `> ${l}`).join('\n');
  if (tag === 'table') {
    const rows = Array.from(el.querySelectorAll('tr')).map(tr =>
      '| ' + Array.from(tr.children).map(c => (c.textContent || '').trim()).join(' | ') + ' |');
    if (rows.length > 1) rows.splice(1, 0, rows[0].replace(/[^|]+/g, ' --- '));
    return rows.join('\n');
  }
  // Code blocks are often wrapped in divs (copy button, language label)
  const pre = el.querySelector('pre');
  if (pre && tag !== 'p') return blockToMarkdown(pre);
  return text;
}

/**
 * Extract the response as Markdown (excluding CoT/thinking)
 */
function extractMessageText(element: Element): string {
  // The CoT is inside div.ease-out.transition-all.flex-col; responses with tool use have several markdown blocks
  const allMarkdown = Array.from(element.querySelectorAll('.standard-markdown, .progressive-markdown'))
    .filter(md => !isInsideCoT(md, element));
  log(`Found ${allMarkdown.length} response markdown containers`);

  const blocks: string[] = [];
  for (const md of allMarkdown) {
    for (const child of Array.from(md.children)) {
      const block = blockToMarkdown(child);
      if (block) blocks.push(block);
    }
  }
  return blocks.join('\n\n');
}

function getFilterStatus(container: Element): Promise<FilterStatus> {
  let status = containerStatus.get(container);
  if (!status) {
    status = (chrome.runtime.sendMessage({ type: 'CLAUDE_FILTER_STATUS' }) as Promise<FilterStatus>)
      .then(s => s ?? { willRewrite: false, hideWhileStreaming: false })
      .catch(() => ({ willRewrite: false, hideWhileStreaming: false }));
    containerStatus.set(container, status);
  }
  return status;
}

/**
 * A response started streaming: hide it only if it will be rewritten and the user wants it hidden
 */
function onStreamStart(container: Element): void {
  if (!initialLoadComplete) return;
  getFilterStatus(container).then(status => {
    if (status.willRewrite && status.hideWhileStreaming && container.getAttribute('data-is-streaming') === 'true') {
      suppressStreamingContainer(container);
    }
  });
}

/**
 * A response finished streaming: rewrite it if the filter is active
 */
function onStreamEnd(container: Element): void {
  processedMessages.add(container);
  getFilterStatus(container).then(status => {
    const message = getAssistantMessageFromContainer(container);
    if (status.willRewrite && message) {
      processResponse(message, container);
    } else {
      clearStreamingSuppression(container);
    }
  });
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
 * Minimal Markdown renderer for the rewritten text: code blocks, headings, lists, quotes, inline code and bold
 */
function renderMarkdown(md: string): string {
  const inline = (t: string) => escapeHTML(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const out: string[] = [];
  const parts = md.split(/^```/m);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      out.push(`<pre><code>${escapeHTML(nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n\s*\n/)) {
      const lines = block.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;
      const heading = lines[0].match(/^(#{1,6})\s+(.*)/);
      if (heading && lines.length === 1) {
        out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      } else if (lines.every(l => /^\s*([-*]|\d+\.)\s+/.test(l))) {
        const ordered = /^\s*\d+\./.test(lines[0]);
        const items = lines.map(l => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('');
        out.push(ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`);
      } else if (lines.every(l => l.startsWith('>'))) {
        out.push(`<blockquote>${lines.map(l => inline(l.replace(/^>\s?/, ''))).join('<br>')}</blockquote>`);
      } else {
        out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    }
  });
  return out.join('');
}

/**
 * Hide original message and show filtered version
 */
function replaceWithFilteredContent(
  originalElement: Element,
  filteredText: string,
  container: Element
): void {
  // Hide original, inject our rendered version
  (originalElement as HTMLElement).style.display = 'none';

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
      .tolerance-filtered-message p,
      .tolerance-filtered-message ul,
      .tolerance-filtered-message ol,
      .tolerance-filtered-message pre,
      .tolerance-filtered-message blockquote {
        margin-bottom: 1em;
      }
      .tolerance-filtered-message ul { list-style: disc; padding-left: 1.5em; }
      .tolerance-filtered-message ol { list-style: decimal; padding-left: 1.5em; }
      .tolerance-filtered-message h1, .tolerance-filtered-message h2, .tolerance-filtered-message h3 {
        font-weight: 600;
        margin: 1em 0 0.5em;
      }
      .tolerance-filtered-message pre {
        padding: 12px;
        border-radius: 6px;
        background: rgba(127, 127, 127, 0.12);
        overflow-x: auto;
        white-space: pre;
      }
      .tolerance-filtered-message code { font-family: ui-monospace, monospace; font-size: 0.9em; }
      .tolerance-filtered-message blockquote { border-left: 3px solid rgba(127, 127, 127, 0.4); padding-left: 12px; }
      .tolerance-filter-badge {
        display: inline-block;
        background: rgba(125, 206, 160, 0.2);
        color: #7dcea0;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        margin-top: 12px;
        cursor: pointer;
      }
    </style>
    <div class="tolerance-filtered-content">${renderMarkdown(filteredText)}</div>
    <span class="tolerance-filter-badge" title="Click to show the original">filtered by Tolerance</span>
  `;

  // Click the badge to flip between the rewrite and the original
  const badge = filtered.querySelector<HTMLElement>('.tolerance-filter-badge')!;
  const content = filtered.querySelector<HTMLElement>('.tolerance-filtered-content')!;
  badge.addEventListener('click', () => {
    const showingOriginal = filtered.dataset.showOriginal === 'true';
    filtered.dataset.showOriginal = showingOriginal ? 'false' : 'true';
    content.style.display = showingOriginal ? '' : 'none';
    badge.textContent = showingOriginal ? 'filtered by Tolerance' : 'original (click for filtered)';
    enforceReplacements();
  });

  originalElement.insertAdjacentElement('afterend', filtered);
  replacements.push({ container, filtered });

  log('Replaced message with filtered version');
}

/**
 * Re-apply replacements that claude.ai's re-renders undid (original shown again, or our node dropped)
 */
function enforceReplacements(): void {
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { container, filtered } = replacements[i];
    if (!container.isConnected) {
      replacements.splice(i, 1);
      continue;
    }
    const message = getAssistantMessageFromContainer(container) as HTMLElement | null;
    if (!message) continue;
    const showOriginal = filtered.dataset.showOriginal === 'true';
    message.style.display = showOriginal ? '' : 'none';
    if (message.nextElementSibling !== filtered) {
      message.insertAdjacentElement('afterend', filtered);
      log('Re-applied filtered response after re-render');
    }
  }
}

/**
 * Show a small note when a rewrite was attempted but failed, so a missing rewrite isn't silent
 */
function showSkipNote(messageElement: Element, reason: string): void {
  const note = document.createElement('div');
  note.className = 'tolerance-filter-note';
  note.textContent = `Tolerance: not rewritten (${reason})`;
  note.style.cssText = 'font-size: 11px; color: #888; margin-top: 8px;';
  messageElement.insertAdjacentElement('afterend', note);
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
async function processResponse(messageElement: Element, sourceContainer: Element): Promise<void> {
  if (!initialLoadComplete) {
    log('Initial load not complete, skipping');
    clearStreamingSuppression(sourceContainer);
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
      clearStreamingSuppression(sourceContainer);
      return;
    }

    // Send to background for rewriting
    const response = await chrome.runtime.sendMessage({
      type: 'REWRITE_RESPONSE',
      text: originalText,
    }) as RewriteResponse;

    if (response?.rewritten && response.changed) {
      log('Got filtered response, length:', response.rewritten.length);
      clearStreamingSuppression(sourceContainer);
      replaceWithFilteredContent(messageElement, response.rewritten, sourceContainer);
    } else {
      const reason = response?.skippedReason;
      log('Rewrite skipped or unchanged:', reason || 'unchanged');
      clearStreamingSuppression(sourceContainer);
      if (reason && reason !== 'disabled' && reason !== 'below-threshold') showSkipNote(messageElement, reason);
    }
  } catch (error) {
    log('Error filtering response:', error);
    clearStreamingSuppression(sourceContainer);
    showSkipNote(messageElement, 'extension error');
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
    enforceReplacements();

    // Find any container that is currently streaming
    const streamingContainer = document.querySelector('[data-is-streaming="true"]');

    if (streamingContainer && streamingContainer !== currentStreamingContainer) {
      // New streaming started
      currentStreamingContainer = streamingContainer;
      onStreamStart(streamingContainer);
      log('New response streaming detected');
    } else if (!streamingContainer && currentStreamingContainer) {
      // Streaming just completed
      log('Streaming completed, processing response');

      if (!processedMessages.has(currentStreamingContainer)) {
        onStreamEnd(currentStreamingContainer);
      } else {
        log('Container already processed, skipping');
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
          onStreamStart(target);
        } else if (isStreaming === 'false' && !processedMessages.has(target)) {
          log('MutationObserver: streaming completed on container');
          processedMessages.add(target);
          if (target === currentStreamingContainer) {
            currentStreamingContainer = null;
          }

          // Small delay to ensure DOM is fully updated
          setTimeout(() => onStreamEnd(target), 100);
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
