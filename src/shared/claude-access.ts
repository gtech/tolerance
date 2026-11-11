// claude.ai is an optional site: Tolerance only asks for it when a Claude feature is
// switched on in the dashboard, and gives it back when they are all switched off.
// The content script is registered at runtime for as long as the access is held,
// so installing Tolerance does not mention claude.ai at all.

export const CLAUDE_ORIGINS = ['*://claude.ai/*'];
const CLAUDE_SCRIPT_ID = 'claude-filter';

// Whether any Claude feature is switched on
export function claudeFeaturesOn(settings: { claudeFilterEnabled?: boolean; claudeFilterHideWhileStreaming?: boolean }): boolean {
  return !!(settings.claudeFilterEnabled || settings.claudeFilterHideWhileStreaming);
}

export function hasClaudeAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: CLAUDE_ORIGINS });
}

// Shows the browser's permission prompt. Must be called straight from a click or
// change handler, before any await, or the browser refuses to show it.
export function requestClaudeAccess(): Promise<boolean> {
  return chrome.permissions.request({ origins: CLAUDE_ORIGINS }).catch(() => false);
}

export function removeClaudeAccess(): Promise<boolean> {
  return chrome.permissions.remove({ origins: CLAUDE_ORIGINS }).catch(() => false);
}

// Register the claude.ai content script while access is held, unregister it otherwise
export async function syncClaudeScript(): Promise<void> {
  const [granted, registered] = await Promise.all([
    hasClaudeAccess(),
    chrome.scripting.getRegisteredContentScripts({ ids: [CLAUDE_SCRIPT_ID] }).then(s => s.length > 0),
  ]);
  if (granted && !registered) {
    await chrome.scripting.registerContentScripts([{
      id: CLAUDE_SCRIPT_ID,
      matches: CLAUDE_ORIGINS,
      js: ['claude-filter.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } else if (!granted && registered) {
    await chrome.scripting.unregisterContentScripts({ ids: [CLAUDE_SCRIPT_ID] });
  }
}
