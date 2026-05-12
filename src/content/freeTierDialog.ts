import type { Settings } from '../shared/types';

const ACCOUNT_URL = 'https://tolerance.lol/account.html';
const DIALOG_ID = 'tolerance-free-tier-dialog';
const LAST_SHOWN_KEY = 'freeTierDialogLastShownFor';

interface ApiErrorState {
  exhausted: boolean;
  message?: string;
  timestamp: number;
}

export async function showFreeTierExhaustedDialog(settings?: Settings): Promise<void> {
  if (settings?.apiTier === 'own-key' || document.getElementById(DIALOG_ID)) {
    return;
  }

  const { apiErrorState, [LAST_SHOWN_KEY]: lastShownFor } = await chrome.storage.local.get([
    'apiErrorState',
    LAST_SHOWN_KEY,
  ]);
  const errorState = apiErrorState as ApiErrorState | undefined;

  if (!errorState?.exhausted || !errorState.timestamp || lastShownFor === errorState.timestamp) {
    return;
  }

  await chrome.storage.local.set({ [LAST_SHOWN_KEY]: errorState.timestamp });

  const dialog = document.createElement('div');
  dialog.id = DIALOG_ID;
  dialog.innerHTML = `
    <style>
      #${DIALOG_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(0, 0, 0, 0.56);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${DIALOG_ID} .tolerance-dialog {
        width: min(420px, 100%);
        background: #151515;
        color: #f4f4f4;
        border: 1px solid #353535;
        border-radius: 8px;
        box-shadow: 0 18px 54px rgba(0, 0, 0, 0.45);
        padding: 22px;
      }
      #${DIALOG_ID} h2 {
        margin: 0 0 10px;
        font-size: 18px;
        line-height: 1.3;
        font-weight: 650;
      }
      #${DIALOG_ID} p {
        margin: 0;
        color: #b8b8b8;
        font-size: 14px;
        line-height: 1.5;
      }
      #${DIALOG_ID} .tolerance-dialog-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      #${DIALOG_ID} button {
        border: 0;
        border-radius: 6px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      #${DIALOG_ID} .tolerance-upgrade {
        background: #3d2d4a;
        color: #d3a9ea;
      }
      #${DIALOG_ID} .tolerance-dashboard {
        background: #242424;
        color: #d0d0d0;
      }
      #${DIALOG_ID} .tolerance-dismiss {
        margin-left: auto;
        background: transparent;
        color: #888;
      }
    </style>
    <div class="tolerance-dialog" role="dialog" aria-modal="true" aria-labelledby="tolerance-free-tier-title">
      <h2 id="tolerance-free-tier-title">Free daily credits used</h2>
      <p>Tolerance cannot score more posts on the free tier right now. Upgrade to Pro for more hosted scoring, or add your own API key in the dashboard.</p>
      <div class="tolerance-dialog-actions">
        <button type="button" class="tolerance-upgrade">Upgrade to Pro</button>
        <button type="button" class="tolerance-dashboard">Use own API key</button>
        <button type="button" class="tolerance-dismiss" aria-label="Close">Close</button>
      </div>
    </div>
  `;

  const close = () => dialog.remove();
  dialog.querySelector('.tolerance-upgrade')?.addEventListener('click', () => {
    window.open(ACCOUNT_URL, '_blank');
    close();
  });
  dialog.querySelector('.tolerance-dashboard')?.addEventListener('click', () => {
    window.open(chrome.runtime.getURL('dashboard/index.html#api-setup'), '_blank');
    close();
  });
  dialog.querySelector('.tolerance-dismiss')?.addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });

  document.body.appendChild(dialog);
}
