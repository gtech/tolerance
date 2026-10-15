// Shared by facebook-early.ts (document_start) and the main Facebook content script.
export const FB_POST_ID_ATTR = 'data-tolerance-pid';  // post root handled for this post ID
export const FB_DONE_ATTR = 'data-tolerance-done';    // post root isn't scorable (suggestions, reels tray...)

// Blur every feed item not yet handled. `scope` is the html class that switches it on.
export function fbGateCss(scope: string): string {
  return `html.${scope} [aria-posinset]:not([${FB_POST_ID_ATTR}]):not([${FB_DONE_ATTR}]):not(.tolerance-pending):not(.tolerance-blurred) > * {
    filter: blur(20px) !important;
    pointer-events: none !important;
  }`;
}

// Home feed and group feeds only
export function isFacebookFeedPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;
  return /^\/groups\/[^/]+\/?$/.test(pathname);
}

// Reels: any feed item linking to a reel (the Reels tray, reel posts), plus trays
// outside feed items, which the content script marks with REELS_HIDDEN_CLASS
export const REELS_HIDDEN_CLASS = 'tolerance-reels-hidden';
export const REEL_LINK = 'a[href*="/reel/"]';
export function hideReelsCss(scope: string): string {
  return `html.${scope} [aria-posinset]:has(${REEL_LINK}),
  html.${scope} [style*="card-corner-radius"]:has([role="grid"] ${REEL_LINK}),
  html.${scope} .${REELS_HIDDEN_CLASS} { display: none !important; }`;
}
