import { openDB, type IDBPDatabase } from 'idb';

// Where API keys live.
//
// They used to sit inside the `settings` object in chrome.storage.local. Content
// scripts can read that storage directly, and the whole settings object was also sent
// to every content script on Reddit, X, YouTube, Instagram and Facebook, so each key
// was readable from inside every one of those pages' processes. None of them needs a
// key: only the background makes API calls.
//
// Keys are now kept in a small database of their own. A database belongs to the
// extension's origin, which the background, the dashboard and the popup share and a
// content script (running in the site's page) does not. Nothing here is ever put in a
// message to a content script.

export interface ProvisionedKey {
  apiKey: string;
  monthlyLimit: number;
  variant?: string;
  provisionedAt: number;
}

export interface Secrets {
  openRouterApiKey?: string;        // The person's own OpenRouter key
  customApiKey?: string;            // Key for a custom OpenAI-compatible endpoint
  rescueTimeApiKey?: string;
  provisionedKey?: ProvisionedKey;  // Free-tier key issued to this install
}

const DB_NAME = 'tolerance-secrets';
const STORE = 'kv';
const RECORD = 'secrets';

let dbPromise: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, { upgrade(d) { d.createObjectStore(STORE); } });
  }
  return dbPromise;
}

// The keys as stored before, inside chrome.storage.local
interface LegacySettings {
  openRouterApiKey?: string;
  rescueTimeApiKey?: string;
  apiProvider?: { apiKey?: string };
}

// Move any keys still in chrome.storage.local into the database, then remove them from
// there. Safe to run any number of times and from several pages at once: a key is only
// removed from the old place after it has been read back from the new one.
type LegacyStore = { settings?: LegacySettings; provisionedKey?: ProvisionedKey };

async function readLegacy(): Promise<{ stored: LegacyStore; legacy: Secrets }> {
  const stored: LegacyStore = (await chrome.storage.local.get<LegacyStore>(['settings', 'provisionedKey'])) ?? {};
  const settings = stored.settings;
  return {
    stored,
    legacy: {
      openRouterApiKey: settings?.openRouterApiKey || undefined,
      customApiKey: settings?.apiProvider?.apiKey || undefined,
      rescueTimeApiKey: settings?.rescueTimeApiKey || undefined,
      provisionedKey: stored.provisionedKey?.apiKey ? stored.provisionedKey : undefined,
    },
  };
}

export async function migrateSecrets(): Promise<void> {
  const { stored, legacy } = await readLegacy();
  const settings = stored.settings;
  const found = (Object.keys(legacy) as (keyof Secrets)[]).filter(k => legacy[k] !== undefined);
  if (found.length === 0) return;

  const d = await db();
  const tx = d.transaction(STORE, 'readwrite');
  const current: Secrets = (await tx.store.get(RECORD)) ?? {};
  // A key already in the database is newer than a leftover in the old place
  const merged: Secrets = { ...legacy, ...current };
  await tx.store.put(merged, RECORD);
  await tx.done;

  const saved: Secrets = (await d.get(STORE, RECORD)) ?? {};
  if (found.some(k => saved[k] === undefined)) return;   // not safely stored: leave the old copy alone

  if (settings && (settings.openRouterApiKey !== undefined || settings.rescueTimeApiKey !== undefined || settings.apiProvider?.apiKey !== undefined)) {
    const cleaned: LegacySettings = { ...settings };
    delete cleaned.openRouterApiKey;
    delete cleaned.rescueTimeApiKey;
    if (cleaned.apiProvider) {
      cleaned.apiProvider = { ...cleaned.apiProvider };
      delete cleaned.apiProvider.apiKey;
    }
    await chrome.storage.local.set({ settings: cleaned });
  }
  if (stored.provisionedKey) await chrome.storage.local.remove('provisionedKey');
}

let migrated: Promise<void> | null = null;
function ready(): Promise<void> {
  if (!migrated) {
    migrated = migrateSecrets().catch(e => {
      migrated = null;   // try again on the next read
      console.warn('Tolerance: could not move API keys to their own store', e);
    });
  }
  return migrated;
}

export async function getSecrets(): Promise<Secrets> {
  await ready();
  try {
    return (await (await db()).get(STORE, RECORD)) ?? {};
  } catch (e) {
    // The database can't be opened (some private-browsing modes). Keys that could not
    // be moved are still in the old place; use them from there so scoring keeps working.
    dbPromise = null;
    return (await readLegacy()).legacy;
  }
}

// Change some keys, leaving the rest. A value of undefined or '' removes that key.
export async function setSecrets(change: Partial<Secrets>): Promise<void> {
  await ready();
  const tx = (await db()).transaction(STORE, 'readwrite');
  const next: Secrets = { ...((await tx.store.get(RECORD)) ?? {}) };
  for (const key of Object.keys(change) as (keyof Secrets)[]) {
    const value = change[key];
    if (value === undefined || value === '') delete next[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  await tx.store.put(next, RECORD);
  await tx.done;
}

// A settings object with any key fields removed, for anything that leaves the
// background. Keys should no longer be in settings at all; this is the backstop.
export function withoutSecrets<T extends object>(settings: T): T {
  const copy = { ...settings } as T & LegacySettings;
  delete copy.openRouterApiKey;
  delete copy.rescueTimeApiKey;
  if (copy.apiProvider && 'apiKey' in copy.apiProvider) {
    copy.apiProvider = { ...copy.apiProvider };
    delete copy.apiProvider.apiKey;
  }
  return copy;
}
