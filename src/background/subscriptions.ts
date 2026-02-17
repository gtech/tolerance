import { SubscriptionList, DEFAULT_SUBSCRIPTION_LIST } from '../shared/types';
import { log } from '../shared/constants';

const STORAGE_KEY = 'subscriptionList';
const ALARM_NAME = 'sync-subscriptions';
const SYNC_INTERVAL_MINUTES = 1440; // 24 hours

// Cached subscription list to avoid repeated storage reads during scoring
let cachedList: SubscriptionList | null = null;
let cacheTime = 0;
const CACHE_TTL = 60000; // 1 minute

/**
 * Get the stored subscription list from chrome.storage.local.
 * Uses a short-lived cache to avoid repeated storage reads during scoring batches.
 */
export async function getSubscriptionList(): Promise<SubscriptionList> {
  const now = Date.now();
  if (cachedList && now - cacheTime < CACHE_TTL) {
    return cachedList;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY);
  cachedList = result[STORAGE_KEY] ?? { ...DEFAULT_SUBSCRIPTION_LIST };
  cacheTime = now;
  return cachedList;
}

/**
 * Check if a source is in the subscription list for a given platform.
 * Uses same normalization logic as isWhitelisted (lowercase, strip @/u/ prefix).
 */
export function isSubscribed(
  sourceId: string,
  platform: 'reddit' | 'twitter' | 'instagram' | 'youtube',
  subscriptionList: SubscriptionList
): boolean {
  const list = subscriptionList[platform];
  if (!list || list.length === 0) return false;

  const normalizedSource = sourceId.toLowerCase().replace(/^[@u/]+/, '');
  return list.includes(normalizedSource);
}

/**
 * Sync YouTube subscriptions by fetching the /feed/channels page.
 * The background service worker has host permissions and cookies are sent automatically.
 * Returns the list of subscribed channel handles.
 */
export async function syncYouTubeSubscriptions(): Promise<string[]> {
  log.info('Syncing YouTube subscriptions...');

  try {
    const response = await fetch('https://www.youtube.com/feed/channels', {
      credentials: 'include',
    });

    if (!response.ok) {
      log.error(`YouTube subscriptions fetch failed: HTTP ${response.status}`);
      return [];
    }

    const html = await response.text();

    // Extract ytInitialData JSON from the HTML
    const match = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!match) {
      log.error('Could not find ytInitialData in YouTube channels page');
      return [];
    }

    let ytData: unknown;
    try {
      ytData = JSON.parse(match[1]);
    } catch (e) {
      log.error('Failed to parse ytInitialData JSON:', e);
      return [];
    }

    // Walk the JSON tree to find channelRenderer objects
    const handles = extractChannelHandles(ytData);

    log.info(`Found ${handles.length} YouTube subscriptions`);

    // Store in chrome.storage.local
    const currentList = await getSubscriptionList();
    const updatedList: SubscriptionList = {
      ...currentList,
      youtube: handles,
      lastSynced: {
        ...currentList.lastSynced,
        youtube: Date.now(),
      },
    };

    await chrome.storage.local.set({ [STORAGE_KEY]: updatedList });

    // Invalidate cache
    cachedList = updatedList;
    cacheTime = Date.now();

    return handles;
  } catch (error) {
    log.error('YouTube subscription sync failed:', error);
    return [];
  }
}

/**
 * Walk ytInitialData to find all channelRenderer objects and extract handles.
 * Path: ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[].tabRenderer
 *   .content.sectionListRenderer.contents[].itemSectionRenderer
 *     .contents[].shelfRenderer.content.expandedShelfContentsRenderer
 *       .items[].channelRenderer
 */
function extractChannelHandles(data: unknown): string[] {
  const handles: string[] = [];

  // Use a recursive approach to find all channelRenderer objects
  // This is more robust than hardcoding the exact path
  function walk(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        walk(item);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // Check if this is a channelRenderer
    if (record.channelRenderer) {
      const renderer = record.channelRenderer as Record<string, unknown>;
      const navEndpoint = renderer.navigationEndpoint as Record<string, unknown> | undefined;
      const browseEndpoint = navEndpoint?.browseEndpoint as Record<string, unknown> | undefined;
      const canonicalBaseUrl = browseEndpoint?.canonicalBaseUrl as string | undefined;

      if (canonicalBaseUrl) {
        // canonicalBaseUrl is like "/@MichaelReeves" → normalize to "michaelreeves"
        const handle = canonicalBaseUrl.replace(/^\/@/, '').toLowerCase();
        if (handle) {
          handles.push(handle);
        }
      }
    }

    // Recurse into all values
    for (const value of Object.values(record)) {
      walk(value);
    }
  }

  walk(data);
  return handles;
}

/**
 * Schedule daily subscription sync via chrome.alarms.
 * Should be called when subscriptionsOnly is enabled.
 */
export function scheduleSubscriptionSync(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  log.debug('Subscription sync alarm scheduled (daily)');
}

/**
 * Cancel the subscription sync alarm.
 * Should be called when subscriptionsOnly is disabled.
 */
export function cancelSubscriptionSync(): void {
  chrome.alarms.clear(ALARM_NAME);
  log.debug('Subscription sync alarm cancelled');
}

/**
 * Handle the sync-subscriptions alarm.
 * Returns true if this alarm was handled.
 */
export async function handleSyncAlarm(alarmName: string): Promise<boolean> {
  if (alarmName !== ALARM_NAME) return false;
  await syncYouTubeSubscriptions();
  return true;
}
