import { YouTubeVideo } from '../../shared/types';
import { log } from '../../shared/constants';
import { withAiLabel } from '../aiLabel';
import { SPONSORED_PREFIX } from '../../shared/scoring-spec';
import { isCountOrDate, parseUploadDate, parseViewCount, pickDuration } from '../../shared/youtube-parse';

// Scrape video data from YouTube DOM
// YouTube uses custom web components (ytd-*) for its UI

// Cache the channel handle for the current page (channel pages only).
// On /@handle pages we read it from the URL. On /channel/UCxxx pages
// there are no /@handle links in the DOM, so we extract from YouTube's
// embedded ytInitialData script (canonicalBaseUrl field).
let _cachedPageChannel: string | null | undefined;
export function getPageChannelHandle(): string | null {
  if (_cachedPageChannel !== undefined) return _cachedPageChannel;

  // 1. /@handle URL
  const handleMatch = window.location.pathname.match(/^\/@([^/?]+)/);
  if (handleMatch) {
    _cachedPageChannel = handleMatch[1];
    return _cachedPageChannel;
  }

  // 2. /channel/UCxxx page — extract @handle from ytInitialData
  if (window.location.pathname.startsWith('/channel/')) {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (text && text.includes('canonicalBaseUrl')) {
          const match = text.match(/"canonicalBaseUrl"\s*:\s*"\/@([^"]+)"/);
          if (match) {
            _cachedPageChannel = match[1];
            return _cachedPageChannel;
          }
        }
      }
    } catch { /* ignore parse errors */ }

    // 3. Fall back to channel ID from URL
    const channelMatch = window.location.pathname.match(/^\/channel\/([^/?]+)/);
    if (channelMatch) {
      _cachedPageChannel = channelMatch[1];
      return _cachedPageChannel;
    }
  }

  _cachedPageChannel = null;
  return null;
}

// Reset cached channel on navigation (YouTube is a SPA)
export function resetPageChannelCache(): void {
  _cachedPageChannel = undefined;
}

export function scrapeVisibleVideos(): YouTubeVideo[] {
  const videos: YouTubeVideo[] = [];

  // Homepage videos (rich grid) - these contain yt-lockup-view-model inside
  const homeVideos = document.querySelectorAll<HTMLElement>('ytd-rich-item-renderer');

  // Sidebar recommendations (compact) - legacy
  const sidebarVideos = document.querySelectorAll<HTMLElement>('ytd-compact-video-renderer');

  // New sidebar/recommendations using lockup view model (horizontal layout).
  // Don't require the --wrapper modifier class (YouTube churns these);
  // exclude lockups inside ytd-rich-item-renderer (already covered by
  // homeVideos) and nested lockups (playlist items inside a parent lockup).
  const lockupVideos = document.querySelectorAll<HTMLElement>(
    'yt-lockup-view-model:not(ytd-rich-item-renderer yt-lockup-view-model):not(yt-lockup-view-model yt-lockup-view-model)'
  );

  // Search results and other video lists
  const listVideos = document.querySelectorAll<HTMLElement>('ytd-video-renderer');

  log.debug(` Found ${homeVideos.length} home, ${sidebarVideos.length} sidebar, ${lockupVideos.length} lockup, ${listVideos.length} list videos`);

  // One entry per card, not per video ID: the same video can appear in two cards
  // (e.g. grid and a shelf), and each card needs its own badge and blur
  const seenElements = new Set<HTMLElement>();
  for (const element of [...homeVideos, ...sidebarVideos, ...lockupVideos, ...listVideos]) {
    if (seenElements.has(element)) continue;
    seenElements.add(element);
    const video = parseVideoElement(element);
    if (video) {
      videos.push(video);
    }
  }

  log.debug(` Scraped ${videos.length} unique videos`);
  return videos;
}

