import { Tweet, TweetAnchor } from '../../shared/types';
import { log } from '../../shared/constants';

// Scrape tweet data from Twitter/X DOM
// Twitter uses React with data-testid attributes for stable selectors

export function scrapeVisibleTweets(): Tweet[] {
  const tweets: Tweet[] = [];

  // Twitter timeline tweets are in article elements with data-testid="tweet"
  const tweetElements = document.querySelectorAll<HTMLElement>(
    'article[data-testid="tweet"]'
  );

  for (const element of tweetElements) {
    const tweet = parseTweetElement(element);
    if (tweet) {
      tweets.push(tweet);
    }
  }

  return tweets;
}

export function parseTweetElement(element: HTMLElement): Tweet | null {
  try {
    // Get tweet ID from the permalink (status URL)
    const permalinkElement = element.querySelector<HTMLAnchorElement>(
      'a[href*="/status/"]'
    );
    const href = permalinkElement?.getAttribute('href') || '';
    const idMatch = href.match(/\/status\/(\d+)/);
    if (!idMatch) return null;

    const id = idMatch[1];
    const permalink = href;

    // Check if this is a retweet
    const socialContext = element.closest('[data-testid="cellInnerDiv"]')
      ?.querySelector('[data-testid="socialContext"]');
    const isRetweet = socialContext?.textContent?.includes('reposted') || false;
    const retweetedBy = isRetweet
      ? socialContext?.textContent?.replace(' reposted', '').trim()
      : undefined;

    // Author info
    const userNameContainer = element.querySelector('[data-testid="User-Name"]');
    const authorLink = userNameContainer?.querySelector<HTMLAnchorElement>('a[href^="/"]');
    const author = authorLink?.getAttribute('href')?.replace('/', '') || '';

    // Verified status
    const isVerified = userNameContainer?.querySelector('[data-testid="icon-verified"]') !== null;

    // Tweet text
    const textElement = [...element.querySelectorAll('[data-testid="tweetText"]')].find(t => !inQuotedTweet(element, t));
    const text = textElement?.textContent?.trim() || '';

    // Timestamp
    const timeElement = element.querySelector('time');
    const datetime = timeElement?.getAttribute('datetime');
    const createdUtc = datetime ? new Date(datetime).getTime() / 1000 : Date.now() / 1000;

    // Engagement metrics
    const replyCount = parseMetric(element, 'reply');
    const retweetCount = parseMetric(element, 'retweet');
    const likeCount = parseMetric(element, 'like');
    const viewCount = parseViewCount(element);
    const bookmarkCount = parseMetric(element, 'bookmark');

    // Quote tweet detection
    const quotedTweet = parseQuotedTweet(element);
    const isQuoteTweet = quotedTweet !== undefined;

    // Reply detection
    const replyIndicator = element.querySelector('[data-testid="tweet"] > div > div > div > div > div > a[href*="/status/"]');
    const isReply = element.textContent?.includes('Replying to') || false;
    const replyToMatch = element.textContent?.match(/Replying to @(\w+)/);
    const replyToAuthor = replyToMatch?.[1];

    // Thread detection (tweet is part of a thread)
    const isThread = element.querySelector('[data-testid="Tweet-User-Avatar"]')?.closest('div')
      ?.querySelector('[style*="border-left"]') !== null;

    // Anchor: the post this tweet is reacting to. Self-quotes are skipped. Self-thread
    // replies are kept: the parent's score already carries whatever bait it replies
    // to, and a thread hanging off bait pulls you into it just the same.
    let anchor: TweetAnchor | undefined;
    if (quotedTweet && quotedTweet.text && quotedTweet.author.toLowerCase() !== author.toLowerCase()) {
      anchor = { kind: 'quote', author: quotedTweet.author, text: quotedTweet.text };
    } else {
      const parent = findThreadParent(element);
      if (parent) {
        anchor = parent.author.toLowerCase() === author.toLowerCase() ? { ...parent, selfThread: true } : parent;
      }
    }

    // Media type detection
    const mediaType = detectMediaType(element);

    // Extract media URLs
    const { thumbnailUrl, imageUrl, videoUrl } = extractMediaUrls(element);

    // Extract hashtags, mentions, URLs from tweet text
    const hashtags = extractHashtags(text);
    const mentions = extractMentions(text);
    const urls = extractUrls(element);

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
      element,
      // Twitter-specific
      retweetCount,
      quoteCount: 0, // Not easily extractable from DOM
      likeCount,
      viewCount,
      bookmarkCount,
      isRetweet,
      isQuoteTweet,
      isReply,
      isThread,
      retweetedBy,
      quotedTweet,
      replyToAuthor,
      anchor,
      hashtags,
      mentions,
      urls,
      isVerified,
    };
  } catch (error) {
    console.error('Tolerance: Failed to parse tweet element:', error);
    return null;
  }
}

