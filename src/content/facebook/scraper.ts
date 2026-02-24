import { FacebookPost } from '../../shared/types';
import { log } from '../../shared/constants';

// Scrape Facebook post data from DOM
// Facebook uses React SPA with heavily obfuscated CSS class names.
// All selectors use stable attributes (role, aria-label, data-*, href patterns).
// This scraper is intentionally forgiving — it's better to score a post with
// partial data than to skip it entirely.

export function scrapeVisiblePosts(): FacebookPost[] {
  const posts: FacebookPost[] = [];

  // Facebook feed posts are in div[role="article"] elements
  const articleElements = document.querySelectorAll<HTMLElement>('div[role="article"]');

  log.debug(`Facebook scraper: Found ${articleElements.length} article elements`);

  for (const element of articleElements) {
    // Skip loading placeholders
    if (element.querySelector('[aria-label="Loading..."]')) continue;

    // Skip nested articles (articles inside articles)
    const parentArticle = element.parentElement?.closest('div[role="article"]');
    if (parentArticle) continue;

    const post = parsePostElement(element);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}

function parsePostElement(element: HTMLElement): FacebookPost | null {
  try {
    // Extract author info — be forgiving, use "Unknown" as fallback
    const { authorDisplayName, authorUserId } = extractAuthorInfo(element);

    // Extract post text content
    const caption = extractContent(element);

    // Generate a post ID — always succeed via hash fallback
    const postId = extractPostId(element, authorDisplayName, caption);

    // If we have no author AND no content, skip this element (probably not a real post)
    if (!authorDisplayName && !caption) {
      log.debug('Facebook scraper: Skipping article with no author and no content');
      return null;
    }

    // Extract engagement metrics
    const { likeCount, commentCount } = extractEngagement(element);

    // Detect sponsored content
    const isSponsored = detectSponsored(element);

    // Detect feed type
    const { feedType, groupName, groupId } = detectFeedType();

    // Extract media info
    const { mediaType, imageUrl, videoUrl, thumbnailUrl } = extractMediaInfo(element);

    // Build permalink
    const permalink = buildPermalink(postId);

    const name = authorDisplayName || 'Unknown';

    return {
      id: postId,
      platform: 'facebook',
      author: name,
      authorDisplayName: name,
      authorUserId,
      text: caption,
      caption,
      score: likeCount,
      likeCount,
      numComments: commentCount,
      commentCount,
      mediaType,
      isSponsored,
      groupName,
      groupId,
      feedType,
      permalink,
      createdUtc: Date.now() / 1000,
      imageUrl,
      videoUrl,
      thumbnailUrl,
      element,
    };
  } catch (error) {
    log.error('Facebook: Failed to parse post element:', error);
    return null;
  }
}

function extractAuthorInfo(element: HTMLElement): {
  authorDisplayName: string;
  authorUserId?: string;
} {
  // Strategy 1: Look for the heading area — Facebook posts typically have
  // an h2, h3, or h4 with a link to the author's profile
  const headings = element.querySelectorAll<HTMLElement>('h2, h3, h4');
  for (const heading of headings) {
    const link = heading.querySelector<HTMLAnchorElement>('a');
    if (link) {
      const text = link.textContent?.trim() || '';
      if (text && text.length >= 2) {
        const userId = extractUserIdFromHref(link.getAttribute('href') || '');
        return { authorDisplayName: text, authorUserId: userId };
      }
    }
    // Some headings don't have links but contain the author name directly
    const text = heading.textContent?.trim() || '';
    if (text && text.length >= 2 && text.length < 100) {
      return { authorDisplayName: text };
    }
  }

  // Strategy 2: Look for strong tags containing links (common Facebook pattern)
  const strongLinks = element.querySelectorAll<HTMLAnchorElement>('strong a');
  for (const link of strongLinks) {
    const text = link.textContent?.trim() || '';
    if (text && text.length >= 2 && !isUiText(text)) {
      const userId = extractUserIdFromHref(link.getAttribute('href') || '');
      return { authorDisplayName: text, authorUserId: userId };
    }
  }

  // Strategy 3: Profile link patterns
  const profileSelectors = [
    'a[href*="/user/"]',
    'a[href*="/profile.php"]',
    'a[href*="facebook.com/"][aria-label]',
  ];

  for (const selector of profileSelectors) {
    const links = element.querySelectorAll<HTMLAnchorElement>(selector);
    for (const link of links) {
      const text = link.textContent?.trim() ||
                   link.getAttribute('aria-label')?.trim() || '';
      if (text && text.length >= 2 && !isUiText(text)) {
        const userId = extractUserIdFromHref(link.getAttribute('href') || '');
        return { authorDisplayName: text, authorUserId: userId };
      }
    }
  }

  // Strategy 4: First a[role="link"] with non-UI text
  const roleLinks = element.querySelectorAll<HTMLAnchorElement>('a[role="link"]');
  for (const link of roleLinks) {
    const text = link.textContent?.trim() || '';
    const href = link.getAttribute('href') || '';
    // Must have text, not be UI text, and link somewhere meaningful
    if (text && text.length >= 2 && text.length < 80 && !isUiText(text) &&
        !text.includes('http') && href && !href.includes('#')) {
      const userId = extractUserIdFromHref(href);
      return { authorDisplayName: text, authorUserId: userId };
    }
  }

  // Strategy 5: aria-label on the article itself sometimes contains author info
  const ariaLabel = element.getAttribute('aria-label') || '';
  // Pattern: "Post by John Smith" or similar
  const byMatch = ariaLabel.match(/(?:Post|Story|Update)\s+by\s+(.+)/i);
  if (byMatch) {
    return { authorDisplayName: byMatch[1].trim() };
  }

  return { authorDisplayName: '' };
}

function extractUserIdFromHref(href: string): string | undefined {
  const userIdMatch = href.match(/\/user\/(\d+)/);
  if (userIdMatch) return userIdMatch[1];
  const profileIdMatch = href.match(/profile\.php\?id=(\d+)/);
  if (profileIdMatch) return profileIdMatch[1];
  return undefined;
}

function isUiText(text: string): boolean {
  return /^(Like|Comment|Share|Reply|See\s+more|View\s|Send|Follow|Add\s+friend|Message|\d+\s*(h|m|d|w|y|hr|min|sec)|Just now|Yesterday)$/i.test(text);
}

function extractContent(element: HTMLElement): string {
  // Collect text from dir="auto" elements (Facebook's standard text containers)
  const textParts: string[] = [];
  const textElements = element.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]');

  for (const el of textElements) {
    const text = el.textContent?.trim() || '';
    if (!text) continue;

    // Skip if inside a button or navigation
    if (el.closest('[role="button"], [role="navigation"], [role="toolbar"]')) continue;

    // Skip very short non-word text
    if (text.length < 3 && !text.match(/\w/)) continue;

    // Skip duplicate text from nested elements
    if (textParts.some(existing => existing.includes(text) || text.includes(existing))) continue;

    textParts.push(text);
  }

  // If dir="auto" found nothing, try a broader approach
  if (textParts.length === 0) {
    // Look for the main content area — typically a div after the header
    const allText = element.textContent?.trim() || '';
    if (allText.length > 20) {
      // Take a reasonable chunk avoiding the very beginning (author name) and end (UI elements)
      return allText.slice(0, 500);
    }
  }

  return textParts.join(' ').trim();
}

