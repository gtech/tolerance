import { FacebookPost } from '../../shared/types';
import { log } from '../../shared/constants';

// Scrape Facebook post data from DOM
// Facebook uses React SPA with heavily obfuscated CSS class names.
// All selectors use stable attributes (role, aria-label, data-*, href patterns).

export function scrapeVisiblePosts(): FacebookPost[] {
  const posts: FacebookPost[] = [];

  // Facebook feed posts are in div[role="article"] elements
  const articleElements = document.querySelectorAll<HTMLElement>('div[role="article"]');

  for (const element of articleElements) {
    // Skip loading placeholders
    if (element.querySelector('[aria-label="Loading..."]')) continue;

    const post = parsePostElement(element);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}

function parsePostElement(element: HTMLElement): FacebookPost | null {
  try {
    // Extract author info
    const { authorDisplayName, authorUserId } = extractAuthorInfo(element);
    if (!authorDisplayName) {
      return null;
    }

    // Extract post text content
    const caption = extractContent(element);

    // Extract post ID from permalink links
    const postId = extractPostId(element);
    if (!postId) {
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

    return {
      id: postId,
      platform: 'facebook',
      author: authorDisplayName,
      authorDisplayName,
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
  // Look for profile links within the article
  // Facebook profile links use patterns like /user/{id}, /profile.php?id={id}, or /{username}
  const profilePatterns = [
    'a[href*="/user/"]',
    'a[href*="/profile.php"]',
    'a[href*="facebook.com/"][role="link"]',
  ];

  for (const pattern of profilePatterns) {
    const links = element.querySelectorAll<HTMLAnchorElement>(pattern);
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const text = link.textContent?.trim() || '';

      // Skip empty text, very short text, or navigation-like links
      if (!text || text.length < 2) continue;
      // Skip links that look like "Like", "Comment", "Share", timestamps
      if (/^(Like|Comment|Share|Reply|\d+\s*(h|m|d|w|y)|See\s+more)$/i.test(text)) continue;

      // Extract user ID from href
      let userId: string | undefined;
      const userIdMatch = href.match(/\/user\/(\d+)/);
      if (userIdMatch) userId = userIdMatch[1];
      const profileIdMatch = href.match(/profile\.php\?id=(\d+)/);
      if (profileIdMatch) userId = profileIdMatch[1];

      return { authorDisplayName: text, authorUserId: userId };
    }
  }

  // Fallback: look for strong or heading-like elements near the top of the article
  // that contain profile links
  const strongLinks = element.querySelectorAll<HTMLAnchorElement>('strong a[role="link"], h2 a[role="link"], h3 a[role="link"]');
  for (const link of strongLinks) {
    const text = link.textContent?.trim() || '';
    if (text && text.length >= 2) {
      return { authorDisplayName: text };
    }
  }

  // Last fallback: first a[role="link"] with substantial text
  const roleLinks = element.querySelectorAll<HTMLAnchorElement>('a[role="link"]');
  for (const link of roleLinks) {
    const text = link.textContent?.trim() || '';
    const href = link.getAttribute('href') || '';
    if (text && text.length >= 2 && !text.includes('http') &&
        !/^(Like|Comment|Share|Reply|See\s|View\s|\d)/.test(text) &&
        (href.includes('facebook.com') || href.startsWith('/'))) {
      return { authorDisplayName: text };
    }
  }

  return { authorDisplayName: '' };
}

function extractContent(element: HTMLElement): string {
  // Collect text from dir="auto" elements (Facebook's standard text containers)
  const textParts: string[] = [];
  const textElements = element.querySelectorAll<HTMLElement>('div[dir="auto"], span[dir="auto"]');

  for (const el of textElements) {
    const text = el.textContent?.trim() || '';
    if (!text) continue;

    // Skip button/nav text
    if (el.closest('div[role="button"], a[role="link"], [role="navigation"]')) continue;

    // Skip very short text that's likely UI elements
    if (text.length < 3 && !text.match(/\w/)) continue;

    // Skip duplicate text from nested elements
    if (textParts.includes(text)) continue;

    textParts.push(text);
  }

  return textParts.join(' ').trim();
}

function extractPostId(element: HTMLElement): string | null {
  // Look for permalink patterns in links
  const linkPatterns = [
    'a[href*="fbid="]',
    'a[href*="/posts/"]',
    'a[href*="story_fbid"]',
    'a[href*="/permalink/"]',
    'a[href*="/photos/"]',
    'a[href*="/videos/"]',
  ];

  for (const pattern of linkPatterns) {
    const links = element.querySelectorAll<HTMLAnchorElement>(pattern);
    for (const link of links) {
      const href = link.getAttribute('href') || '';

      // Extract ID from various patterns
      const fbidMatch = href.match(/fbid=(\d+)/);
      if (fbidMatch) return `fb_${fbidMatch[1]}`;

      const postsMatch = href.match(/\/posts\/([a-zA-Z0-9_]+)/);
      if (postsMatch) return `fb_${postsMatch[1]}`;

      const storyMatch = href.match(/story_fbid=(\d+)/);
      if (storyMatch) return `fb_${storyMatch[1]}`;

      const permalinkMatch = href.match(/\/permalink\/(\d+)/);
      if (permalinkMatch) return `fb_${permalinkMatch[1]}`;

      const photosMatch = href.match(/\/photos\/[^/]+\/(\d+)/);
      if (photosMatch) return `fb_${photosMatch[1]}`;

      const videosMatch = href.match(/\/videos\/(\d+)/);
      if (videosMatch) return `fb_${videosMatch[1]}`;
    }
  }

  // Fallback: hash of author + content for uniqueness
  const author = extractAuthorInfo(element).authorDisplayName;
  const text = element.textContent?.slice(0, 200) || '';
  if (author || text) {
    const hash = simpleHash(`${author}:${text}`);
    return `fb_hash_${hash}`;
  }

  return null;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
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
  // e.g., aria-label="23 reactions, including Like and Love"
  const ariaElements = element.querySelectorAll<HTMLElement>('[aria-label]');
  for (const el of ariaElements) {
    const label = el.getAttribute('aria-label') || '';

    // Reaction count patterns
    const reactionMatch = label.match(/^([\d,.]+[KMB]?)\s*(reactions?|people reacted|likes?)/i);
    if (reactionMatch && likeCount === null) {
      likeCount = parseCount(reactionMatch[1]);
    }

    // Also look for "N comments" pattern
    const commentMatch = label.match(/([\d,.]+[KMB]?)\s*comments?/i);
    if (commentMatch && commentCount === 0) {
      commentCount = parseCount(commentMatch[1]) || 0;
    }
  }

  // Fallback: look for text patterns in the engagement area
  if (likeCount === null) {
    const textContent = element.textContent || '';
    // Pattern: "1.2K" or "23" near reaction emoji area
    const likeMatch = textContent.match(/([\d,.]+[KMB]?)\s*(?:reaction|like|people reacted)/i);
    if (likeMatch) {
      likeCount = parseCount(likeMatch[1]);
    }
  }

  return { likeCount, commentCount };
}

function detectSponsored(element: HTMLElement): boolean {
  // Check for "Sponsored" text in the metadata area
  const links = element.querySelectorAll<HTMLAnchorElement>('a[role="link"]');
  for (const link of links) {
    if (link.textContent?.trim().toLowerCase() === 'sponsored') {
      return true;
    }
  }

  // Check for ad-specific attributes
  if (element.querySelector('[data-ad-rendering-role]')) {
    return true;
  }

  // Check for "Paid partnership" text
  const text = element.textContent?.toLowerCase() || '';
  if (text.includes('paid partnership') || text.includes('sponsored')) {
    // Verify it's in the header area, not in a comment
    const headerArea = element.querySelector('h2, h3, [role="heading"]');
    if (headerArea) {
      const headerText = headerArea.textContent?.toLowerCase() || '';
      if (headerText.includes('sponsored')) return true;
    }
  }

  return false;
}

function detectFeedType(): {
  feedType: FacebookPost['feedType'];
  groupName?: string;
  groupId?: string;
} {
  const pathname = window.location.pathname;

  // Group feed: /groups/{id}/
  const groupMatch = pathname.match(/^\/groups\/(\d+|[a-zA-Z0-9_.]+)/);
  if (groupMatch) {
    const groupId = groupMatch[1];
    // Try to get group name from page title or header
    const groupNameEl = document.querySelector('h1') || document.querySelector('[role="heading"]');
    const groupName = groupNameEl?.textContent?.trim();
    return { feedType: 'group', groupName, groupId };
  }

  // Home feed: / or empty path
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

  // Check for images (exclude small profile pics)
  const images = element.querySelectorAll<HTMLImageElement>('img[src*="scontent"]');
  for (const img of images) {
    // Skip small images (profile pics are typically < 100px)
    if (img.width && img.width < 100) continue;
    if (img.height && img.height < 100) continue;

    const src = img.src || '';
    if (src) {
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
  // Strip our prefix to get the raw Facebook ID
  const rawId = postId.replace(/^fb_/, '').replace(/^hash_.*$/, '');
  if (rawId && /^\d+$/.test(rawId)) {
    return `https://www.facebook.com/permalink.php?story_fbid=${rawId}`;
  }
  return `https://www.facebook.com`;
}

// Serialize post for messaging (can't send HTMLElement)
export function serializePost(post: FacebookPost): Omit<FacebookPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