// In timeline conversations Twitter renders the parent tweet in the cell directly
// above the reply, joined by a thin vertical line between the two avatars. Detect
// that line geometrically (class names churn; layout doesn't): a narrow element in
// the avatar column sitting just above this tweet's avatar, or below the previous
// tweet's avatar.
// When Twitter collapses the middle of a conversation, a "Show more replies" cell
// (no tweet) sits between the two; the line above this tweet's avatar still links
// them, so skip a couple of tweet-less cells in that case.
function findThreadParent(element: HTMLElement): TweetAnchor | undefined {
  const cell = element.closest('[data-testid="cellInnerDiv"]');
  let prevCell = cell?.previousElementSibling as HTMLElement | null;
  let prevArticle = prevCell?.querySelector<HTMLElement>('article[data-testid="tweet"]');
  let skipped = 0;
  while (!prevArticle && prevCell && skipped < 2) {
    prevCell = prevCell.previousElementSibling as HTMLElement | null;
    prevArticle = prevCell?.querySelector<HTMLElement>('article[data-testid="tweet"]');
    skipped++;
  }
  if (!prevArticle) return undefined;

  const hasLineBelow = skipped === 0 && hasConnectorLine(prevArticle, 'below');
  const hasLineAbove = !hasLineBelow && hasConnectorLine(element, 'above');
  if (!hasLineAbove && !hasLineBelow) return undefined;

  const href = prevArticle.querySelector('a[href*="/status/"]')?.getAttribute('href') || '';
  const id = href.match(/\/status\/(\d+)/)?.[1];
  const parentAuthor = prevArticle.querySelector('[data-testid="User-Name"] a[href^="/"]')
    ?.getAttribute('href')?.replace('/', '') || '';
  const parentText = prevArticle.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || '';
  if (!id || !parentAuthor) return undefined;

  log.debug(` Thread parent detected: @${parentAuthor} (${id}) [line above=${hasLineAbove}, below=${hasLineBelow}, skipped=${skipped}]`);
  return { kind: 'reply', id, author: parentAuthor, text: parentText };
}

function hasConnectorLine(article: HTMLElement, where: 'above' | 'below'): boolean {
  const avatar = article.querySelector<HTMLElement>('[data-testid="Tweet-User-Avatar"]');
  if (!avatar) return false;
  const a = avatar.getBoundingClientRect();
  if (a.width === 0) return false;
  const avatarCenter = a.left + a.width / 2;

  // Read-only layout queries (no writes in between), so this is one layout pass per batch
  for (const div of article.querySelectorAll<HTMLElement>('div')) {
    const r = div.getBoundingClientRect();
    if (r.width === 0 || r.width > 4 || r.height < 4) continue;
    if (Math.abs(r.left + r.width / 2 - avatarCenter) > 4) continue;
    if (where === 'above' && r.bottom <= a.top + 2) return true;
    if (where === 'below' && r.top >= a.bottom - 2) return true;
  }
  return false;
}

function parseMetric(element: HTMLElement, type: string): number {
  // Twitter metrics are in buttons with data-testid like "reply", "retweet", "like"
  const button = element.querySelector(`[data-testid="${type}"]`);
  if (!button) return 0;

  // The count is in a span within the button
  const countSpan = button.querySelector('span[data-testid="app-text-transition-container"]');
  const text = countSpan?.textContent?.trim() || '0';

  return parseCount(text);
}

function parseViewCount(element: HTMLElement): number | undefined {
  // View count is displayed differently - look for "views" text
  const analyticsLink = element.querySelector('a[href*="/analytics"]');
  if (!analyticsLink) return undefined;

  const text = analyticsLink.textContent?.trim() || '';
  const match = text.match(/([\d,.]+[KMB]?)\s*views?/i);
  if (!match) return undefined;

  return parseCount(match[1]);
}

function parseCount(text: string): number {
  if (!text || text === '') return 0;

  // Handle K, M, B suffixes
  const normalized = text.toUpperCase().replace(/,/g, '');
  const match = normalized.match(/([\d.]+)([KMB])?/);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  const suffix = match[2];

  switch (suffix) {
    case 'K': return Math.round(num * 1000);
    case 'M': return Math.round(num * 1000000);
    case 'B': return Math.round(num * 1000000000);
    default: return Math.round(num);
  }
}

