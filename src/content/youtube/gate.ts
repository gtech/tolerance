// Shared by youtube-early.ts (document_start) and the main YouTube content script.
// Video cards the extension scores; nested lockups (inside a rich item or another
// lockup) are part of their parent card.
export const VIDEO_CARD_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-compact-video-renderer',
  'yt-lockup-view-model:not(ytd-rich-item-renderer yt-lockup-view-model):not(yt-lockup-view-model yt-lockup-view-model)',
];
export const VIDEO_CARD_SELECTOR = VIDEO_CARD_SELECTORS.join(', ');

export const VIDEO_ID_ATTR = 'data-tolerance-vid';   // card was handled for this video
export const DONE_ATTR = 'data-tolerance-done';      // card isn't scorable (ad, shelf header...)

// Blur every card not yet handled. `scope` is the html class that switches it on.
export function gateCss(scope: string, blurPx = 8): string {
  const unhandled = `:not([${VIDEO_ID_ATTR}]):not([${DONE_ATTR}]):not(.tolerance-pending):not(.tolerance-blurred)`;
  const targets = VIDEO_CARD_SELECTORS
    .map(sel => `html.${scope} ${sel}${unhandled} > :not(.tolerance-blur-overlay):not(.tolerance-score-badge)`)
    .join(',\n');
  return `${targets} { filter: blur(${blurPx}px) !important; pointer-events: none !important; }`;
}

// Pages where YouTube videos aren't scored (search is user-directed; Shorts has no feed)
export function isUnscoredYouTubePage(path: string): boolean {
  return path.startsWith('/results') || path.startsWith('/shorts');
}
