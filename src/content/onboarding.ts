// Onboarding tooltip for first-time blur experience
// Shows once ever, explaining hover-to-reveal and settings customization

import { OnboardingState, DEFAULT_ONBOARDING_STATE } from '../shared/types';

let onboardingState: OnboardingState | null = null;
let tooltipShown = false;

// Load onboarding state from storage
export async function loadOnboardingState(): Promise<OnboardingState> {
  if (onboardingState) return onboardingState;

  const result = await chrome.storage.local.get('onboardingState');
  onboardingState = result.onboardingState || DEFAULT_ONBOARDING_STATE;
  return onboardingState;
}

// Mark tooltip as dismissed
export async function dismissOnboardingTooltip(): Promise<void> {
  onboardingState = {
    hoverTooltipDismissed: true,
    dismissedAt: Date.now(),
  };
  await chrome.storage.local.set({ onboardingState });

  // Remove tooltip from DOM if present
  const tooltip = document.querySelector('.tolerance-onboarding-tooltip');
  if (tooltip) {
    tooltip.classList.add('tolerance-onboarding-hiding');
    setTimeout(() => tooltip.remove(), 300);
  }
}

// Check if we should show the onboarding tooltip
export async function shouldShowOnboardingTooltip(): Promise<boolean> {
  if (tooltipShown) return false;
  const state = await loadOnboardingState();
  return !state.hoverTooltipDismissed;
}

// Show the onboarding tooltip near a blurred element
export async function showOnboardingTooltip(nearElement: HTMLElement): Promise<void> {
  if (tooltipShown) return;

  const shouldShow = await shouldShowOnboardingTooltip();
  if (!shouldShow) return;

  tooltipShown = true;

  // Create tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'tolerance-onboarding-tooltip';
  tooltip.innerHTML = `
    <div class="tolerance-onboarding-content">
      <div class="tolerance-onboarding-icon">💡</div>
      <div class="tolerance-onboarding-text">
        <strong>Tip:</strong> Hover for 3 seconds to reveal blurred content.
        <br><span class="tolerance-onboarding-secondary">You can adjust blur thresholds and hover duration in the extension settings.</span>
      </div>
      <button class="tolerance-onboarding-dismiss" aria-label="Dismiss">✕</button>
    </div>
  `;

  // Position tooltip near the element but not blocking it
  const rect = nearElement.getBoundingClientRect();
  const scrollTop = window.scrollY || document.documentElement.scrollTop;

  // Position above or below depending on viewport space
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;

  if (spaceAbove > 100) {
    // Position above
    tooltip.style.top = `${rect.top + scrollTop - 80}px`;
  } else {
    // Position below
    tooltip.style.top = `${rect.bottom + scrollTop + 10}px`;
  }

  tooltip.style.left = `${Math.max(10, rect.left)}px`;
  tooltip.style.maxWidth = `${Math.min(400, window.innerWidth - 20)}px`;

  document.body.appendChild(tooltip);

  // Add dismiss handler
  const dismissBtn = tooltip.querySelector('.tolerance-onboarding-dismiss');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dismissOnboardingTooltip();
    });
  }

  // Also dismiss on clicking anywhere outside
  setTimeout(() => {
    const clickHandler = (e: MouseEvent) => {
      if (!tooltip.contains(e.target as Node)) {
        dismissOnboardingTooltip();
        document.removeEventListener('click', clickHandler);
      }
    };
    document.addEventListener('click', clickHandler);
  }, 500);

  // Auto-dismiss after 15 seconds
  setTimeout(() => {
    if (document.contains(tooltip)) {
      dismissOnboardingTooltip();
    }
  }, 15000);
}

// Inject onboarding tooltip styles
export function injectOnboardingStyles(): void {
  if (document.getElementById('tolerance-onboarding-styles')) return;

  const style = document.createElement('style');
  style.id = 'tolerance-onboarding-styles';
  style.textContent = `
    .tolerance-onboarding-tooltip {
      position: absolute;
      z-index: 2147483647;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      border: 1px solid #7dcea0;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(125, 206, 160, 0.2);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      animation: tolerance-onboarding-appear 0.3s ease-out;
    }

    .tolerance-onboarding-tooltip.tolerance-onboarding-hiding {
      animation: tolerance-onboarding-disappear 0.3s ease-out forwards;
    }

    @keyframes tolerance-onboarding-appear {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes tolerance-onboarding-disappear {
      from {
        opacity: 1;
        transform: translateY(0);
      }
      to {
        opacity: 0;
        transform: translateY(-10px);
      }
    }

    .tolerance-onboarding-content {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }

    .tolerance-onboarding-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .tolerance-onboarding-text {
      color: #e0e0e0;
      font-size: 14px;
      line-height: 1.5;
      flex: 1;
    }

    .tolerance-onboarding-text strong {
      color: #7dcea0;
    }

    .tolerance-onboarding-secondary {
      color: #888;
      font-size: 12px;
    }

    .tolerance-onboarding-dismiss {
      background: none;
      border: none;
      color: #888;
      font-size: 18px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      transition: color 0.2s;
      flex-shrink: 0;
    }

    .tolerance-onboarding-dismiss:hover {
      color: #e0e0e0;
    }
  `;

  document.head.appendChild(style);
}
