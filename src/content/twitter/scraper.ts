import { Tweet } from '../../shared/types';
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

function parseTweetElement(element: HTMLElement): Tweet | null {
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
    const textElement = element.querySelector('[data-testid="tweetText"]');
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
  // Method 1: Try data-testid="quoteTweet" (standard)
  let quotedCard = element.querySelector('[data-testid="quoteTweet"]');

  // Method 2: Look for "Quote" label followed by role="link" card
  if (!quotedCard) {
    // Find span with "Quote" text
    const quoteLabels = element.querySelectorAll('span');
    for (const span of quoteLabels) {
      if (span.textContent?.trim() === 'Quote') {
        // The quote card is usually the next sibling with role="link"
        const parent = span.closest('div[class]');
        if (parent) {
          quotedCard = parent.parentElement?.querySelector('[role="link"]') || null;
        }
        break;
      }
    }
  }

  // Method 3: Look for nested tweetText (second occurrence is usually the quote)
  if (!quotedCard) {
    const tweetTexts = element.querySelectorAll('[data-testid="tweetText"]');
    if (tweetTexts.length >= 2) {
      // The second tweetText is in the quote - find its container
      quotedCard = tweetTexts[1].closest('[role="link"]');
    }
  }

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

  // Check for image/video in quoted tweet - try multiple selectors
  let quotedImageUrl: string | undefined;

  // Try tweetPhoto first
  const quotedImage = quotedCard.querySelector<HTMLImageElement>('[data-testid="tweetPhoto"] img');
  if (quotedImage?.src) {
    quotedImageUrl = quotedImage.src;
  }

  // Try video poster
  if (!quotedImageUrl) {
    const quotedVideo = quotedCard.querySelector<HTMLVideoElement>('video');
    if (quotedVideo?.poster) {
      quotedImageUrl = quotedVideo.poster;
    }
  }

  // Try any img with twitter media URL
  if (!quotedImageUrl) {
    const anyImg = quotedCard.querySelector<HTMLImageElement>('img[src*="pbs.twimg.com/media"]');
    if (anyImg?.src) {
      quotedImageUrl = anyImg.src;
    }
  }

  if (!quotedAuthor && !quotedText && !quotedImageUrl) return undefined;

  log.debug(` Parsed quote tweet - author=${quotedAuthor}, text="${quotedText?.slice(0, 30)}...", imageUrl=${quotedImageUrl?.slice(0, 50)}...`);

  return { author: quotedAuthor, text: quotedText, imageUrl: quotedImageUrl };
}

// Helper to find quote card using multiple methods
function findQuoteCard(element: HTMLElement): Element | null {
  // Method 1: data-testid="quoteTweet"
  let card = element.querySelector('[data-testid="quoteTweet"]');
  if (card) return card;

  // Method 2: Look for "Quote" label
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

  // Method 3: Nested tweetText
  const tweetTexts = element.querySelectorAll('[data-testid="tweetText"]');
  if (tweetTexts.length >= 2) {
    return tweetTexts[1].closest('[role="link"]');
  }

  return null;
}

function detectMediaType(element: HTMLElement): Tweet['mediaType'] {
  // Get the quote card to exclude its media from main tweet detection
  const quoteCard = findQuoteCard(element);

  // Check for video (excluding quoted content)
  const videos = element.querySelectorAll('video, [data-testid="videoPlayer"]');
  for (const video of videos) {
    if (!quoteCard?.contains(video)) {
      return 'video';
    }
  }

  // Check for GIF (excluding quoted content)
  const gifs = element.querySelectorAll('[data-testid="tweetPhoto"] img[src*="tweet_video_thumb"]');
  for (const gif of gifs) {
    if (!quoteCard?.contains(gif)) {
      return 'gif';
    }
  }

  // Check for images (excluding quoted content)
  const images = element.querySelectorAll('[data-testid="tweetPhoto"]');
  let mainTweetImages = 0;
  for (const img of images) {
    if (!quoteCard?.contains(img)) {
      mainTweetImages++;
    }
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
    if (!quoteCard?.contains(card)) {
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

  // Get the quote card to exclude its media
  const quoteCard = findQuoteCard(element);

  // Image URL from tweet photo (excluding quoted content)
  const photoImgs = element.querySelectorAll<HTMLImageElement>('[data-testid="tweetPhoto"] img');
  for (const photoImg of photoImgs) {
    if (!quoteCard?.contains(photoImg) && photoImg.src) {
      result.imageUrl = photoImg.src;
      result.thumbnailUrl = photoImg.src;
      break; // Take first main tweet image
    }
  }

  // Video poster/thumbnail (excluding quoted content)
  const videos = element.querySelectorAll<HTMLVideoElement>('video');
  for (const video of videos) {
    if (!quoteCard?.contains(video)) {
      result.videoUrl = video.src || video.querySelector('source')?.src;
      result.thumbnailUrl = video.poster || result.thumbnailUrl;
      break;
    }
  }

  return result;
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
