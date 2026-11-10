// Opt-in to the daily usage-totals research poll.
// The choice is kept locally and sent to api.tolerance.lol, which only records
// daily spend for installs that opted in (see website/privacy.html).

import { getProvisionedKey, getInstallId } from '../background/provisioning';

const API_BASE = 'https://api.tolerance.lol';

interface ResearchConsent {
  optIn: boolean;
  synced: boolean; // server has this choice
  updatedAt: number;
}

export async function getResearchOptIn(): Promise<boolean> {
  const { researchConsent } = await chrome.storage.local.get('researchConsent');
  return (researchConsent as ResearchConsent | undefined)?.optIn ?? false;
}

export async function setResearchOptIn(optIn: boolean): Promise<void> {
  const consent: ResearchConsent = { optIn, synced: false, updatedAt: Date.now() };
  await chrome.storage.local.set({ researchConsent: consent });
  await syncResearchConsent();
}

// Send the stored choice to the server if it hasn't been yet.
// Safe to call repeatedly; failures are retried on the next call.
export async function syncResearchConsent(): Promise<void> {
  const { researchConsent } = await chrome.storage.local.get('researchConsent');
  const consent = researchConsent as ResearchConsent | undefined;
  if (!consent || consent.synced) return;

  // The server only knows installs that have a free-tier key. If it's still
  // being provisioned, the background syncs once provisioning finishes.
  if (!(await getProvisionedKey())) return;

  try {
    const installId = await getInstallId();
    const response = await fetch(`${API_BASE}/api/free/research-consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, optIn: consent.optIn }),
    });
    if (!response.ok) return;

    // Only mark synced if the choice hasn't changed while the request ran
    const { researchConsent: latest } = await chrome.storage.local.get('researchConsent');
    if ((latest as ResearchConsent | undefined)?.updatedAt === consent.updatedAt) {
      await chrome.storage.local.set({ researchConsent: { ...consent, synced: true } });
    }
  } catch {
    // Offline or server down: stays unsynced and is retried later
  }
}
