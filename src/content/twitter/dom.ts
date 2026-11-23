// Where a post sits on the page. Shared by early.ts (document_start) and the main
// Twitter content script.
//
// Twitter rebuilt its site in November 2026 and dropped every data-testid. Both
// layouts are handled, since the old one may still be served to some people.
//
//   old: [data-testid="cellInnerDiv"] > ... > article[data-testid="tweet"]
//   new: li[data-index] > (div.flex.flex-col >)? div[role="link"][data-href="/user/status/ID"] > article
//
// In the new layout a quoted post is the same wrapper again, inside the article, and
// a repost is an outer article (the "X reposted" line) holding the post's own article.
// A conversation is two or more wrappers in one list item.
//
// "Cell" below is the element the badge, blur and overlay hang on: one per post.

const OLD_CELL = '[data-testid="cellInnerDiv"]';
const OLD_TWEET = 'article[data-testid="tweet"]';
export const POST_LINK_SELECTOR = 'div[role="link"][data-href*="/status/"]';
const NEW_CELL = `${POST_LINK_SELECTOR}:not(article *)`;
const NEW_TWEET = `${NEW_CELL} > article`;

export const CELL_SELECTOR = `${OLD_CELL}, ${NEW_CELL}`;
export const TWEET_SELECTOR = `${OLD_TWEET}, ${NEW_TWEET}`;

// Cells that hold a post, one selector per layout (for CSS built from a list)
export const TWEET_CELL_SELECTORS = [`${OLD_CELL}:has(${OLD_TWEET})`, `${NEW_CELL}:has(> article)`];

export const VIDEO_SELECTOR = 'video, [data-testid="videoPlayer"]';

const STATUS_ID = /\/status\/(\d+)/;

export function isOldLayoutTweet(article: Element): boolean {
  return article.matches(OLD_TWEET);
}

export function cellOf(element: Element | null | undefined): HTMLElement | null {
  return element?.closest<HTMLElement>(CELL_SELECTOR) ?? null;
}

export function tweetIn(cell: Element): HTMLElement | null {
  return cell.querySelector<HTMLElement>(TWEET_SELECTOR);
}

// The post a cell shows now, read the same way the scraper reads it
export function cellTweetId(cell: Element): string | null {
  const own = cell.getAttribute('data-href');
  if (own) return own.match(STATUS_ID)?.[1] ?? null;
  const href = cell.querySelector(`${OLD_TWEET} a[href*="/status/"]`)?.getAttribute('href') || '';
  return href.match(STATUS_ID)?.[1] ?? null;
}

// The column the timeline is in
export function primaryColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="primaryColumn"]')
    ?? document.querySelector<HTMLElement>('main');
}

// Whether the timeline itself has rendered inside the column
export function timelineRendered(): boolean {
  return document.querySelector('[data-testid="primaryColumn"] section[role="region"], main section') !== null;
}
