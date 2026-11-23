import { Tweet, TweetAnchor } from '../../shared/types';
import { SPONSORED_PREFIX } from '../../shared/scoring-spec';
import { parseEngagementLabel, snowflakeSeconds } from '../../shared/twitter-parse';
import { withAiLabel } from '../aiLabel';
import { POST_LINK_SELECTOR, cellOf } from './dom';
import { extractHashtags, extractMentions, parseCount } from './scraper';

// Reads a post from the site Twitter shipped in November 2026 (see ./dom.ts for the
// layout). There are no data-testid attributes any more, so this goes by structure:
// the wrapper's data-href, the avatar marker, the text direction attribute, and the
// accessibility label on the row of buttons.

const MEDIA_HOST = 'pbs.twimg.com/';

function statusId(href: string | null | undefined): string | undefined {
  return href?.match(/\/status\/(\d+)/)?.[1];
}

function handleFrom(href: string | null | undefined): string {
  const m = href?.match(/^\/([A-Za-z0-9_]+)(?:\/|$)/);
  return m ? m[1] : '';
}

// The repost line sits in an outer article; the post itself is the article inside it
function innerArticle(article: HTMLElement): HTMLElement | null {
  return [...article.children].find((c): c is HTMLElement => c.tagName === 'ARTICLE') ?? null;
}

// Whether a node belongs to the post that `link` wraps, not to a post quoted inside it
function ownedBy(link: Element, node: Element): boolean {
  return node.closest(POST_LINK_SELECTOR) === link;
}

// A post's text is in dir="auto" blocks that aren't names (names are inside profile
// links). The "Show more" button inside a block is not part of the text.
function textBlocks(link: Element, root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('div[dir="auto"]')]
    .filter(el => ownedBy(link, el) && !el.closest('a:not([href*="/status/"])'));
}

function textBlock(link: Element, root: Element): HTMLElement | undefined {
  return textBlocks(link, root)[0];
}

// A quoted long-form article has no text block of its own: its title and opening
// lines are blocks inside the link to it
function quotedTextOf(card: Element): string {
  const blocks = textBlocks(card, card);
  if (blocks.length > 0 && blocks[0].closest('a')) return blocks.map(textOf).filter(Boolean).join('\n');
  return textOf(blocks[0]);
}

function textOf(block: Element | undefined): string {
  if (!block) return '';
  return [...block.childNodes]
    .filter(n => !(n instanceof HTMLElement && n.tagName === 'BUTTON'))
    .map(n => n.textContent ?? '')
    .join('')
    .trim();
}

export function tweetAuthorV2(article: HTMLElement): string {
  const cell = cellOf(article);
  if (!cell) return '';
  const body = innerArticle(article) ?? article;
  const avatarLink = [...body.querySelectorAll<HTMLAnchorElement>('[data-post-avatar] a[href^="/"]')]
    .find(a => ownedBy(cell, a));
  return handleFrom(avatarLink?.getAttribute('href')) || handleFrom(cell.getAttribute('data-href'));
}

export function inQuotedTweetV2(article: HTMLElement, node: Element): boolean {
  const cell = cellOf(article);
  return !!cell && cell.contains(node) && !ownedBy(cell, node);
}