// Whether YouTube shows this card as an ad: it carries the "Sponsored" badge and the
// ad's own details line and buttons (seen on the home grid, November 2026), or sits in
// one of the older ad containers.
export const AD_CARD_SELECTOR = '.ytBadgeShapeAd, ad-details-line-view-model, ad-button-view-model, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer';
function isAdCard(element: HTMLElement): boolean {
  return element.querySelector(AD_CARD_SELECTOR) !== null;
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
    // Layouts the selectors above don't know (e.g. Shorts shelf lockups): any
    // heading text, then the link's accessible label, then the thumbnail alt
    if (!title) {
      title = element.querySelector('h3, h4')?.textContent?.trim() ||
        link?.getAttribute('aria-label')?.trim() ||
        link?.getAttribute('title')?.trim() ||
        element.querySelector('img[alt]')?.getAttribute('alt')?.trim() || '';
    }

    if (!title) {
      log.debug(' No title found for video', id);
      return null;
    }

    // Get channel name - prefer @handle from href for consistent matching with whitelist
    let channel = '';
    const channelLink = element.querySelector('a[href^="/@"]') as HTMLAnchorElement | null;
    if (channelLink) {
      // Extract @handle from href (e.g., "/@MKBHD" -> "MKBHD")
      const href = channelLink.getAttribute('href');
      const handleMatch = href?.match(/^\/@([^/?]+)/);
      if (handleMatch) {
        channel = handleMatch[1];
      } else {
        // Fallback to text content
        channel = channelLink.textContent?.trim() || '';
      }
    }
    const isAd = isAdCard(element);
    // Sidebar cards beside a video show the channel as plain text with no link: it is
    // the first line of the card's metadata, above the views and date (captured
    // November 2026). This gives the channel's display name, not its @handle, so a
    // trusted-channel entry written as a handle won't match it.
    if (!channel && !isAd) {
      const first = element.querySelector('.ytContentMetadataViewModelMetadataRow .ytContentMetadataViewModelMetadataText');
      const name = first?.textContent?.trim() || '';
      if (name && !isCountOrDate(first?.getAttribute('aria-label') || name)) channel = name;
    }
    // Legacy fallback selectors
    if (!channel) {
      const legacyChannel = element.querySelector('#channel-name, .ytd-channel-name, [id*="channel"]');
      channel = legacyChannel?.textContent?.trim() || '';
    }
    // An ad card has no channel link: its source is the advertiser named on the card
    if (!channel && isAd) {
      channel = element.querySelector('ad-details-line-view-model span')?.textContent?.trim() || '';
    }
    // On channel pages, videos don't have individual channel links.
    // Use the cached page-level channel handle. (Shorts in a shelf name no channel at
    // all, so theirs stays empty.)
    if (!channel && !isAd) {
      channel = getPageChannelHandle() || '';
    }

    // Get metadata (views and date) - try new and legacy selectors
    const metadataElement = element.querySelector(
      '.yt-content-metadata-view-model, ' +       // New lockup model
      '.yt-content-metadata-view-model__metadata-row, ' +  // New model row
      '#metadata-line, ' +                         // Legacy
      '.ytd-video-meta-block, ' +                  // Legacy
      '#metadata'                                  // Fallback
    );
    // Current cards (November 2026) put each piece in its own element, abbreviated on
    // screen ("36K", "2d ago") with the long form in its accessibility label
    // ("36 thousand views", "2 days ago"). The older selectors above no longer match there.
    const metadataParts = [...element.querySelectorAll('.ytContentMetadataViewModelMetadataText')]
      .map(el => el.getAttribute('aria-label') || el.textContent || '');
    const metadataText = metadataParts.length > 0 ? metadataParts.join(' · ') : (metadataElement?.textContent || '');

    const viewCount = parseViewCount(metadataText);
    const uploadDate = parseUploadDate(metadataText);

    // The length is on a badge over the thumbnail. A card can carry other badges too
    // ("LIVE", "Sponsored"), so take the one that reads as a time.
    const badgeTexts = [...element.querySelectorAll(
      '.ytBadgeShapeText, ' +                                  // Current badge (2026)
      '.yt-badge-shape__text, ' +                              // Earlier badge model
      'span.ytd-thumbnail-overlay-time-status-renderer, ' +    // Legacy
      '.badge-shape-wiz__text'                                 // Legacy fallback
    )].map(el => el.textContent?.trim() || '');
    const duration = pickDuration(badgeTexts) ?? badgeTexts[0];

    // Check if it's a live stream
    const isLive = metadataText.toLowerCase().includes('watching') ||
                   badgeTexts.some(t => /^live$/i.test(t)) ||
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
      // Marked when YouTube shows the card as an ad, so it gets the top score in code
      title: withAiLabel(element, isAd ? `${SPONSORED_PREFIX}${title}` : title),
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


// Serialize video for messaging (can't send HTMLElement)
export function serializeVideo(video: YouTubeVideo): Omit<YouTubeVideo, 'element'> {
  const { element, ...serialized } = video;
  return serialized;
}
