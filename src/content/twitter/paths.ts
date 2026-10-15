// Shared by early.ts (document_start) and the main Twitter content script.
// Pages left unfiltered: single tweets and search results.
export function isUnfilteredTwitterPath(pathname: string): boolean {
  return pathname.includes('/status/') || pathname.startsWith('/search');
}
