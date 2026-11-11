// Sites Tolerance asks for only when a feature that needs them is switched on in the
// dashboard. They are listed under optional_host_permissions in the manifest, so the
// install prompt names just the five feed sites.
//
// Two kinds:
//  - sites with a content script (claude.ai, TikTok): the script is registered at
//    runtime for as long as the browser grants the site
//  - addresses the background calls for scoring when you use your own provider
//    (OpenAI, a local model and so on): no script, only permission to send requests

export interface OptionalSite {
  id: string;          // also the id of the registered content script
  origins: string[];
  js: string[];
}

export const CLAUDE_SITE: OptionalSite = { id: 'claude-filter', origins: ['*://claude.ai/*'], js: ['claude-filter.js'] };
// Only counts time spent on TikTok towards the session; nothing on the page is read or changed
export const TIKTOK_SITE: OptionalSite = { id: 'tiktok-tracker', origins: ['*://www.tiktok.com/*'], js: ['tracker.js'] };
export const OPTIONAL_SITES = [CLAUDE_SITE, TIKTOK_SITE];

// Hosts of the providers a custom endpoint may point at. Must match the manifest.
export const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'api.groq.com',
  'api.together.xyz',
  'api.mistral.ai',
  'api.fireworks.ai',
  'api.perplexity.ai',
  'api.cohere.ai',
  'generativelanguage.googleapis.com',
  'api-inference.huggingface.co',
];
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

// The permission to ask for before calling a custom endpoint, or null when the address
// isn't one Tolerance can ask for (it is then called without special access, which
// works if that server accepts requests from browser extensions)
export function endpointAccessPattern(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (PROVIDER_HOSTS.includes(url.hostname)) return `*://${url.hostname}/*`;
  if (LOCAL_HOSTS.includes(url.hostname) && url.protocol === 'http:') return `http://${url.hostname}/*`;
  return null;
}

export function hasAccess(origins: string[]): Promise<boolean> {
  return chrome.permissions.contains({ origins });
}

// Shows the browser's permission prompt. Must be called straight from a click or
// change handler, before any await, or the browser refuses to show it.
export function requestAccess(origins: string[]): Promise<boolean> {
  return chrome.permissions.request({ origins }).catch(() => false);
}

export function removeAccess(origins: string[]): Promise<boolean> {
  return chrome.permissions.remove({ origins }).catch(() => false);
}

// Same rule as requestAccess. Resolves true when nothing needs asking.
export function requestEndpointAccess(endpoint: string): Promise<boolean> {
  const pattern = endpointAccessPattern(endpoint);
  return pattern ? requestAccess([pattern]) : Promise.resolve(true);
}

// Register each optional site's content script while the site is granted, unregister it otherwise
export async function syncOptionalScripts(): Promise<void> {
  const registered = new Set(
    (await chrome.scripting.getRegisteredContentScripts({ ids: OPTIONAL_SITES.map(s => s.id) })).map(s => s.id),
  );
  for (const site of OPTIONAL_SITES) {
    const granted = await hasAccess(site.origins);
    if (granted && !registered.has(site.id)) {
      await chrome.scripting.registerContentScripts([{
        id: site.id,
        matches: site.origins,
        js: site.js,
        runAt: 'document_idle',
        persistAcrossSessions: true,
      }]);
    } else if (!granted && registered.has(site.id)) {
      await chrome.scripting.unregisterContentScripts({ ids: [site.id] });
    }
  }
}
