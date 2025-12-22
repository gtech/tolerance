import { InstagramPost } from '../../shared/types';
import { log } from '../../shared/constants';

// Scrape Instagram post data from DOM
// Based on actual Instagram DOM structure as of Dec 2025

export function scrapeVisiblePosts(): InstagramPost[] {
  const posts: InstagramPost[] = [];

  // Instagram feed posts are in article elements, often with __igdl_id attribute
  const articleElements = document.querySelectorAll<HTMLElement>('article');

  for (const element of articleElements) {
    const post = parsePostElement(element);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}

function parsePostElement(element: HTMLElement): InstagramPost | null {
  try {
    // Skip if this is not a valid feed post
    if (!isValidFeedPost(element)) {
      return null;
    }

    // Get post ID - prefer shortcode (stable) over __igdl_id (can change on DOM recreate)
    const shortcode = extractShortcode(element);
    let id = shortcode || element.getAttribute('__igdl_id');

    if (!id) {
      log.debug('Instagram: Could not extract post ID');
      return null;
    }

    // Extract author info
    const { author, authorUsername, authorProfilePic, isVerified } = extractAuthorInfo(element);
    if (!author) {
      log.debug('Instagram: Could not extract author');
      return null;
    }

    // Extract caption
    const caption = extractCaption(element);

    // Extract engagement metrics
    const { likeCount, commentCount } = extractEngagement(element);

    // Detect media type
    const { mediaType, isReel, isCarousel, carouselCount, thumbnailUrl, imageUrl, videoUrl, hasAudio } =
      extractMediaInfo(element);

    // Extract permalink
    const permalink = shortcode
      ? `https://www.instagram.com/p/${shortcode}/`
      : `https://www.instagram.com/p/${id}/`;

    // Check if sponsored
    const isSponsored = detectSponsored(element);

    // Timestamp
    const createdUtc = extractTimestamp(element) || Date.now() / 1000;

    return {
      id,
      platform: 'instagram',
      author,
      authorUsername,
      authorProfilePic,
      text: caption,
      caption,
      score: likeCount,
      likeCount,
      numComments: commentCount,
      commentCount,
      mediaType,
      isReel,
      isCarousel,
      carouselCount,
      hasAudio,
      isSponsored,
      permalink,
      createdUtc,
      thumbnailUrl,
      imageUrl,
      videoUrl,
      element,
    };
  } catch (error) {
    log.error('Instagram: Failed to parse post element:', error);
    return null;
  }
}

function isValidFeedPost(element: HTMLElement): boolean {
  // Must have visual content (image or video)
  const hasMedia = element.querySelector('img, video') !== null;
  if (!hasMedia) return false;

  // Should have engagement actions (like, comment buttons)
  const hasActions = element.querySelector('svg[aria-label="Like"], svg[aria-label="Comment"]') !== null;

  // Should be in main content area
  const isInMain = element.closest('main') !== null ||
                   element.closest('[role="main"]') !== null;

  return hasActions || isInMain;
}

function extractShortcode(element: HTMLElement): string | null {
  // Look for permalink with /p/{shortcode}/ or /reel/{shortcode}/ pattern
  const links = element.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"], a[href*="/reel/"]');

  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/);
    if (match) {
      return match[2];
    }
  }

  return null;
}

function extractAuthorInfo(element: HTMLElement): {
  author: string;
  authorUsername: string;
  authorProfilePic?: string;
  isVerified?: boolean;
} {
  // Look for the username link - class pattern includes _a6hd and href starts with /
  // Username links are typically in header area and link to /{username}/
  const headerLinks = element.querySelectorAll<HTMLAnchorElement>('a[href^="/"]');

  for (const link of headerLinks) {
    const href = link.getAttribute('href') || '';
    // Skip post links, explore links, tags
    if (href.includes('/p/') || href.includes('/reel/') ||
        href.includes('/explore/') || href.includes('/tags/')) {
      continue;
    }

    // Username pattern: /username/ (just username, no paths)
    const match = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
    if (match) {
      const username = match[1];

      // Look for profile picture
      const profileImg = element.querySelector<HTMLImageElement>(
        `img[alt*="${username}"], img[alt*="profile picture"]`
      );

      // Check for verified badge near username
      const verifiedBadge = link.closest('div')?.querySelector('svg[aria-label="Verified"]');
      const isVerified = verifiedBadge !== null;

      return {
        author: username,
        authorUsername: `@${username}`,
        authorProfilePic: profileImg?.src,
        isVerified,
      };
    }
  }

  // Fallback: look for span with specific Instagram classes that contain username
  const usernameSpans = element.querySelectorAll('span._ap3a._aaco._aacw._aacx._aad7._aade');
  for (const span of usernameSpans) {
    const text = span.textContent?.trim();
    if (text && /^[a-zA-Z0-9._]+$/.test(text)) {
      return {
        author: text,
        authorUsername: `@${text}`,
      };
    }
  }

  return { author: '', authorUsername: '' };
}

