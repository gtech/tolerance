import { LinkedInPost } from '../../shared/types';
import { log } from '../../shared/constants';
import { SPONSORED_PREFIX } from '../../shared/scoring-spec';
import { withAiLabel } from '../aiLabel';
import { LI_FEED, LI_POST } from './gate';

// Reads posts from LinkedIn's home feed.
//
// The feed (2026-11-19) is a virtualized list, [data-testid="mainFeed"]. Each post is
// a [role="listitem"] whose componentkey is "update-card-focus<token>FeedType_...",
// and the same token is the componentkey of its first child. Class names are generated
// and useless. Post text sits in [data-testid="expandable-text-box"]: the first is the
// post's own text, a second is the post it reshares.
//
// The author and the "Promoted" label are read from English text, so on a LinkedIn
// set to another language the author falls back to the first profile link and ads
// are not recognised by their label.

export function findPostElements(root: ParentNode = document): HTMLElement[] {
  const feed = root.querySelector(LI_FEED);
  if (!feed) return [];
  return [...feed.querySelectorAll<HTMLElement>(LI_POST)]
    .filter(el => !el.parentElement?.closest(LI_POST));
}

export function scrapeVisiblePosts(root: ParentNode = document): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  for (const element of findPostElements(root)) {
    const post = parsePostElement(element);
    if (post) posts.push(post);
  }
  return posts;
}

export function parsePostElement(element: HTMLElement): LinkedInPost | null {
  try {
    const author = extractAuthor(element);
    const text = extractText(element);
    const { mediaType, imageUrl, thumbnailUrl } = extractMedia(element);

    // Nothing to score: still loading, or a card that isn't a post
    if (!text && !imageUrl && !thumbnailUrl) return null;

    const isSponsored = detectSponsored(element);
    const caption = withAiLabel(element, isSponsored ? `${SPONSORED_PREFIX}${text}` : text);
    const { likeCount, commentCount } = extractEngagement(element);
    const name = author || 'Unknown';

    return {
      id: extractPostId(element, name, text),
      platform: 'linkedin',
      author: name,
      authorDisplayName: name,
      text: caption,
      caption,
      score: likeCount,
      likeCount,
      numComments: commentCount,
      commentCount,
      mediaType,
      isSponsored,
      permalink: 'https://www.linkedin.com/feed/',
      createdUtc: Date.now() / 1000,
      imageUrl,
      thumbnailUrl,
      element,
    };
  } catch (error) {
    log.error('LinkedIn: Failed to parse post element:', error);
    return null;
  }
}

const TOKEN_FROM_KEY = /^update-card-(?:focus)?(.+?)FeedType_/;

function extractPostId(element: HTMLElement, author: string, text: string): string {
  const key = element.getAttribute('componentkey') ?? '';
  const inner = element.querySelector(':scope > [componentkey]')?.getAttribute('componentkey');
  if (inner && key.includes(inner)) return `li_${inner}`;
  const fromKey = key.match(TOKEN_FROM_KEY)?.[1];
  if (fromKey) return `li_${fromKey}`;
  // Short prefix: the text grows when "…more" is expanded
  return `li_hash_${simpleHash(`${author}:${text.slice(0, 80)}`)}`;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

const PROFILE_LINK = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], a[href*="/showcase/"]';
const MENU_LABEL = /^Open control menu for post by (.+)$/;

export function extractAuthor(element: HTMLElement): string {
  // The post's menu button names the author, whoever's activity put it in the feed
  for (const button of element.querySelectorAll('button[aria-label]')) {
    const name = button.getAttribute('aria-label')?.trim().match(MENU_LABEL)?.[1]?.trim();
    if (name) return name;
  }
  // Otherwise the first profile link that carries a name
  for (const link of element.querySelectorAll<HTMLAnchorElement>(PROFILE_LINK)) {
    const labelled = link.getAttribute('aria-label')?.trim()
      || link.querySelector('[aria-label]')?.getAttribute('aria-label')?.trim();
    const name = labelled || link.querySelector('p')?.textContent?.trim();
    if (name && name.length >= 2 && name.length < 100) return name;
  }
  return '';
}

function extractText(element: HTMLElement): string {
  const parts: string[] = [];
  for (const box of element.querySelectorAll<HTMLElement>('[data-testid="expandable-text-box"]')) {
    // innerText keeps the line breaks; textContent is the fallback where layout isn't available
    const text = (box.innerText || box.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.join(' — ');
}

function detectSponsored(element: HTMLElement): boolean {
  for (const p of element.querySelectorAll('p')) {
    const text = p.textContent?.trim() ?? '';
    if (text.length < 60 && /^Promoted\b/.test(text)) return true;
  }
  return !!element.querySelector('img[alt="View Sponsored Content"]');
}

function extractEngagement(element: HTMLElement): { likeCount: number | null; commentCount: number } {
  let likeCount: number | null = null;
  let commentCount = 0;
  for (const el of element.querySelectorAll<HTMLElement>('a, button, span, p')) {
    const text = el.textContent?.trim() ?? '';
    if (text.length > 30) continue;
    const reactions = text.match(/^([\d,.]+[KM]?)\s+reactions?$/i);
    if (reactions && likeCount === null) likeCount = parseCount(reactions[1]);
    const comments = text.match(/^([\d,.]+[KM]?)\s+comments?$/i);
    if (comments && commentCount === 0) commentCount = parseCount(comments[1]) ?? 0;
  }
  return { likeCount, commentCount };
}

function parseCount(text: string): number | null {
  const match = text.toUpperCase().replace(/,/g, '').match(/^([\d.]+)([KM])?$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num)) return null;
  return Math.round(num * (match[2] === 'K' ? 1000 : match[2] === 'M' ? 1_000_000 : 1));
}

// Profile photos and organisation logos, by the name LinkedIn's image server gives them
const NOT_CONTENT = /\/(profile-displayphoto|profile-framedphoto|company-logo|school-logo|group-logo|profile-displaybackgroundimage)/;

function extractMedia(element: HTMLElement): {
  mediaType: LinkedInPost['mediaType'];
  imageUrl?: string;
  thumbnailUrl?: string;
} {
  const hasVideo = !!element.querySelector('video');
  let imageUrl: string | undefined;
  for (const img of element.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.currentSrc || img.src || '';
    if (!src.startsWith('http') || NOT_CONTENT.test(src)) continue;
    if (img.closest(PROFILE_LINK)) continue;
    // Icons and reaction faces
    if ((img.width && img.width < 100) || (img.height && img.height < 100)) continue;
    imageUrl = src;
    break;
  }
  if (hasVideo) return { mediaType: 'video', thumbnailUrl: imageUrl };
  if (imageUrl) return { mediaType: 'image', imageUrl, thumbnailUrl: imageUrl };
  return { mediaType: 'text' };
}

// Serialize post for messaging (can't send HTMLElement)
export function serializePost(post: LinkedInPost): Omit<LinkedInPost, 'element'> {
  const { element, ...serialized } = post;
  return serialized;
}
