/**
 * Response Rewriter
 *
 * Takes Claude responses and rewrites them through a second model to:
 * 1. Strip excessive praise/sycophancy
 * 2. Add time-based break suggestions
 */

import { getSettings } from './storage';
import { getFreeTierApiKey } from './provisioning';
import { log } from '../shared/constants';

// Claude session tracking
interface ClaudeSession {
  totalMinutes: number;
  messageCount: number;
  lastHeartbeat: number;
  resetDate: string;
}

const CLAUDE_SESSION_KEY = 'claudeSession';
const HEARTBEAT_GAP_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Get or initialize Claude session
 */
export async function getClaudeSession(): Promise<ClaudeSession> {
  const result = await chrome.storage.local.get(CLAUDE_SESSION_KEY);
  const today = new Date().toISOString().split('T')[0];

  let session: ClaudeSession = result[CLAUDE_SESSION_KEY] || {
    totalMinutes: 0,
    messageCount: 0,
    lastHeartbeat: 0,
    resetDate: today,
  };

  // Reset if new day
  if (session.resetDate !== today) {
    session = {
      totalMinutes: 0,
      messageCount: 0,
      lastHeartbeat: Date.now(),
      resetDate: today,
    };
    await chrome.storage.local.set({ [CLAUDE_SESSION_KEY]: session });
  }

  return session;
}

/**
 * Record a heartbeat from Claude tab
 */
export async function recordClaudeHeartbeat(): Promise<void> {
  const session = await getClaudeSession();
  const now = Date.now();
  const timeSinceLastBeat = now - session.lastHeartbeat;

  // Only add time if heartbeats are continuous
  if (session.lastHeartbeat > 0 && timeSinceLastBeat <= HEARTBEAT_GAP_THRESHOLD_MS) {
    const minutesToAdd = timeSinceLastBeat / (60 * 1000);
    session.totalMinutes += minutesToAdd;
  }

  session.lastHeartbeat = now;
  await chrome.storage.local.set({ [CLAUDE_SESSION_KEY]: session });

  log.debug(`Claude session: ${session.totalMinutes.toFixed(1)} minutes`);
}

/**
 * Increment message count
 */
export async function incrementClaudeMessageCount(): Promise<void> {
  const session = await getClaudeSession();
  session.messageCount++;
  await chrome.storage.local.set({ [CLAUDE_SESSION_KEY]: session });
}

/**
 * Build the rewriting prompt based on session state
 */
function buildRewritePrompt(minutes: number): string {
  const baseRules = `You are a filter that rewrites AI assistant responses.

Your job is to make responses more neutral and less sycophantic while preserving all substantive content.

Rules:
1. Remove excessive praise ("Great question!", "Excellent thinking!", "You're absolutely right!", "That's a wonderful point!")
2. Remove sycophantic hedging ("I completely agree", "I love that idea", "What an insightful observation")
3. Remove unnecessary enthusiasm markers
4. Keep ALL substantive content, code, explanations, and facts exactly as they are
5. Keep the response helpful and clear, just more neutral in tone
6. Do NOT add your own commentary or meta-text about the rewriting`;

  let timeRules = '';

  if (minutes > 30 && minutes <= 60) {
    timeRules = `
7. At the very end, add a brief, natural one-liner like: "This has been a good session. Remember to take a break when you need one."`;
  } else if (minutes > 60 && minutes <= 90) {
    timeRules = `
7. At the very end, add a gentle suggestion like: "You've been at this for a while. Might be worth stepping away to let things settle before continuing."`;
  } else if (minutes > 90) {
    timeRules = `
7. At the very end, add a direct suggestion like: "You've been here over 90 minutes. Consider wrapping up this session and coming back fresh."`;
  }

  return baseRules + timeRules + `

Return ONLY the rewritten response text. Do not include any preamble, explanation, or wrapper text.`;
}

/**
 * Rewrite a Claude response
 */
export async function rewriteResponse(text: string): Promise<string> {
  const settings = await getSettings();
  const session = await getClaudeSession();

  // Check if filter is enabled
  if (!settings.claudeFilterEnabled) {
    log.info('Claude filter disabled, returning original (enable in Dashboard → Advanced Settings)');
    return text;
  }

  // Get API key - use own key if available, otherwise free tier
  let apiKey: string | undefined;
  if (settings.apiTier === 'own-key' && settings.openRouterApiKey) {
    apiKey = settings.openRouterApiKey;
    log.debug('Using own API key for Claude filter');
  } else {
    apiKey = await getFreeTierApiKey();
    log.debug('Using free tier API key for Claude filter');
  }

  if (!apiKey) {
    log.info('No API key available for Claude filter, returning original');
    return text;
  }

  log.info(`Claude filter: rewriting ${text.length} chars (session: ${session.totalMinutes.toFixed(0)} min)`);

  // Build prompt based on session time
  const systemPrompt = buildRewritePrompt(session.totalMinutes);

  log.debug(`Rewriting response (${session.totalMinutes.toFixed(0)} min session)`);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tolerance.lol',
        'X-Title': 'Tolerance Claude Filter',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', // Better output quality
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.3, // Low temperature for consistent rewriting
        max_tokens: Math.min(text.length * 2, 4000), // Allow for some expansion
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error('Rewrite API error:', response.status, errorText);
      return text; // Return original on error
    }

    const data = await response.json();
    const rewritten = data.choices?.[0]?.message?.content;

    if (!rewritten) {
      log.error('No content in rewrite response');
      return text;
    }

    // Increment message count
    await incrementClaudeMessageCount();

    log.debug('Rewrite successful');
    return rewritten.trim();
  } catch (error) {
    log.error('Rewrite fetch error:', error);
    return text; // Return original on error
  }
}
