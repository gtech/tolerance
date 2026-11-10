// Shared by early.ts (document_start) and the main Twitter content script.
import { isMessagingPath } from '../../shared/scoring-surfaces';

// Pages left unfiltered: single tweets, search results, and DMs (never read at all:
// a post shared into a conversation is still part of a private message).
export function isUnfilteredTwitterPath(pathname: string): boolean {
  return pathname.includes('/status/') || pathname.startsWith('/search') || isMessagingPath('twitter', pathname);
}
