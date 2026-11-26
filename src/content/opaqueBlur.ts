import { COVER_BACKGROUND, matchCoverTo } from './coverStyle';

// Solid overlay in the colour the post sits on (coverStyle.ts). Set as inline
// !important: some platform stylesheets (Reddit, Instagram, Facebook) give the
// overlay background !important, which beats a plain inline style.
export function setOpaque(overlay: HTMLElement, on: boolean): void {
  if (!on) {
    overlay.style.removeProperty('background');
    return;
  }
  overlay.style.setProperty('background', COVER_BACKGROUND, 'important');
  // Most callers attach the overlay to its post just after this
  if (overlay.parentElement) matchCoverTo(overlay.parentElement);
  else queueMicrotask(() => matchCoverTo(overlay.parentElement));
}
