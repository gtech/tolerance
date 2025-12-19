import { YouTubeVideo } from '../../shared/types';
import { log } from '../../shared/constants';

// Scrape video data from YouTube DOM
// YouTube uses custom web components (ytd-*) for its UI

export function scrapeVisibleVideos(): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];

  // Homepage videos (rich grid)
  const homeVideos = document.querySelectorAll<HTMLElement>('ytd-rich-item-renderer');

  // Sidebar recommendations (compact) - legacy and new lockup model
  const sidebarVideos = document.querySelectorAll<HTMLElement>('ytd-compact-video-renderer');

  // New sidebar/recommendations using lockup view model (horizontal layout)
  const lockupVideos = document.querySelectorAll<HTMLElement>('yt-lockup-view-model.yt-lockup-view-model--wrapper');

  // Search results and other video lists
  const listVideos = document.querySelectorAll<HTMLElement>('ytd-video-renderer');

  log.debug(` Found ${homeVideos.length} home, ${sidebarVideos.length} sidebar, ${lockupVideos.length} lockup, ${listVideos.length} list videos`);

  for (const element of [...homeVideos, ...sidebarVideos, ...lockupVideos, ...listVideos]) {
    const video = parseVideoElement(element);
    if (video) {
      videos.push(video);
    }
  }

  log.debug(` Scraped ${videos.length} valid videos`);
  return videos;
}

function parseVideoElement(element: HTMLElement): YouTubeVideo | null {
  try {
    // Extract video ID from href - YouTube now uses multiple link structures
    const link = element.querySelector<HTMLAnchorElement>(
      'a[href*="/watch?v="], a[href*="/shorts/"], a.yt-lockup-view-model__content-image'
    );
    const href = link?.getAttribute('href') || '';

    // Handle both regular videos and Shorts
    let id: string | null = null;
    let isShort = false;

    const watchMatch = href.match(/[?&]v=([a-zA-Z0-9_-]+)/);
    const shortsMatch = href.match(/\/shorts\/([a-zA-Z0-9_-]+)/);

    if (watchMatch) {
      id = watchMatch[1];
    } else if (shortsMatch) {
      id = shortsMatch[1];
      isShort = true;
    }

    if (!id) {
      // Debug: log what we found (only for non-ad elements)
      const anyLink = element.querySelector('a');
      const anyHref = anyLink?.getAttribute('href') || '';
      if (!anyHref.includes('googleadservices')) {
        log.debug(' No video ID found, href:', href, 'any link href:', anyHref);
      }
      return null;
    }

    // Get title - YouTube uses multiple title structures
    // Try new lockup model first, then legacy selectors
    const titleElement = element.querySelector(
      '.yt-lockup-metadata-view-model__title, ' +          // New lockup model
      'a.yt-lockup-metadata-view-model__title, ' +         // New lockup model (link)
      'h3[title], ' +                                       // h3 with title attribute
      '#video-title, ' +                                    // Legacy selector
      '#video-title-link, ' +                               // Legacy selector
      '.title'                                              // Generic fallback
    ) as HTMLElement;

    // Get title from element text or title attribute
    let title = titleElement?.textContent?.trim() || '';
    if (!title && titleElement) {
      title = titleElement.getAttribute('title') || '';
    }
    // Also check parent h3 for title attribute
    if (!title) {
      const h3 = element.querySelector('h3[title]');
      title = h3?.getAttribute('title') || '';
    }

    if (!title) {
      log.debug(' No title found for video', id);
      return null;
    }

    // Get channel name - try new and legacy selectors
    const channelElement = element.querySelector(
      '.yt-content-metadata-view-model__metadata-row a[href^="/@"], ' +  // New model (channel link)
      'a[href^="/@"], ' +                                                 // Any channel link
      '#channel-name, ' +                                                 // Legacy
      '.ytd-channel-name, ' +                                             // Legacy
      '[id*="channel"]'                                                   // Fallback
    );
    const channel = channelElement?.textContent?.trim() || '';

    // Get metadata (views and date) - try new and legacy selectors
    const metadataElement = element.querySelector(
      '.yt-content-metadata-view-model, ' +       // New lockup model
      '.yt-content-metadata-view-model__metadata-row, ' +  // New model row
      '#metadata-line, ' +                         // Legacy
      '.ytd-video-meta-block, ' +                  // Legacy
      '#metadata'                                  // Fallback
    );
    const metadataText = metadataElement?.textContent || '';

    const viewCount = parseViewCount(metadataText);
    const uploadDate = parseUploadDate(metadataText);

    // Get duration - try new badge shape and legacy selectors
    const durationElement = element.querySelector(
      '.yt-badge-shape__text, ' +                              // New badge model
      'badge-shape .yt-badge-shape__text, ' +                  // New badge model (nested)
      'span.ytd-thumbnail-overlay-time-status-renderer, ' +    // Legacy
      '.badge-shape-wiz__text'                                 // Legacy fallback
    );
    const duration = durationElement?.textContent?.trim();

    // Check if it's a live stream
    const isLive = metadataText.toLowerCase().includes('watching') ||
                   element.querySelector('[overlay-style="LIVE"]') !== null;

    // Get thumbnail URL - try new and legacy selectors
    const thumbnailImg = element.querySelector<HTMLImageElement>(
      '.ytThumbnailViewModelImage img, ' +    // New thumbnail model
      'img.ytCoreImageHost, ' +               // New core image
      '#thumbnail img, ' +                    // Legacy
      'img.yt-core-image'                     // Fallback
    );
    const thumbnailUrl = thumbnailImg?.src;

    return {
      id,
      platform: 'youtube',
      title,
      channel,
      viewCount,
      uploadDate,
      duration,
      thumbnailUrl,
      isShort,
      isLive,
      element,
    };
  } catch (error) {
    console.error('Tolerance: Failed to parse YouTube video element:', error);
    return null;
  }
}

function parseViewCount(text: string): number {
  // Patterns: "1.2M views", "123K views", "1,234 views", "No views"
  const match = text.match(/([\d,.]+)\s*([KMB]?)\s*views?/i);
  if (!match) return 0;

  // Remove commas and parse number
  const numStr = match[1].replace(/,/g, '');
  const num = parseFloat(numStr);
  const suffix = match[2].toUpperCase();

  switch (suffix) {
    case 'K': return Math.round(num * 1000);
    case 'M': return Math.round(num * 1000000);
    case 'B': return Math.round(num * 1000000000);
    default: return Math.round(num);
  }
}

function parseUploadDate(text: string): string | undefined {
  // Patterns: "2 days ago", "3 months ago", "1 year ago", "Streamed 2 hours ago"
  const match = text.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
  if (match) {
    return match[1];
  }

  // Also check for "Streamed X ago"
  const streamMatch = text.match(/Streamed\s+(\d+\s+\w+\s+ago)/i);
  if (streamMatch) {
    return streamMatch[1];
  }

  return undefined;
}

// Serialize video for messaging (can't send HTMLElement)
export function serializeVideo(video: YouTubeVideo): Omit<YouTubeVideo, 'element'> {
  const { element, ...serialized } = video;
  return serialized;
}