function extractPostId(element: HTMLElement, author: string, content: string): string {
  // Look for permalink patterns in links
  const allLinks = element.querySelectorAll<HTMLAnchorElement>('a[href]');
  for (const link of allLinks) {
    const href = link.getAttribute('href') || '';

    // Extract ID from various Facebook URL patterns
    const fbidMatch = href.match(/fbid=(\d+)/);
    if (fbidMatch) return `fb_${fbidMatch[1]}`;

    const postsMatch = href.match(/\/posts\/([a-zA-Z0-9_]+)/);
    if (postsMatch) return `fb_${postsMatch[1]}`;

    const storyMatch = href.match(/story_fbid=(\d+)/);
    if (storyMatch) return `fb_${storyMatch[1]}`;

    const permalinkMatch = href.match(/\/permalink\/(\d+)/);
    if (permalinkMatch) return `fb_${permalinkMatch[1]}`;

    const photosMatch = href.match(/\/photos\/[^/]*\/(\d+)/);
    if (photosMatch) return `fb_${photosMatch[1]}`;

    const videosMatch = href.match(/\/videos\/(\d+)/);
    if (videosMatch) return `fb_${videosMatch[1]}`;

    // Facebook pfbid pattern (newer format)
    const pfbidMatch = href.match(/(pfbid[a-zA-Z0-9]+)/);
    if (pfbidMatch) return `fb_${pfbidMatch[1]}`;
  }

  // Fallback: hash of author + content for uniqueness
  const hashInput = `${author}:${content.slice(0, 200)}`;
  return `fb_hash_${simpleHash(hashInput)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function extractEngagement(element: HTMLElement): {
  likeCount: number | null;
  commentCount: number;
} {
  let likeCount: number | null = null;
  let commentCount = 0;

  // Look for reaction counts in aria-label attributes
  const ariaElements = element.querySelectorAll<HTMLElement>('[aria-label]');
  for (const el of ariaElements) {
    const label = el.getAttribute('aria-label') || '';

    // Reaction count patterns — various formats Facebook uses
    const reactionMatch = label.match(/([\d,.]+[KMB]?)\s*(reactions?|people reacted|likes?|others)/i);
    if (reactionMatch && likeCount === null) {
      likeCount = parseCount(reactionMatch[1]);
    }

    // Comment count patterns
    const commentMatch = label.match(/([\d,.]+[KMB]?)\s*comments?/i);
    if (commentMatch && commentCount === 0) {
      commentCount = parseCount(commentMatch[1]) || 0;
    }
  }

  // Fallback: look for text patterns
  if (likeCount === null) {
    // Look for spans/divs near reaction emoji icons
    const spans = element.querySelectorAll<HTMLElement>('span[role="toolbar"] ~ div span, span');
    for (const span of spans) {
      const text = span.textContent?.trim() || '';
      // Match standalone numbers that could be reaction counts
      if (text.match(/^[\d,.]+[KMB]?$/) && !text.includes(':')) {
        const count = parseCount(text);
        if (count !== null && count > 0 && likeCount === null) {
          likeCount = count;
        }
      }
    }
  }

  return { likeCount, commentCount };
}

function detectSponsored(element: HTMLElement): boolean {
  // Check for "Sponsored" link text
  const links = element.querySelectorAll<HTMLAnchorElement>('a');
  for (const link of links) {
    const text = link.textContent?.trim().toLowerCase() || '';
    if (text === 'sponsored') return true;
  }

  // Check for ad-specific attributes
  if (element.querySelector('[data-ad-rendering-role]')) return true;

  // Check aria-label
  const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
  if (ariaLabel.includes('sponsored')) return true;

  return false;
}

function detectFeedType(): {
  feedType: FacebookPost['feedType'];
  groupName?: string;
  groupId?: string;
} {
  const pathname = window.location.pathname;

  const groupMatch = pathname.match(/^\/groups\/([^/]+)/);
  if (groupMatch) {
    const groupId = groupMatch[1];
    const groupNameEl = document.querySelector('h1') || document.querySelector('[role="heading"]');
    const groupName = groupNameEl?.textContent?.trim();
    return { feedType: 'group', groupName, groupId };
  }

  if (pathname === '/' || pathname === '') {
    return { feedType: 'news-feed' };
  }

  return { feedType: 'unknown' };
}

function extractMediaInfo(element: HTMLElement): {
  mediaType: FacebookPost['mediaType'];
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
} {
  let mediaType: FacebookPost['mediaType'] = 'text';
  let imageUrl: string | undefined;
  let videoUrl: string | undefined;
  let thumbnailUrl: string | undefined;

  // Check for video
  const video = element.querySelector<HTMLVideoElement>('video');
  if (video) {
    mediaType = 'video';
    thumbnailUrl = video.poster || undefined;
    if (video.src && !video.src.startsWith('blob:')) {
      videoUrl = video.src;
    }
  }

  // Check for images — Facebook CDN uses scontent and fbcdn domains
  const images = element.querySelectorAll<HTMLImageElement>('img');
  for (const img of images) {
    const src = img.src || '';
    // Skip small images (profile pics, emoji, icons)
    if (img.width && img.width < 100) continue;
    if (img.height && img.height < 100) continue;
    // Skip data URIs and tracking pixels
    if (src.startsWith('data:')) continue;
    if (src.includes('pixel') || src.includes('tr?')) continue;

    // Facebook CDN patterns
    if (src.includes('scontent') || src.includes('fbcdn') || src.includes('facebook.com')) {
      if (!imageUrl) {
        imageUrl = src;
        thumbnailUrl = thumbnailUrl || src;
        if (mediaType === 'text') {
          mediaType = 'image';
        }
      }
    }
  }

  return { mediaType, imageUrl, videoUrl, thumbnailUrl };
}

function parseCount(text: string): number | null {
  if (!text) return null;

  const normalized = text.toUpperCase().replace(/,/g, '').trim();
  const match = normalized.match(/^([\d.]+)\s*([KMB])?$/);

  if (!match) return null;

  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;

  const suffix = match[2];
  switch (suffix) {
    case 'K': return Math.round(num * 1000);
    case 'M': return Math.round(num * 1000000);
    case 'B': return Math.round(num * 1000000000);
    default: return Math.round(num);
  }
}

function buildPermalink(postId: string): string {
  const rawId = postId.replace(/^fb_/, '').replace(/^hash_.*$/, '');
  if (rawId && /^\d+$/.test(rawId)) {
    return `https://www.facebook.com/permalink.php?story_fbid=${rawId}`;
  }
  if (rawId && rawId.startsWith('pfbid')) {
    return `https://www.facebook.com/${rawId}`;
  }
  return `https://www.facebook.com`;
}

// Serialize post for messaging (can't send HTMLElement)
export function serializePost(post: FacebookPost): Omit<FacebookPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
