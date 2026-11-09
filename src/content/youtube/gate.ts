// Shared by youtube-early.ts (document_start) and the main YouTube content script.
// Video cards the extension scores; nested lockups (inside a rich item or another
// lockup) are part of their parent card.
import { opaqueGateCss } from '../gateOpacity';

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
  const cards = VIDEO_CARD_SELECTORS.map(sel => `${sel}${unhandled}`);
  return `${targets} { filter: blur(${blurPx}px) !important; pointer-events: none !important; }
  ${opaqueGateCss(scope, cards)}`;
}

// Hide YouTube Shorts (setting). Shelves on the home page, subscriptions, search and
// the watch sidebar; single Shorts cards in grids; the Shorts entries in the side
// menus and the Shorts tab on channel pages. YouTube marks the home shelf with
// [is-shorts] and its items are ytm-shorts-lockup-view-model; elsewhere a link to
// /shorts/ is the reliable sign.
export const HIDE_SHORTS_CLASS = 'tolerance-yt-hide-shorts';
export function hideShortsCss(): string {
  const scope = `html.${HIDE_SHORTS_CLASS}`;
  const shortsLink = 'a[href^="/shorts/"]';
  return [
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-reel-shelf-renderer',
    'grid-shelf-view-model:has(ytm-shorts-lockup-view-model)',
    'ytd-rich-item-renderer:has(ytm-shorts-lockup-view-model)',
    `ytd-rich-item-renderer:has(${shortsLink})`,
    `ytd-video-renderer:has(${shortsLink})`,
    `yt-lockup-view-model:has(${shortsLink})`,
    'ytd-guide-entry-renderer:has(a[title="Shorts"])',
    'ytd-mini-guide-entry-renderer[aria-label="Shorts"]',
    'yt-tab-shape[tab-title="Shorts"]',
  ].map(sel => `${scope} ${sel}`).join(',\n') + ' { display: none !important; }';
}

// /shorts/VIDEO_ID -> /watch?v=VIDEO_ID: the video still plays, without the swipe feed
export function shortsWatchUrl(pathname: string): string | null {
  const m = pathname.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
  return m ? `/watch?v=${m[1]}` : null;
}

// Pages where YouTube videos aren't scored (search is user-directed; Shorts has no feed)
export function isUnscoredYouTubePage(path: string): boolean {
  return path.startsWith('/results') || path.startsWith('/shorts');
}