function parseQuotedTweet(element: HTMLElement): { author: string; text: string; imageUrl?: string } | undefined {
  const quotedCard = findQuoteCard(element);
  if (!quotedCard) return undefined;

  // Try multiple methods to get author
  let quotedAuthor = '';

  // Method 1: href attribute from link
  const authorLink = quotedCard.querySelector('[data-testid="User-Name"] a[href^="/"]');
  if (authorLink) {
    quotedAuthor = authorLink.getAttribute('href')?.replace('/', '') || '';
  }

  // Method 2: Look for @username text in User-Name section
  if (!quotedAuthor) {
    const userNameDiv = quotedCard.querySelector('[data-testid="User-Name"]');
    if (userNameDiv) {
      const spans = userNameDiv.querySelectorAll('span');
      for (const span of spans) {
        const text = span.textContent?.trim() || '';
        if (text.startsWith('@')) {
          quotedAuthor = text.slice(1); // Remove @ prefix
          break;
        }
      }
    }
  }

  const quotedText = quotedCard.querySelector('[data-testid="tweetText"]')
    ?.textContent?.trim() || '';

  // Image/video in the quoted tweet: photo, then video poster, then any media img
  const quoted = <T extends Element>(selector: string) =>
    [...element.querySelectorAll<T>(selector)].filter(el => inQuotedTweet(element, el));
  const quotedImageUrl = quoted<HTMLImageElement>('[data-testid="tweetPhoto"] img').find(img => img.src)?.src
    || quoted<HTMLVideoElement>('video').find(v => v.poster)?.poster
    || quoted<HTMLImageElement>('img[src*="pbs.twimg.com/media"]').find(img => img.src)?.src
    || undefined;

  if (!quotedAuthor && !quotedText && !quotedImageUrl) return undefined;

  log.debug(` Parsed quote tweet - author=${quotedAuthor}, text="${quotedText?.slice(0, 30)}...", imageUrl=${quotedImageUrl?.slice(0, 50)}...`);

  return { author: quotedAuthor, text: quotedText, imageUrl: quotedImageUrl };
}

// Whether a node belongs to the quoted tweet rather than the main one: the nearest
// ancestor holding an author line holds only the quoted tweet's. Doesn't depend on
// where Twitter puts the quote card's outer element.
export function inQuotedTweet(element: HTMLElement, node: Element): boolean {
  const mainName = element.querySelector('[data-testid="User-Name"]');
  if (!mainName || mainName.contains(node)) return false;
  for (let el = node.parentElement; el && el !== element; el = el.parentElement) {
    if (el.querySelector('[data-testid="User-Name"]')) return !el.contains(mainName);
  }
  return false;
}

// Helper to find quote card using multiple methods
export function findQuoteCard(element: HTMLElement): Element | null {
  // Method 1: the link wrapping the second author line (the quoted tweet's)
  const names = element.querySelectorAll('[data-testid="User-Name"]');
  if (names.length >= 2) {
    const card = names[1].closest('[role="link"]');
    if (card && element.contains(card) && !card.contains(names[0])) return card;
  }

  // Method 2: data-testid="quoteTweet"
  let card = element.querySelector('[data-testid="quoteTweet"]');
  if (card) return card;

  // Method 3: Look for "Quote" label
  const quoteLabels = element.querySelectorAll('span');
  for (const span of quoteLabels) {
    if (span.textContent?.trim() === 'Quote') {
      const parent = span.closest('div[class]');
      if (parent) {
        card = parent.parentElement?.querySelector('[role="link"]') || null;
        if (card) return card;
      }
    }
  }

  // Method 4: Nested tweetText
  const tweetTexts = element.querySelectorAll('[data-testid="tweetText"]');
  if (tweetTexts.length >= 2) {
    return tweetTexts[1].closest('[role="link"]');
  }

  return null;
}