export function parseTweetV2(article: HTMLElement): Tweet | null {
  const cell = cellOf(article);
  if (!cell) return null;
  const permalink = cell.getAttribute('data-href') || '';
  const id = statusId(permalink);
  if (!id) return null;

  const inner = innerArticle(article);
  const body = inner ?? article;
  const own = <T extends Element>(selector: string): T[] =>
    [...body.querySelectorAll<T>(selector)].filter(el => ownedBy(cell, el));

  // Repost: the line above the post names who reposted it
  const repostLink = inner
    ? [...article.querySelectorAll<HTMLAnchorElement>('a[href^="/"]')].find(a => !inner.contains(a))
    : undefined;
  const isRetweet = !!repostLink;
  const retweetedBy = repostLink?.textContent?.trim() || undefined;

  const author = tweetAuthorV2(article);
  const isVerified = own('[aria-label="Verified account"]').length > 0;

  const block = textBlock(cell, body);
  const tweetText = textOf(block);
  // Promoted posts carry a bare "Ad" where the time would be
  const isPromoted = own<HTMLElement>('a, span').some(el => {
    const label = el.textContent?.trim();
    return (label === 'Ad' || label === 'Promoted') && !block?.contains(el);
  });
  const text = withAiLabel(article, isPromoted ? `${SPONSORED_PREFIX}${tweetText}` : tweetText);

  const createdUtc = snowflakeSeconds(id) ?? Date.now() / 1000;

  // Counts: spelled out in the label on the row of buttons, with the short forms
  // shown on the buttons ("1.7K") as a fallback
  // (a video player has labelled groups of its own, so take the one holding the buttons)
  const buttonRow = own('[role="group"][aria-label]').find(g => g.querySelector('[data-engagement-action]'));
  const counts = parseEngagementLabel(buttonRow?.getAttribute('aria-label'));
  const shown = (action: string): number =>
    parseCount(own(`[data-engagement-action="${action}"]`)[0]?.textContent?.trim() || '');
  const replyCount = counts.replies ?? shown('reply');
  const retweetCount = counts.reposts ?? shown('retweet');
  const likeCount = counts.likes ?? shown('like');
  const bookmarkCount = counts.bookmarks ?? 0;
  const viewsShown = own('a[href$="/analytics"]')[0]?.textContent?.trim();
  const viewCount = counts.views ?? (viewsShown ? parseCount(viewsShown) : undefined);

  // Quoted post: the same wrapper again, inside this post
  const quoteCard = [...body.querySelectorAll<HTMLElement>(POST_LINK_SELECTOR)]
    .find(card => card.parentElement?.closest(POST_LINK_SELECTOR) === cell);
  let quotedTweet: Tweet['quotedTweet'];
  if (quoteCard) {
    const quotedAuthor = handleFrom(quoteCard.getAttribute('data-href'));
    const quotedText = quotedTextOf(quoteCard);
    const quotedImageUrl =
      [...quoteCard.querySelectorAll<HTMLImageElement>(`img[src*="${MEDIA_HOST}media/"]`)].find(img => img.src)?.src
      || [...quoteCard.querySelectorAll<HTMLVideoElement>('video')].find(v => v.poster)?.poster
      || undefined;
    if (quotedAuthor || quotedText || quotedImageUrl) {
      quotedTweet = { author: quotedAuthor, text: quotedText, imageUrl: quotedImageUrl };
    }
  }

  const bodyText = body.textContent || '';
  const isReply = bodyText.includes('Replying to');
  const replyToAuthor = bodyText.match(/Replying to @(\w+)/)?.[1];

  // A conversation is rendered as consecutive wrappers in one list item, so the post
  // this one answers is simply the wrapper before it
  const prev = cell.previousElementSibling;
  const next = cell.nextElementSibling;
  const prevIsPost = !!prev?.matches(POST_LINK_SELECTOR);
  const isThread = prevIsPost || !!next?.matches(POST_LINK_SELECTOR);

  // Anchor: the post this one is reacting to. Self-quotes are skipped; self-thread
  // replies are kept (see the old-layout scraper for why).
  let anchor: TweetAnchor | undefined;
  if (quotedTweet && quotedTweet.text && quotedTweet.author.toLowerCase() !== author.toLowerCase()) {
    anchor = { kind: 'quote', author: quotedTweet.author, text: quotedTweet.text };
  } else if (prev && prevIsPost) {
    const parentHref = prev.getAttribute('data-href');
    const parentId = statusId(parentHref);
    const parentAuthor = handleFrom(parentHref);
    if (parentId && parentAuthor) {
      const parent: TweetAnchor = { kind: 'reply', id: parentId, author: parentAuthor, text: textOf(textBlock(prev, prev)) };
      anchor = parentAuthor.toLowerCase() === author.toLowerCase() ? { ...parent, selfThread: true } : parent;
    }
  }

  // Media. A link card is an outside link with a picture in it; its picture is not
  // a photo of the post.
  const videos = own<HTMLVideoElement>('video');
  const mediaImgs = own<HTMLImageElement>(`img[src*="${MEDIA_HOST}"]`)
    .filter(img => /\/media\/|video_thumb/.test(img.src));
  const inCard = (el: Element) => !!el.closest('a[href^="http"]');
  const photos = mediaImgs.filter(img => !inCard(img));
  const cardLinks = own<HTMLAnchorElement>('a[href^="http"]').filter(a => !block?.contains(a));
  const isGif = [...videos.map(v => v.poster), ...photos.map(img => img.src)].some(src => src.includes('tweet_video_thumb'));

  let mediaType: Tweet['mediaType'] = 'text';
  if (isGif) mediaType = 'gif';
  else if (videos.length > 0) mediaType = 'video';
  else if (photos.length === 1 && photos[0].src.includes('video_thumb')) mediaType = 'video';
  else if (photos.length > 1) mediaType = 'gallery';
  else if (photos.length === 1) mediaType = 'image';
  else if (cardLinks.length > 0) mediaType = 'link';

  const firstImage = photos.find(img => img.src)?.src ?? mediaImgs.find(img => img.src)?.src;
  const video = videos[0];
  const imageUrl = firstImage;
  const thumbnailUrl = video?.poster || firstImage;
  const videoUrl = video ? (video.src || video.querySelector('source')?.src || undefined) : undefined;

  // Links: cards carry the real address; links in the text are t.co, with the
  // address as their text when Twitter shows it in full
  const urls: string[] = [];
  for (const link of own<HTMLAnchorElement>('a[href^="http"]')) {
    const href = link.getAttribute('href') || '';
    if (/^https?:\/\/t\.co\//.test(href)) {
      const shownUrl = link.textContent?.trim() || '';
      if (shownUrl.startsWith('http')) urls.push(shownUrl);
    } else if (!/^https?:\/\/(www\.)?(x|twitter)\.com\//.test(href)) {
      urls.push(href);
    }
  }

  return {
    id,
    platform: 'twitter',
    author,
    text,
    score: likeCount,
    numComments: replyCount,
    mediaType,
    permalink,
    createdUtc,
    thumbnailUrl,
    imageUrl,
    videoUrl,
    element: article,
    retweetCount,
    quoteCount: 0,
    likeCount,
    viewCount,
    bookmarkCount,
    isRetweet,
    isQuoteTweet: quotedTweet !== undefined,
    isReply,
    isThread,
    retweetedBy,
    quotedTweet,
    replyToAuthor,
    anchor,
    hashtags: extractHashtags(text),
    mentions: extractMentions(text),
    urls: [...new Set(urls)],
    isVerified,
  };
}
