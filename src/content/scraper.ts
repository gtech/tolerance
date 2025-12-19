import { RedditPost } from '../shared/types';

// Scrape post data from old.reddit.com DOM
// Old Reddit uses consistent div.thing structure

export function scrapeVisiblePosts(): RedditPost[] {
  const posts: RedditPost[] = [];

  // Old Reddit posts are in div.thing with data-fullname attribute
  const postElements = document.querySelectorAll<HTMLElement>(
    '#siteTable > .thing.link'
  );

  for (const element of postElements) {
    const post = parsePostElement(element);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}

function parsePostElement(element: HTMLElement): RedditPost | null {
  try {
    // Get post ID from data-fullname (format: t3_postid)
    const fullname = element.getAttribute('data-fullname');
    if (!fullname) return null;

    const id = fullname.replace('t3_', '');

    // Title
    const titleElement = element.querySelector<HTMLAnchorElement>('a.title');
    const title = titleElement?.textContent?.trim() || '';
    if (!title) return null;

    // Subreddit
    const subredditElement = element.querySelector<HTMLAnchorElement>('a.subreddit');
    const subredditText = subredditElement?.textContent || '';
    const subreddit = subredditText.replace(/^r\//, '');

    // Author
    const authorElement = element.querySelector<HTMLAnchorElement>('a.author');
    const author = authorElement?.textContent || '[deleted]';

    // Score - handle unknown scores (shown as "•" on Reddit)
    const scoreElement = element.querySelector<HTMLElement>('.score.unvoted');
    const scoreText = scoreElement?.getAttribute('title') || scoreElement?.textContent || '';
    // Check if score is unknown (bullet point, empty, or non-numeric)
    const isUnknownScore = !scoreText || scoreText === '•' || scoreText === '—' || !/\d/.test(scoreText);
    const score = isUnknownScore ? null : (parseInt(scoreText.replace(/[^0-9-]/g, ''), 10) || 0);

    // Comments
    const commentsElement = element.querySelector<HTMLAnchorElement>('a.comments');
    const commentsText = commentsElement?.textContent || '0';
    const numComments = parseInt(commentsText.replace(/[^0-9]/g, ''), 10) || 0;

    // Permalink - use comments link which always points to Reddit post, not external content
    const commentsHref = commentsElement?.getAttribute('href') || '';
    // Extract just the path (remove domain if present)
    const permalink = commentsHref.startsWith('http')
      ? new URL(commentsHref).pathname
      : commentsHref;

    // Domain
    const domainElement = element.querySelector<HTMLElement>('.domain');
    const domain = domainElement?.textContent?.replace(/[()]/g, '').trim() || '';

    // Media type detection
    const mediaType = detectMediaType(element, domain);

    // Flair
    const flairElement = element.querySelector<HTMLElement>('.linkflairlabel');
    const flair = flairElement?.textContent?.trim();

    // NSFW check
    const isNsfw = element.classList.contains('over18');

    // Timestamp (data-timestamp is in milliseconds)
    const timestamp = element.getAttribute('data-timestamp');
    const createdUtc = timestamp ? parseInt(timestamp, 10) / 1000 : Date.now() / 1000;

    // Thumbnail - try multiple methods
    let thumbnailUrl: string | undefined;

    // Method 1: Direct img inside thumbnail anchor
    const thumbnailImg = element.querySelector<HTMLImageElement>('a.thumbnail img');
    if (thumbnailImg?.src && !thumbnailImg.src.includes('data:')) {
      thumbnailUrl = thumbnailImg.src;
    }

    // Method 2: Background image on thumbnail anchor
    if (!thumbnailUrl) {
      const thumbnailAnchor = element.querySelector<HTMLElement>('a.thumbnail');
      if (thumbnailAnchor) {
        const bgImage = thumbnailAnchor.style.backgroundImage;
        const bgMatch = bgImage?.match(/url\(["']?([^"')]+)["']?\)/);
        if (bgMatch?.[1]) {
          thumbnailUrl = bgMatch[1];
        }
      }
    }

    // Method 3: data-url attribute
    if (!thumbnailUrl) {
      const thumbWithData = element.querySelector<HTMLElement>('[data-url]');
      const dataUrl = thumbWithData?.getAttribute('data-url');
      if (dataUrl) {
        thumbnailUrl = dataUrl;
      }
    }

    // Get actual content URL from title link (for image/video posts)
    const titleHref = titleElement?.getAttribute('href') || '';
    const domainLower = domain.toLowerCase();

    // For direct image links, capture the actual image URL
    let imageUrl: string | undefined;
    if (
      domainLower.includes('i.redd.it') ||
      domainLower.includes('imgur.com/') ||
      titleHref.match(/\.(jpg|jpeg|png|gif|webp)$/i)
    ) {
      imageUrl = titleHref.startsWith('http') ? titleHref : `https://reddit.com${titleHref}`;
    }

    // For video domains, capture video URL
    let videoUrl: string | undefined;
    if (
      domainLower.includes('v.redd.it') ||
      domainLower.includes('gfycat') ||
      domainLower.includes('redgifs')
    ) {
      videoUrl = titleHref.startsWith('http') ? titleHref : `https://reddit.com${titleHref}`;
    }

    // Upvote ratio (not directly available in DOM, approximate from score distribution)
    // Old Reddit doesn't expose this directly, so we leave it undefined
    const upvoteRatio = undefined;

    return {
      id,
      platform: 'reddit',
      text: title, // For Reddit, text is the title
      title,
      subreddit,
      author,
      score,
      numComments,
      upvoteRatio,
      flair,
      isNsfw,
      mediaType,
      permalink,
      domain,
      createdUtc,
      thumbnailUrl,
      imageUrl,
      videoUrl,
      element,
    };
  } catch (error) {
    console.error('Failed to parse post element:', error);
    return null;
  }
}

function detectMediaType(
  element: HTMLElement,
  domain: string
): RedditPost['mediaType'] {
  // Check for self post
  if (element.classList.contains('self')) {
    return 'text';
  }

  // Check title link for gallery (domain element won't include /gallery path)
  const titleLink = element.querySelector<HTMLAnchorElement>('a.title');
  const titleHref = titleLink?.getAttribute('href') || '';
  if (titleHref.includes('/gallery/')) {
    return 'gallery';
  }

  // Check thumbnail type
  const thumbnail = element.querySelector<HTMLElement>('a.thumbnail');
  if (thumbnail) {
    if (thumbnail.classList.contains('self')) return 'text';
    if (thumbnail.classList.contains('image')) return 'image';
    if (thumbnail.classList.contains('video')) return 'video';
  }

  // Check domain for media types
  const domainLower = domain.toLowerCase();

  if (
    domainLower.includes('imgur') ||
    domainLower.includes('i.redd.it') ||
    domainLower.includes('gfycat') ||
    domainLower.endsWith('.jpg') ||
    domainLower.endsWith('.png') ||
    domainLower.endsWith('.gif')
  ) {
    return 'image';
  }

  if (
    domainLower.includes('youtube') ||
    domainLower.includes('youtu.be') ||
    domainLower.includes('v.redd.it') ||
    domainLower.includes('streamable') ||
    domainLower.includes('twitch')
  ) {
    return 'video';
  }

  if (domainLower.includes('reddit.com/gallery')) {
    return 'gallery';
  }

  return 'link';
}

// Serialize post for messaging (can't send HTMLElement)
export function serializePost(post: RedditPost): Omit<RedditPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
