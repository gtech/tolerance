import type { Settings } from '../shared/types';

let hoverReveal = true;
let hoverSeconds = 3;
let stylesInjected = false;

export function hoverRevealEnabled(): boolean {
  return hoverReveal;
}

export function hoverRevealSeconds(): number {
  return hoverSeconds;
}

// Shared by every platform: settings arrive here and take effect on existing
// overlays through classes on <html>. Badges and overlays are siblings on all
// platforms; a revealed post is marked on the overlay (Reddit, Instagram,
// Facebook) or on the post (Twitter, YouTube).
export function applyBlurPrefs(settings: Settings | null | undefined): void {
  if (!stylesInjected) {
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      html.tolerance-hide-blurred-badges :not(.tolerance-revealed):has(> .tolerance-blur-overlay:not(.revealed)) > .tolerance-score-badge {
        display: none !important;
      }
      html.tolerance-hide-blurred-badges :not(.tolerance-pending) > .tolerance-blur-overlay > .tolerance-blur-label {
        display: none !important;
      }
      html.tolerance-no-hover-reveal :not(.tolerance-pending) > .tolerance-blur-overlay::after {
        content: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  hoverReveal = settings?.twitter?.hoverReveal ?? true;
  hoverSeconds = settings?.twitter?.hoverRevealDelay ?? 3;
  const root = document.documentElement;
  root.style.setProperty('--tolerance-hover-text', `'Hover ${hoverSeconds}s to reveal'`);
  root.classList.toggle('tolerance-no-hover-reveal', !hoverReveal);
  root.classList.toggle('tolerance-hide-blurred-badges', settings?.twitter?.hideBlurredBadges ?? false);
}