function extractCaption(element: HTMLElement): string {
  // Captions use specific Instagram classes: _ap3a _aaco _aacu _aacx _aad7 _aade
  // The caption typically comes after the username in the caption section
  const captionSpans = element.querySelectorAll<HTMLElement>('span._ap3a._aaco._aacu._aacx._aad7._aade');

  for (const span of captionSpans) {
    const text = span.textContent?.trim() || '';
    // Caption is usually longer and not just a username
    if (text.length > 0 && !text.match(/^[a-zA-Z0-9._]+$/)) {
      return text;
    }
  }

  // Fallback: look for text content in the section below the media
  const sections = element.querySelectorAll('section');
  for (const section of sections) {
    // Skip the action buttons section (like, comment, share)
    if (section.querySelector('svg[aria-label="Like"]')) continue;

    const text = section.textContent?.trim() || '';
    if (text.length > 20) {
      // Extract just the caption part (after username)
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length > 1) {
        return lines.slice(1).join(' ').trim();
      }
    }
  }

  return '';
}

function extractEngagement(element: HTMLElement): {
  likeCount: number | null;
  commentCount: number;
} {
  let likeCount: number | null = null;
  let commentCount = 0;

  // Like and comment counts appear in spans with classes: x1ypdohk x1s688f x2fvf9 xe9ewy2
  // They appear after the respective buttons
  const countSpans = element.querySelectorAll<HTMLElement>(
    'span.x1ypdohk.x1s688f.x2fvf9.xe9ewy2, span[role="button"]'
  );

  let foundLike = false;
  let foundComment = false;

  for (const span of countSpans) {
    const text = span.textContent?.trim() || '';
    if (!text) continue;

    // Check if this span follows a like button
    const prevSvg = span.previousElementSibling?.querySelector?.('svg[aria-label="Like"]') ||
                    span.closest('section')?.querySelector('svg[aria-label="Like"]');

    if (prevSvg && !foundLike) {
      const count = parseCount(text);
      if (count !== null && count >= 0) {
        likeCount = count;
        foundLike = true;
        continue;
      }
    }

    // Check if near a comment button
    const commentSvg = span.closest('section')?.querySelector('svg[aria-label="Comment"]');
    if (commentSvg && !foundComment && foundLike) {
      const count = parseCount(text);
      if (count !== null && count >= 0) {
        commentCount = count;
        foundComment = true;
      }
    }
  }

  // Fallback: look for patterns like "138.7K" after like button
  if (likeCount === null) {
    const likeButton = element.querySelector('[aria-label="Like"]');
    if (likeButton) {
      const section = likeButton.closest('section');
      if (section) {
        const allSpans = section.querySelectorAll('span');
        for (const span of allSpans) {
          const text = span.textContent?.trim() || '';
          if (text.match(/^[\d,.]+[KMB]?$/i)) {
            const count = parseCount(text);
            if (count !== null && count > 0) {
              if (likeCount === null) {
                likeCount = count;
              } else if (commentCount === 0) {
                commentCount = count;
                break;
              }
            }
          }
        }
      }
    }
  }

  // Another fallback: look for "likes" text
  const textContent = element.textContent || '';
  const likesMatch = textContent.match(/([\d,.]+[KMB]?)\s*likes?/i);
  if (likesMatch && likeCount === null) {
    likeCount = parseCount(likesMatch[1]);
  }

  const commentsMatch = textContent.match(/View\s+all\s+([\d,]+)\s+comments?/i);
  if (commentsMatch && commentCount === 0) {
    commentCount = parseCount(commentsMatch[1]) || 0;
  }

  return { likeCount, commentCount };
}

