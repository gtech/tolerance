import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// API keys live in their own database, out of the settings object that every content
// script can read. These cover the one-time move and the rule that a key is never lost
// on the way.

let local: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  local = {};
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter(k => k in local).map(k => [k, local[k]])),
        set: async (items: Record<string, unknown>) => { Object.assign(local, items); },
        remove: async (key: string) => { delete local[key]; },
      },
    },
  };
});

const load = () => import('../src/shared/secrets');

describe('moving keys out of the settings', () => {
  it('moves every key and removes it from the old place', async () => {
    local.settings = { apiTier: 'own-key', openRouterApiKey: 'or-key', rescueTimeApiKey: 'rt-key', apiProvider: { type: 'openai-compatible', endpoint: 'http://localhost:11434', apiKey: 'custom-key' }, qualityMode: true };
    local.provisionedKey = { apiKey: 'free-key', monthlyLimit: 0.02, provisionedAt: 1 };
    const { getSecrets } = await load();

    expect(await getSecrets()).toEqual({
      openRouterApiKey: 'or-key', rescueTimeApiKey: 'rt-key', customApiKey: 'custom-key',
      provisionedKey: { apiKey: 'free-key', monthlyLimit: 0.02, provisionedAt: 1 },
    });
    // Nothing key-like is left where a content script can read it, and the rest is untouched
    expect(local.settings).toEqual({ apiTier: 'own-key', apiProvider: { type: 'openai-compatible', endpoint: 'http://localhost:11434' }, qualityMode: true });
    expect('provisionedKey' in local).toBe(false);
    expect(JSON.stringify(local)).not.toMatch(/or-key|rt-key|custom-key|free-key/);
  });

  it('does nothing when there is nothing to move', async () => {
    local.settings = { apiTier: 'free', qualityMode: false };
    const before = JSON.stringify(local);
    const { getSecrets } = await load();
    expect(await getSecrets()).toEqual({});
    expect(JSON.stringify(local)).toBe(before);
  });

  it('keeps a key already in the store over a leftover in the settings', async () => {
    const first = await load();
    await first.setSecrets({ openRouterApiKey: 'newer' });
    local.settings = { openRouterApiKey: 'stale' };
    await first.migrateSecrets();
    expect((await first.getSecrets()).openRouterApiKey).toBe('newer');
    expect(local.settings).toEqual({});
  });

  it('survives the store being read from a second page', async () => {
    local.settings = { openRouterApiKey: 'or-key' };
    const background = await load();
    await background.getSecrets();
    vi.resetModules();   // the dashboard: same database, its own copy of the module
    const dashboard = await load();
    expect((await dashboard.getSecrets()).openRouterApiKey).toBe('or-key');
  });

  it('leaves the old copy in place if the key did not reach the store', async () => {
    local.settings = { openRouterApiKey: 'or-key' };
    // A database that cannot be opened
    (globalThis as Record<string, unknown>).indexedDB = { open: () => { throw new Error('blocked'); } };
    const { migrateSecrets } = await load();
    await expect(migrateSecrets()).rejects.toThrow();
    expect(local.settings).toEqual({ openRouterApiKey: 'or-key' });
  });
});

describe('setSecrets', () => {
  it('changes only the keys it is given', async () => {
    const { getSecrets, setSecrets } = await load();
    await setSecrets({ openRouterApiKey: 'a', rescueTimeApiKey: 'b' });
    await setSecrets({ openRouterApiKey: 'c' });
    expect(await getSecrets()).toEqual({ openRouterApiKey: 'c', rescueTimeApiKey: 'b' });
  });

  it('removes a key set to empty or undefined', async () => {
    const { getSecrets, setSecrets } = await load();
    await setSecrets({ openRouterApiKey: 'a', customApiKey: 'b', rescueTimeApiKey: 'c' });
    await setSecrets({ openRouterApiKey: '', customApiKey: undefined });
    expect(await getSecrets()).toEqual({ rescueTimeApiKey: 'c' });
  });
});

describe('withoutSecrets', () => {
  it('strips key fields from a settings object without changing the original', async () => {
    const { withoutSecrets } = await load();
    const settings = { apiTier: 'own-key', openRouterApiKey: 'x', rescueTimeApiKey: 'y', apiProvider: { type: 'openai-compatible', apiKey: 'z', endpoint: 'e' } };
    expect(withoutSecrets(settings)).toEqual({ apiTier: 'own-key', apiProvider: { type: 'openai-compatible', endpoint: 'e' } });
    expect(settings.openRouterApiKey).toBe('x');
    expect(settings.apiProvider.apiKey).toBe('z');
  });
});
