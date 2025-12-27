// Free tier API key provisioning
// Provisions a unique API key per extension install from the backend

import { log } from '../shared/constants';

const API_BASE = 'https://api.tolerance.lol';

interface ProvisionedKey {
  apiKey: string;
  monthlyLimit: number;
  variant?: string;
  provisionedAt: number;
}

// Generate a stable install ID (persisted across sessions)
async function getOrCreateInstallId(): Promise<string> {
  const result = await chrome.storage.local.get('installId');
  if (result.installId) {
    return result.installId;
  }

  // Generate a UUID-like install ID (with fallback for older browsers)
  const installId = crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ installId });
  log.debug(` Generated new install ID: ${installId}`);
  return installId;
}

// Provision a free tier API key from the backend
// Returns cached key if available, otherwise provisions new one
export async function provisionFreeKey(forceLog = false): Promise<ProvisionedKey | null> {
  try {
    const installId = await getOrCreateInstallId();

    // Check if we already have a provisioned key
    const cached = await getProvisionedKey();
    if (cached) {
      if (forceLog) {
        log.debug(` Using cached provisioned key (provisioned ${new Date(cached.provisionedAt).toLocaleDateString()})`);
      }
      return cached;
    }

    log.debug(` Provisioning free tier key for install: ${installId.slice(0, 8)}...`);

    const response = await fetch(`${API_BASE}/api/free/provision-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ installId }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Tolerance: Failed to provision key:', response.status, error);
      return null;
    }

    const data = await response.json();

    const provisioned: ProvisionedKey = {
      apiKey: data.apiKey,
      monthlyLimit: data.monthlyLimit,
      variant: data.variant,
      provisionedAt: Date.now(),
    };

    // Cache the provisioned key
    await chrome.storage.local.set({ provisionedKey: provisioned });
    log.debug(` Provisioned free tier key (limit: $${data.monthlyLimit}/month, variant: ${data.variant || 'default'})`);

    return provisioned;
  } catch (error) {
    console.error('Tolerance: Key provisioning failed:', error);
    return null;
  }
}

// Get cached provisioned key (if any)
export async function getProvisionedKey(): Promise<ProvisionedKey | null> {
  const result = await chrome.storage.local.get('provisionedKey');
  return result.provisionedKey || null;
}

// Clear provisioned key (for testing or re-provisioning)
export async function clearProvisionedKey(): Promise<void> {
  await chrome.storage.local.remove('provisionedKey');
  log.debug(` Cleared provisioned key`);
}

// Get the free tier API key (provisions if needed)
export async function getFreeTierApiKey(): Promise<string | null> {
  // Try cached key first
  const cached = await getProvisionedKey();
  if (cached?.apiKey) {
    return cached.apiKey;
  }

  // Provision new key
  const provisioned = await provisionFreeKey();
  return provisioned?.apiKey || null;
}

// Get install ID (for display/debugging)
export async function getInstallId(): Promise<string> {
  return getOrCreateInstallId();
}