function extractMediaInfo(element: HTMLElement): {
  mediaType: InstagramPost['mediaType'];
  isReel: boolean;
  isCarousel: boolean;
  carouselCount?: number;
  thumbnailUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  hasAudio?: boolean;
} {
  let mediaType: InstagramPost['mediaType'] = 'image';
  let isReel = false;
  let isCarousel = false;
  let carouselCount: number | undefined;
  let thumbnailUrl: string | undefined;
  let imageUrl: string | undefined;
  let videoUrl: string | undefined;
  let hasAudio: boolean | undefined;

  // Check for video (Reel or regular video)
  const video = element.querySelector<HTMLVideoElement>('video');
  if (video) {
    mediaType = 'video';
    // Video src might be a blob URL, try to get poster
    thumbnailUrl = video.poster || undefined;
    if (video.src && !video.src.startsWith('blob:')) {
      videoUrl = video.src;
    }

    // Check if it's a Reel
    const shortcode = extractShortcode(element);
    const reelLinks = element.querySelectorAll('a[href*="/reel/"]');
    isReel = reelLinks.length > 0;

    if (isReel) {
      mediaType = 'reel';
    }

    // Check for audio controls
    const audioControl = element.querySelector(
      'button[aria-label*="audio" i], svg[aria-label*="Audio" i], svg[aria-label*="muted" i]'
    );
    hasAudio = audioControl !== null;
  }

  // Check for images (get the main content image, not profile pics)
  const images = element.querySelectorAll<HTMLImageElement>('img');
  for (const img of images) {
    const src = img.src || '';
    const alt = img.alt || '';

    // Skip profile pictures
    if (alt.includes('profile picture')) continue;

    // Skip small images (likely icons)
    if (img.naturalWidth && img.naturalWidth < 100) continue;

    // Instagram CDN images
    if (src.includes('instagram') || src.includes('cdninstagram') || src.includes('fbcdn')) {
      if (!imageUrl) {
        imageUrl = src;
        thumbnailUrl = thumbnailUrl || src;
      }
    }
  }

  // Check for carousel indicators
  // Carousel has navigation arrows or indicator dots
  const nextButton = element.querySelector('[aria-label*="Next" i]');
  const prevButton = element.querySelector('[aria-label*="Previous" i]');
  const carouselDots = element.querySelectorAll('[role="button"]').length;

  if (nextButton || prevButton) {
    isCarousel = true;
    mediaType = video ? 'gallery' : 'gallery'; // Gallery can contain mix

    // Try to count carousel items from dot indicators or navigation
    // This is approximate
    if (carouselDots > 5) {
      carouselCount = carouselDots - 4; // Subtract action buttons
    }
  }

  return { mediaType, isReel, isCarousel, carouselCount, thumbnailUrl, imageUrl, videoUrl, hasAudio };
}

function detectSponsored(element: HTMLElement): boolean {
  const text = element.textContent?.toLowerCase() || '';
  return text.includes('sponsored') ||
         text.includes('paid partnership') ||
         element.querySelector('[aria-label*="sponsored" i]') !== null;
}

function extractTimestamp(element: HTMLElement): number | null {
  // Look for time element with datetime attribute
  const timeElement = element.querySelector('time');
  if (timeElement) {
    const datetime = timeElement.getAttribute('datetime');
    if (datetime) {
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        return date.getTime() / 1000;
      }
    }

    // Try title attribute which often has full date
    const title = timeElement.getAttribute('title');
    if (title) {
      const date = new Date(title);
      if (!isNaN(date.getTime())) {
        return date.getTime() / 1000;
      }
    }

    // Parse relative time from text content
    const relativeText = timeElement.textContent?.trim() || '';
    return parseRelativeTime(relativeText);
  }

  return null;
}

function parseRelativeTime(text: string): number | null {
  const now = Date.now() / 1000;

  // Patterns: "21h", "2d", "1w", "3m" (minutes), "2mo" (months)
  const match = text.match(/^(\d+)\s*(s|m|h|d|w|mo|y)/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return now - (value);
    case 'm': return now - (value * 60);
    case 'h': return now - (value * 3600);
    case 'd': return now - (value * 86400);
    case 'w': return now - (value * 604800);
    case 'mo': return now - (value * 2592000); // ~30 days
    case 'y': return now - (value * 31536000);
    default: return null;
  }
}

function parseCount(text: string): number | null {
  if (!text) return null;

  // Remove commas and normalize
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

// Serialize post for messaging (can't send HTMLElement)
export function serializePost(post: InstagramPost): Omit<InstagramPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