function detectMediaType(element: HTMLElement): Tweet['mediaType'] {
  // Check for video (excluding quoted content)
  const videos = element.querySelectorAll('video, [data-testid="videoPlayer"]');
  for (const video of videos) {
    if (!inQuotedTweet(element, video)) {
      return 'video';
    }
  }

  // Check for GIF (excluding quoted content)
  const gifs = element.querySelectorAll('[data-testid="tweetPhoto"] img[src*="tweet_video_thumb"]');
  for (const gif of gifs) {
    if (!inQuotedTweet(element, gif)) {
      return 'gif';
    }
  }

  // Check for images (excluding quoted content)
  const images = element.querySelectorAll('[data-testid="tweetPhoto"]');
  let mainTweetImages = 0;
  let hasVideoThumbnail = false;
  for (const img of images) {
    if (!inQuotedTweet(element, img)) {
      mainTweetImages++;
      // Check if this "photo" is actually a video thumbnail that hasn't loaded
      // the <video> element yet — Twitter uses *_video_thumb URLs for these
      const imgSrc = img.querySelector('img')?.src || '';
      if (imgSrc.includes('video_thumb')) {
        hasVideoThumbnail = true;
      }
    }
  }
  if (hasVideoThumbnail && mainTweetImages === 1) {
    return 'video';
  }
  if (mainTweetImages > 1) {
    return 'gallery';
  }
  if (mainTweetImages === 1) {
    return 'image';
  }

  // Check for link card (excluding quoted content)
  const cards = element.querySelectorAll('[data-testid="card.wrapper"]');
  for (const card of cards) {
    if (!inQuotedTweet(element, card)) {
      return 'link';
    }
  }

  return 'text';
}

function extractMediaUrls(element: HTMLElement): {
  thumbnailUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
} {
  const result: { thumbnailUrl?: string; imageUrl?: string; videoUrl?: string } = {};

  // Image URL from tweet photo (excluding quoted content)
  const photoImgs = element.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img');
  for (const photoImg of photoImgs) {
    if (!inQuotedTweet(element, photoImg) && photoImg.src) {
      result.imageUrl = photoImg.src;
      result.thumbnailUrl = photoImg.src;
      break; // Take first main tweet image
    }
  }

  // Before the <img> gets its src, the photo is often only a background-image
  // on a sibling div; use that rather than scoring the tweet as empty text
  if (!result.imageUrl) {
    for (const photo of element.querySelectorAll<HTMLElement>('[data-testid="tweetPhoto"]')) {
      if (inQuotedTweet(element, photo)) continue;
      const url = backgroundImageUrl(photo);
      if (url) {
        result.imageUrl = url;
        result.thumbnailUrl = url;
        break;
      }
    }
  }

  // Video poster/thumbnail (excluding quoted content)
  const videos = element.querySelectorAll<HTMLVideoElement>('video');
  for (const video of videos) {
    if (!inQuotedTweet(element, video)) {
      result.videoUrl = video.src || video.querySelector('source')?.src;
      result.thumbnailUrl = video.poster || result.thumbnailUrl;
      break;
    }
  }

  return result;
}

function backgroundImageUrl(container: HTMLElement): string | undefined {
  for (const el of [container, ...container.querySelectorAll<HTMLElement>('[style*="background-image"]')]) {
    const m = el.style.backgroundImage.match(/url\(["']?(https:\/\/pbs\.twimg\.com\/[^"')]+)["']?\)/);
    if (m) return m[1];
  }
  return undefined;
}

function extractHashtags(text: string): string[] {
  const matches = text.match(/#\w+/g);
  return matches?.map(h => h.slice(1)) || [];
}

function extractMentions(text: string): string[] {
  const matches = text.match(/@\w+/g);
  return matches?.map(m => m.slice(1)) || [];
}

function extractUrls(element: HTMLElement): string[] {
  const urls: string[] = [];

  // Get expanded URLs from link cards
  const cardLinks = element.querySelectorAll<HTMLAnchorElement>(
    '[data-testid="card.wrapper"] a[href]'
  );
  for (const link of cardLinks) {
    const href = link.getAttribute('href');
    if (href && !href.startsWith('/') && !href.includes('twitter.com')) {
      urls.push(href);
    }
  }

  // Get t.co links from tweet text that expand to real URLs
  const textLinks = element.querySelectorAll<HTMLAnchorElement>(
    '[data-testid="tweetText"] a[href*="t.co"]'
  );
  for (const link of textLinks) {
    // Twitter shows the expanded URL as the link text
    const expandedUrl = link.textContent?.trim();
    if (expandedUrl && expandedUrl.startsWith('http')) {
      urls.push(expandedUrl);
    }
  }

  return [...new Set(urls)];
}

// Serialize tweet for messaging (can't send HTMLElement)
export function serializeTweet(tweet: Tweet): Omit<Tweet, 'element'> {
  const { element, ...serialized } = tweet;
  return serialized;
}
