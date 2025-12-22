import { RedditPost } from '../shared/types';

// Scrape post data from new Reddit (www.reddit.com) DOM
// New Reddit uses <shreddit-post> custom elements with data as attributes

export function scrapeNewRedditPosts(): RedditPost[] {
  const posts: RedditPost[] = [];

  // Select all non-ad, non-promoted posts
  const postElements = document.querySelectorAll<HTMLElement>(
    'shreddit-post:not([promoted])'
  );

  for (const element of Array.from(postElements)) {
    const post = parseNewRedditPost(element);
    if (post) {
      posts.push(post);
    }
  }

  return posts;
}

function parseNewRedditPost(element: HTMLElement): RedditPost | null {
  try {
    // Get post ID from id attribute (format: t3_postid)
    const fullId = element.getAttribute('id');
    if (!fullId) return null;

    const id = fullId.replace('t3_', '');

    // Title
    const title = element.getAttribute('post-title') || '';
    if (!title) return null;

    // Author
    const author = element.getAttribute('author') || '[deleted]';

    // Subreddit
    const subreddit = element.getAttribute('subreddit-name') || '';

    // Score - may not be visible initially
    const scoreAttr = element.getAttribute('score');
    const score = scoreAttr ? parseInt(scoreAttr, 10) : null;

    // Comments
    const commentsAttr = element.getAttribute('comment-count');
    const numComments = commentsAttr ? parseInt(commentsAttr, 10) : 0;

    // Permalink
    const permalink = element.getAttribute('permalink') || '';

    // Domain
    const domain = element.getAttribute('domain') || '';

    // Media type - map post-type to our mediaType
    const postType = element.getAttribute('post-type') || 'text';
    const mediaType = mapPostType(postType);

    // Timestamp
    const timestamp = element.getAttribute('created-timestamp');
    const createdUtc = timestamp
      ? new Date(timestamp).getTime() / 1000
      : Date.now() / 1000;

    // NSFW check
    const isNsfw = element.hasAttribute('nsfw') ||
                   element.getAttribute('nsfw') === 'true';

    // Flair - try to get from nested element
    let flair: string | undefined;
    const flairEl = element.querySelector('shreddit-post-flair');
    if (flairEl) {
      flair = flairEl.textContent?.trim();
    }

    // Thumbnail URL - look for img in thumbnail slot or media container
    let thumbnailUrl: string | undefined;
    const thumbnailImg = element.querySelector('[slot="thumbnail"] img, shreddit-post-thumbnail img');
    if (thumbnailImg instanceof HTMLImageElement && thumbnailImg.src) {
      thumbnailUrl = thumbnailImg.src;
    }

    // Image URL for image posts
    let imageUrl: string | undefined;
    if (mediaType === 'image') {
      // Try to find the main image
      const mediaImg = element.querySelector('[slot="post-media-container"] img, shreddit-post-image img');
      if (mediaImg instanceof HTMLImageElement && mediaImg.src) {
        imageUrl = mediaImg.src;
      }
    }

    // Video URL for video posts
    let videoUrl: string | undefined;
    if (mediaType === 'video') {
      const video = element.querySelector('video source, shreddit-player source');
      if (video instanceof HTMLSourceElement && video.src) {
        videoUrl = video.src;
      }
    }

    return {
      id,
      platform: 'reddit',
      text: title,
      title,
      subreddit,
      author,
      score,
      numComments,
      upvoteRatio: undefined, // Not available in new Reddit DOM
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
    console.error('Tolerance: Failed to parse new Reddit post:', error);
    return null;
  }
}

function mapPostType(postType: string): RedditPost['mediaType'] {
  switch (postType.toLowerCase()) {
    case 'image':
      return 'image';
    case 'video':
    case 'gif':
      return 'video';
    case 'gallery':
      return 'gallery';
    case 'link':
      return 'link';
    case 'text':
    default:
      return 'text';
  }
}

// Serialize post for messaging (can't send HTMLElement)
export function serializeNewRedditPost(post: RedditPost): Omit<RedditPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
