// Shared by linkedin/early.ts (document_start) and the main LinkedIn content script.
import { opaqueGateCss } from '../gateOpacity';

export const LI_POST_ID_ATTR = 'data-tolerance-pid';  // post root handled for this post ID
export const LI_DONE_ATTR = 'data-tolerance-done';    // post root that can't be scored

// LinkedIn's class names are generated and change between builds; these attributes
// are what its own code and tests hang on (seen 2026-11-19).
export const LI_FEED = '[data-testid="mainFeed"]';
export const LI_POST = '[role="listitem"][componentkey^="update-card-"]';

// Blur every post in the home feed that hasn't been handled yet. `scope` is the html
// class that switches it on. Only posts in the feed list: nothing in messaging,
// notifications or the side columns matches.
export function liGateCss(scope: string): string {
  const item = `${LI_FEED} ${LI_POST}:not([${LI_POST_ID_ATTR}]):not([${LI_DONE_ATTR}]):not(.tolerance-pending):not(.tolerance-blurred)`;
  return `html.${scope} ${item} > * {
    filter: blur(20px) !important;
    pointer-events: none !important;
  }
  ${opaqueGateCss(scope, [item], { zIndex: 50 })}`;
}

// The home feed only. Search results, profiles, company pages and single posts are
// places people go on purpose, and messaging is never read.
export function isLinkedInFeedPath(pathname: string): boolean {
  return pathname === '/feed' || pathname === '/feed/';
}
