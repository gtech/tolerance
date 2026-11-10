import type { Settings } from '../shared/types';
import { tallyPosts, type HealthPlatform } from '../shared/scrape-health';

// Feeds the scraper health check (see shared/scrape-health.ts) from a content script.
// Off unless the developer setting is on, so normal use sends nothing extra.

let enabled = false;

function send(platform: HealthPlatform, delta: { loads?: number; posts?: number; fields?: Record<string, { seen: number; found: number }> }): void {
  try {
    chrome.runtime.sendMessage({ type: 'SCRAPE_HEALTH', platform, ...delta }, () => void chrome.runtime.lastError);
  } catch {
    // The extension was reloaded under this page; nothing to report to
  }
}

// Call when settings are loaded, on a page where the scraper is expected to find posts
export function startScrapeHealth(platform: HealthPlatform, settings: Settings | null, isFeedPage: boolean): void {
  enabled = settings?.scrapeHealthCheck === true;
  if (enabled && isFeedPage) send(platform, { loads: 1 });
}

// Call once for each batch of posts the scraper has newly found
export function reportScraped(platform: HealthPlatform, posts: object[]): void {
  if (!enabled || posts.length === 0) return;
  send(platform, tallyPosts(platform, posts as Record<string, unknown>[]));
}
