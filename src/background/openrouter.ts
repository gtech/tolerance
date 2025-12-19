import { log } from '../shared/constants';
// OpenRouter API client for engagement scoring
// Handles both text and image analysis

import { getSettings, setSettings } from './storage';

export interface ScoreResponse {
  score: number; // 1-10
  reason: string;
  cost: number; // USD
  fullResponse?: unknown; // Full API response for debugging
}

export interface ApiUsage {
  totalCalls: number;
  totalCost: number;
  lastReset: number;
}

// Model pricing (per 1M tokens, approximate)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-sonnet-4.5': { input: 3, output: 15 },
  'openai/gpt-oss-120b': { input: 0.039, output: 0.19 },
  'z-ai/glm-4.6v': { input: 0.3, output: 0.9 },
  'meta-llama/llama-4-scout': { input: 0.11, output: 0.34},
};

const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-120b';
const DEFAULT_IMAGE_MODEL = 'meta-llama/llama-4-scout';
// Video model was too slow (10+ seconds), use image model with thumbnail instead
const DEFAULT_VIDEO_MODEL = 'meta-llama/llama-4-scout';

const DEFAULT_FULL_VIDEO_MODEL = 'google/gemini-2.5-flash-lite';
// const DEFAULT_FULL_VIDEO_MODEL = 'z-ai/glm-4.6v';

// Post data for batch scoring
export interface PostForScoring {
  id: string;
  title: string;
  subreddit: string; // For Reddit: subreddit name, for Twitter: @username
  score: number | null;
  numComments: number;
  platform?: 'reddit' | 'twitter';
}

// Batch score result
export interface BatchScoreResult {
  postId: string;
  score: number;
  reason: string;
}

// Score multiple text posts in a single API call
export async function scoreTextPostsBatch(
  posts: PostForScoring[],
  apiKey: string
): Promise<Map<string, ScoreResponse>> {
  const batchStart = performance.now();
  log.debug(` scoreTextPostsBatch START for ${posts.length} posts at t=${batchStart.toFixed(0)}`);

  if (posts.length === 0) {
    return new Map();
  }

  // Build batch prompt - platform-agnostic
  const postsDescription = posts.map((p, i) => {
    const isTwitter = p.platform === 'twitter' || p.subreddit.startsWith('@');
    const scoreLabel = isTwitter ? 'Likes' : 'Upvotes';
    const scoreText = p.score !== null ? `${scoreLabel}: ${p.score}` : `${scoreLabel}: (not yet visible)`;
    const sourceLabel = isTwitter ? `Author: ${p.subreddit}` : `Subreddit: r/${p.subreddit}`;
    const contentLabel = isTwitter ? 'Tweet' : 'Title';
    return `[${i + 1}] ID: ${p.id}
${contentLabel}: "${p.title}"
${sourceLabel}
${scoreText}, Comments: ${p.numComments}`;
  }).join('\n\n');

  const prompt = `Analyze these social media posts for engagement manipulation tactics.

${postsDescription}

For EACH post, rate 1-10 how much it uses psychological manipulation:
- 1-3: Informative, neutral, or genuinely interesting content
- 4-6: Some engagement optimization (catchy title, emotional hook)
- 7-10: Heavy manipulation (outrage bait, curiosity gaps, tribal triggers)

Respond with ONLY a JSON array, one object per post in order:
[{"id": "<post_id>", "score": <1-10>, "reason": "<15 words max>"}, ...]`;

  try {
    const response = await callOpenRouter(apiKey, prompt);
    if (!response) {
      return new Map();
    }

    // Parse batch response - expect array in fullResponse
    const content = (response.fullResponse as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content || '';
    log.debug('Tolerance: Batch response content:', content.slice(0, 500));

    const results = new Map<string, ScoreResponse>();

    // Try to parse the response - handle both raw array and object-wrapped formats
    let parsed: BatchScoreResult[] | null = null;

    try {
      // First try parsing the whole content as JSON
      const fullParsed = JSON.parse(content);
      if (Array.isArray(fullParsed)) {
        parsed = fullParsed;
      } else if (fullParsed.data && Array.isArray(fullParsed.data)) {
        // Handle {"type":"object","data":[...]} format
        parsed = fullParsed.data;
      } else if (fullParsed.results && Array.isArray(fullParsed.results)) {
        // Handle {"results":[...]} format
        parsed = fullParsed.results;
      }
    } catch {
      // If full parse fails, try to extract array with regex
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          parsed = JSON.parse(arrayMatch[0]);
        } catch (parseErr) {
          console.error('Tolerance: Failed to parse extracted array:', parseErr, 'Content:', content.slice(0, 300));
        }
      }
    }

    if (parsed && Array.isArray(parsed)) {
      const costPerPost = response.cost / posts.length;
      log.debug(` Parsed ${parsed.length} results from batch response, first item:`, JSON.stringify(parsed[0]));

      // Try to match by ID first, fall back to order
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        // Try different ID field names the LLM might use
        const itemId = item.id || (item as unknown as { postId?: string }).postId ||
                      (item as unknown as { post_id?: string }).post_id;
        const reason = item.reason || '';

        if (itemId && posts.some(p => p.id === itemId)) {
          results.set(itemId, {
            score: Math.min(10, Math.max(1, item.score)),
            reason,
            cost: costPerPost,
          });
        } else if (i < posts.length) {
          // Fall back to matching by order
          results.set(posts[i].id, {
            score: Math.min(10, Math.max(1, item.score)),
            reason,
            cost: costPerPost,
          });
        }
      }
    } else {
      console.error('Tolerance: No valid JSON array found in batch response:', content.slice(0, 300));
    }

    const batchEnd = performance.now();
    log.debug(` scoreTextPostsBatch completed ${results.size}/${posts.length} scores in ${(batchEnd - batchStart).toFixed(0)}ms`);

    return results;
  } catch (error) {
    console.error('Tolerance: Batch scoring failed:', error);
    return new Map();
  }
}

// Score text posts AND galleries (with pre-fetched descriptions) in a single batch
export async function scoreTextPostsBatchWithGalleries(
  posts: (PostForScoring & { galleryDescription?: string })[],
  apiKey: string
): Promise<Map<string, ScoreResponse>> {
  const batchStart = performance.now();
  log.debug(` scoreTextPostsBatchWithGalleries START for ${posts.length} posts`);

  if (posts.length === 0) {
    return new Map();
  }

  // Build batch prompt including gallery descriptions
  const postsDescription = posts.map((p, i) => {
    const isTwitter = p.platform === 'twitter' || p.subreddit.startsWith('@');
    const scoreLabel = isTwitter ? 'Likes' : 'Upvotes';
    const scoreText = p.score !== null ? `${scoreLabel}: ${p.score}` : `${scoreLabel}: (not yet visible)`;
    const sourceLabel = isTwitter ? `Author: ${p.subreddit}` : `Subreddit: r/${p.subreddit}`;
    const contentLabel = isTwitter ? 'Tweet' : 'Title';
    const galleryInfo = p.galleryDescription
      ? `\nImage descriptions: ${p.galleryDescription}`
      : '';
    return `[${i + 1}] ID: ${p.id}
${contentLabel}: "${p.title}"
${sourceLabel}
${scoreText}, Comments: ${p.numComments}${galleryInfo}`;
  }).join('\n\n');

  const prompt = `Analyze these social media posts for engagement manipulation tactics.

${postsDescription}

For EACH post, rate 1-10 how much it uses psychological manipulation:
- 1-3: Informative, neutral, or genuinely interesting content
- 4-6: Some engagement optimization (catchy title, emotional hook)
- 7-10: Heavy manipulation (outrage bait, curiosity gaps, tribal triggers)

For posts with image descriptions, consider whether the images add to or detract from the manipulation assessment.

Respond with ONLY a JSON array, one object per post in order:
[{"id": "<post_id>", "score": <1-10>, "reason": "<15 words max>"}, ...]`;

  try {
    const response = await callOpenRouter(apiKey, prompt);
    if (!response) {
      return new Map();
    }

    const content = (response.fullResponse as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content || '';
    const results = new Map<string, ScoreResponse>();

    let parsed: BatchScoreResult[] | null = null;

    try {
      const fullParsed = JSON.parse(content);
      if (Array.isArray(fullParsed)) {
        parsed = fullParsed;
      } else if (fullParsed.data && Array.isArray(fullParsed.data)) {
        parsed = fullParsed.data;
      } else if (fullParsed.results && Array.isArray(fullParsed.results)) {
        parsed = fullParsed.results;
      }
    } catch {
      const arrayMatch = content.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          parsed = JSON.parse(arrayMatch[0]);
        } catch (parseErr) {
          console.error('Tolerance: Failed to parse extracted array:', parseErr);
        }
      }
    }

    if (parsed && Array.isArray(parsed)) {
      const costPerPost = response.cost / posts.length;
      log.debug(` Batch parsed ${parsed.length} items, first item:`, JSON.stringify(parsed[0]));

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        const itemId = item.id || (item as unknown as { postId?: string }).postId ||
                      (item as unknown as { post_id?: string }).post_id;
        const reason = item.reason || '';

        if (itemId && posts.some(p => p.id === itemId)) {
          results.set(itemId, {
            score: Math.min(10, Math.max(1, item.score)),
            reason,
            cost: costPerPost,
          });
        } else if (i < posts.length) {
          results.set(posts[i].id, {
            score: Math.min(10, Math.max(1, item.score)),
            reason,
            cost: costPerPost,
          });
        }
      }
    }

    const batchEnd = performance.now();
    log.debug(` scoreTextPostsBatchWithGalleries completed ${results.size}/${posts.length} in ${(batchEnd - batchStart).toFixed(0)}ms`);

    return results;
  } catch (error) {
    console.error('Tolerance: Batch scoring with galleries failed:', error);
    return new Map();
  }
}

// Score a text post (single - kept for backwards compatibility)
// subreddit can be "subredditName" for Reddit or "@username" for Twitter
export async function scoreTextPost(
  title: string,
  subreddit: string,
  score: number | null,
  numComments: number,
  apiKey?: string
): Promise<ScoreResponse | null> {
  const key = apiKey || (await getSettings()).openRouterApiKey;
  if (!key) {
    return null;
  }

  const isTwitter = subreddit.startsWith('@');
  const scoreLabel = isTwitter ? 'Likes' : 'Upvotes';
  const scoreText = score !== null ? `${scoreLabel}: ${score}` : `${scoreLabel}: (not yet visible)`;
  const sourceLabel = isTwitter ? `Author: ${subreddit}` : `Subreddit: r/${subreddit}`;
  const contentLabel = isTwitter ? 'Tweet' : 'Title';

  const prompt = `Analyze this social media post for engagement manipulation tactics.

${contentLabel}: "${title}"
${sourceLabel}
${scoreText}, Comments: ${numComments}

Rate from 1-10 how much this post uses psychological manipulation to drive engagement:
- 1-3: Informative, neutral, or genuinely interesting content
- 4-6: Some engagement optimization (catchy title, emotional hook)
- 7-10: Heavy manipulation (outrage bait, curiosity gaps, tribal triggers, misleading framing)

Consider: clickbait patterns, emotional manipulation, us-vs-them framing, manufactured outrage, curiosity gaps ("You won't believe..."), and sensationalism.

Respond with ONLY valid JSON: {"score": <1-10>, "reason": "<15 words max>"}`;

  return callOpenRouter(key, prompt);
}

// Fetch all images from a Reddit gallery
export async function fetchGalleryImages(postId: string): Promise<string[]> {
  const galleryStart = performance.now();
  log.debug(` fetchGalleryImages START at t=${galleryStart.toFixed(0)} for post=${postId}`);
  try {
    const response = await fetch(`https://www.reddit.com/comments/${postId}.json`, {
      headers: { 'User-Agent': 'Tolerance/1.0' }
    });

    if (!response.ok) {
      console.error('Failed to fetch gallery data:', response.status);
      return [];
    }

    const data = await response.json();
    const post = data?.[0]?.data?.children?.[0]?.data;

    if (!post?.gallery_data?.items || !post?.media_metadata) {
      return [];
    }

    const images: string[] = [];
    for (const item of post.gallery_data.items) {
      const mediaId = item.media_id;
      const media = post.media_metadata[mediaId];
      if (media?.s?.u) {
        // Decode HTML entities in URL
        const url = media.s.u.replace(/&amp;/g, '&');
        images.push(url);
      }
    }

    const galleryEnd = performance.now();
    log.debug(` Fetched ${images.length} gallery images for post ${postId} in ${(galleryEnd - galleryStart).toFixed(0)}ms`);
    return images;
  } catch (error) {
    console.error('Failed to fetch gallery images:', error);
    return [];
  }
}

// Get image descriptions from vision model
export async function describeImages(
  apiKey: string,
  imageUrls: string[]
): Promise<string> {
  log.debug(` describeImages called with ${imageUrls.length} URLs:`, imageUrls);

  const prompt = `Briefly describe each image in 1-2 sentences. Focus on: subject matter, emotional tone, any text visible, and whether it seems designed to provoke reactions.`;

  // Send URLs directly (vision models can fetch them)
  const imageContents: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: prompt }
  ];

  for (const url of imageUrls.slice(0, 4)) { // Limit to 4 images
    // Transform preview.redd.it to i.redd.it for better accessibility
    // But NOT external-preview.redd.it - those work directly
    let imageUrl = url;
    if (url.includes('preview.redd.it') && !url.includes('external-preview.redd.it')) {
      const match = url.match(/preview\.redd\.it\/([^?]+)/);
      if (match) {
        imageUrl = `https://i.redd.it/${match[1]}`;
      }
    }
    log.debug(` Adding image URL: ${imageUrl}`);
    imageContents.push({ type: 'image_url', image_url: { url: imageUrl } });
  }

  if (imageContents.length === 1) {
    return 'No images could be loaded.';
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'chrome-extension://tolerance',
        'X-Title': 'Tolerance',
      },
      body: JSON.stringify({
        model: DEFAULT_IMAGE_MODEL,
        messages: [{ role: 'user', content: imageContents }],
        max_tokens: 500,
        temperature: 0.3,
        provider: {
          order: ['Groq', 'Cerebras'],
          allow_fallbacks: true,
        },
      }),
    });

    if (!response.ok) {
      console.error('Vision API error:', response.status);
      return 'Failed to describe images.';
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'No description available.';
  } catch (error) {
    console.error('Image description failed:', error);
    return 'Failed to describe images.';
  }
}

// Score an image/visual post (two-step for galleries)
// source can be "subredditName" for Reddit or "@username" for Twitter
export async function scoreImagePost(
  title: string,
  source: string,
  imageUrl: string,
  score: number | null,
  numComments: number,
  postId?: string,
  bodyText?: string,
  apiKey?: string
): Promise<ScoreResponse | null> {
  const key = apiKey || (await getSettings()).openRouterApiKey;
  if (!key) {
    return null;
  }

  const isTwitter = source.startsWith('@');
  const scoreLabel = isTwitter ? 'Likes' : 'Upvotes';
  const scoreText = score !== null ? `${scoreLabel}: ${score}` : `${scoreLabel}: (not yet visible)`;
  const sourceLabel = isTwitter ? `Author: ${source}` : `Subreddit: r/${source}`;
  const contentLabel = isTwitter ? 'Tweet' : 'Title';
  const platformName = isTwitter ? 'Twitter' : 'Reddit';

  // Log what we're scoring
  log.debug(` scoreImagePost - platform=${platformName}, text="${title.slice(0, 50)}...", imageUrl=${imageUrl?.slice(0, 60)}...`);

  // Check if this is a gallery - try to fetch all images (Reddit only)
  let imageDescriptions = '';
  let galleryImages: string[] = [];

  if (postId && !isTwitter) {
    galleryImages = await fetchGalleryImages(postId);
  }

  if (galleryImages.length > 1) {
    // Multi-image: get descriptions then score with text model
    log.debug(` Gallery detected with ${galleryImages.length} images, using two-step scoring`);

    imageDescriptions = await describeImages(key, galleryImages);
    log.debug(` Image descriptions: ${imageDescriptions.slice(0, 200)}...`);

    // Now score with text model using descriptions
    const prompt = `Analyze this ${platformName} post for engagement manipulation tactics.

${contentLabel}: "${title}"
${sourceLabel}
${scoreText}, Comments: ${numComments}
${bodyText ? `\nPost text: "${bodyText}"` : ''}

Image descriptions (${galleryImages.length} images):
${imageDescriptions}

Rate from 1-10 how much this post uses psychological manipulation to drive engagement:
- 1-3: Informative, neutral, genuinely interesting, or wholesome
- 4-6: Some engagement optimization (reaction-bait image, emotional hook)
- 7-10: Heavy manipulation (outrage imagery, misleading visual, rage-bait, engagement farming)

Consider: Do the images match the ${contentLabel.toLowerCase()}? Are they designed to provoke strong emotional reactions? Does it use misleading framing?

Respond with ONLY valid JSON: {"score": <1-10>, "reason": "<15 words max>"}`;

    return callOpenRouter(key, prompt, DEFAULT_TEXT_MODEL);
  }

  // Single image: use vision model directly
  const model = DEFAULT_IMAGE_MODEL;

  // For image-only posts (common on Twitter), adjust the prompt
  const hasText = title && title.trim().length > 0;
  const contentDescription = hasText
    ? `${contentLabel}: "${title}"`
    : `(No text - image only post)`;

  const prompt = `Analyze this ${platformName} post (${hasText ? contentLabel.toLowerCase() + ' + image' : 'image only'}) for engagement manipulation tactics.

${contentDescription}
${sourceLabel}
${scoreText}, Comments: ${numComments}
${bodyText ? `\nPost text: "${bodyText}"` : ''}

Rate from 1-10 how much this post uses psychological manipulation to drive engagement:
- 1-3: Informative, neutral, genuinely interesting, or wholesome
- 4-6: Some engagement optimization (reaction-bait image, emotional hook)
- 7-10: Heavy manipulation (outrage imagery, misleading visual, rage-bait, engagement farming)

Consider: ${hasText ? `Does the image match the ${contentLabel.toLowerCase()}? ` : ''}Is it designed to provoke strong emotional reactions? Does it use misleading framing?

Respond with ONLY valid JSON: {"score": <1-10>, "reason": "<15 words max>"}`;

  return callOpenRouter(key, prompt, model, imageUrl);
}

// Score a video/gif post using thumbnail
// source can be "subredditName" for Reddit or "@username" for Twitter
export async function scoreVideoPost(
  title: string,
  source: string,
  thumbnailUrl: string,
  score: number | null,
  numComments: number,
  apiKey?: string
): Promise<ScoreResponse | null> {
  const key = apiKey || (await getSettings()).openRouterApiKey;
  if (!key) {
    return null;
  }

  const isTwitter = source.startsWith('@');
  const scoreLabel = isTwitter ? 'Likes' : 'Upvotes';
  const scoreText = score !== null ? `${scoreLabel}: ${score}` : `${scoreLabel}: (not yet visible)`;
  const sourceLabel = isTwitter ? `Author: ${source}` : `Subreddit: r/${source}`;
  const contentLabel = isTwitter ? 'Tweet' : 'Title';
  const platformName = isTwitter ? 'Twitter' : 'Reddit';

  // Use fast image model with thumbnail (video model was too slow at 10+ seconds)
  const model = DEFAULT_VIDEO_MODEL;

  // Use thumbnail URL directly - external-preview URLs work as-is
  // Only transform regular preview.redd.it (not external-preview.redd.it)
  let imageUrl = thumbnailUrl;
  if (thumbnailUrl && thumbnailUrl.includes('preview.redd.it') && !thumbnailUrl.includes('external-preview.redd.it')) {
    const match = thumbnailUrl.match(/preview\.redd\.it\/([^?]+)/);
    if (match) {
      imageUrl = `https://i.redd.it/${match[1]}`;
    }
  }
  // external-preview.redd.it URLs work directly, no transformation needed

  log.debug(` scoreVideoPost - platform=${platformName}, text="${title.slice(0, 50)}...", thumbnail=${imageUrl?.slice(0, 60)}...`);

  // For video-only posts (common on Twitter), adjust the prompt
  const hasText = title && title.trim().length > 0;
  const contentDescription = hasText
    ? `${contentLabel}: "${title}"`
    : `(No text - video/gif only post)`;

  const prompt = `Analyze this ${platformName} post (${hasText ? contentLabel.toLowerCase() + ' + video/gif thumbnail' : 'video/gif only'}) for engagement manipulation tactics.

${contentDescription}
${sourceLabel}
${scoreText}, Comments: ${numComments}

Rate from 1-10 how much this post uses psychological manipulation to drive engagement:
- 1-3: Informative, neutral, genuinely interesting, or wholesome
- 4-6: Some engagement optimization (reaction-bait video, emotional hook)
- 7-10: Heavy manipulation (outrage footage, misleading edit, rage-bait, engagement farming)

Consider: Does the thumbnail suggest clickbait? Is it designed to provoke strong emotional reactions?

Respond with ONLY valid JSON: {"score": <1-10>, "reason": "<15 words max>"}`;

  return callOpenRouter(key, prompt, model, imageUrl || undefined);
}

// Convert image URL to base64 data URL via content script (bypasses CORS)
async function imageUrlToBase64(url: string): Promise<string | null> {
  const imgStart = performance.now();
  log.debug(` imageUrlToBase64 START at t=${imgStart.toFixed(0)}`);
  try {
    // Find a Reddit tab to use for fetching
    const tabs = await chrome.tabs.query({ url: '*://*.reddit.com/*' });
    const redditTab = tabs.find(t => t.id !== undefined);

    if (!redditTab?.id) {
      console.error('No Reddit tab found for image fetching');
      // Fallback: try direct fetch (might work for some URLs)
      return await directFetchBase64(url);
    }

    // Ask content script to fetch the image
    const response = await chrome.tabs.sendMessage(redditTab.id, {
      type: 'FETCH_IMAGE_BASE64',
      url,
    });

    if (response?.success && response?.base64) {
      const imgEnd = performance.now();
      log.debug(` Image fetched via content script (${response.base64.length} chars) in ${(imgEnd - imgStart).toFixed(0)}ms`);
      return response.base64;
    } else {
      console.error('Content script image fetch failed:', response?.error);
      return null;
    }
  } catch (error) {
    console.error('Image to base64 conversion failed:', error, url);
    return null;
  }
}

// Direct fetch fallback (for non-Reddit URLs or when no tab available)
async function directFetchBase64(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Direct fetch failed: ${response.status} - ${url}`);
      return null;
    }

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Direct fetch failed:', error);
    return null;
  }
}

async function callOpenRouter(
  apiKey: string,
  prompt: string,
  model: string = DEFAULT_TEXT_MODEL,
  imageUrl?: string
): Promise<ScoreResponse | null> {
  const callStart = performance.now();
  log.debug(` callOpenRouter START at t=${callStart.toFixed(0)}, model=${model}`);
  try {
    const messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }> = [];

    if (imageUrl) {
      // Transform image URLs for better API accessibility
      let effectiveImageUrl = imageUrl;

      // Reddit: preview.redd.it to i.redd.it (but NOT external-preview.redd.it)
      if (imageUrl.includes('preview.redd.it') && !imageUrl.includes('external-preview.redd.it')) {
        const match = imageUrl.match(/preview\.redd\.it\/([^?]+)/);
        if (match) {
          effectiveImageUrl = `https://i.redd.it/${match[1]}`;
        }
      }

      // Twitter: Convert query-param format to direct URL format
      // From: https://pbs.twimg.com/media/XXXXX?format=jpg&name=medium
      // To:   https://pbs.twimg.com/media/XXXXX.jpg
      if (imageUrl.includes('pbs.twimg.com/media/') && imageUrl.includes('?format=')) {
        const mediaMatch = imageUrl.match(/pbs\.twimg\.com\/media\/([^?]+)\?format=(\w+)/);
        if (mediaMatch) {
          const mediaId = mediaMatch[1];
          const format = mediaMatch[2];
          effectiveImageUrl = `https://pbs.twimg.com/media/${mediaId}.${format}`;
          log.debug(` Transformed Twitter URL: ${imageUrl.slice(0, 50)}... -> ${effectiveImageUrl}`);
        }
      }

      log.debug(` Sending to ${model}, imageUrl=${effectiveImageUrl.slice(0, 80)}...`);

      // Multimodal message with image URL (API fetches it)
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: effectiveImageUrl } },
        ],
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt,
      });
    }

    // Build request body - only use JSON mode for text models (not vision)
    // Note: max_tokens includes reasoning tokens, so we need extra room
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: 2000,
      temperature: 0.3,
      // Optimize for throughput - prefer fast providers like Groq and Cerebras
      provider: {
        order: ['Groq', 'Cerebras'],
        allow_fallbacks: true,
      },
    };

    // Only add JSON mode for non-vision requests
    if (!imageUrl) {
      requestBody.response_format = { type: 'json_object' };
    }

    // Log request details (truncate base64 for readability)
    const logMessages = messages.map(m => {
      if (Array.isArray(m.content)) {
        return {
          role: m.role,
          content: m.content.map(c => {
            if (c.type === 'image_url' && c.image_url?.url?.startsWith('data:')) {
              return { type: 'image_url', image_url: { url: `${c.image_url.url.slice(0, 50)}...[${c.image_url.url.length} chars]` } };
            }
            return c;
          }),
        };
      }
      return m;
    });
    // Log full prompt and image URL for debugging
    const textContent = messages[0]?.content;
    if (Array.isArray(textContent)) {
      const textPart = textContent.find(c => c.type === 'text');
      const imagePart = textContent.find(c => c.type === 'image_url');
      log.debug(` FULL PROMPT:\n${textPart?.text || '(no text)'}`);
      log.debug(` IMAGE URL: ${imagePart?.image_url?.url || '(no image)'}`);
    }
    log.debug(` OpenRouter request - model=${model}, messages=`, JSON.stringify(logMessages, null, 2).slice(0, 1500));

    const fetchStart = performance.now();
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'chrome-extension://tolerance',
        'X-Title': 'Tolerance',
      },
      body: JSON.stringify(requestBody),
    });
    const fetchEnd = performance.now();
    log.debug(` fetch completed in ${(fetchEnd - fetchStart).toFixed(0)}ms, total call time so far: ${(fetchEnd - callStart).toFixed(0)}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenRouter API error: ${response.status} for model=${model}`, errorText);
      return null;
    }

    const data = await response.json();

    // Extract usage for cost calculation
    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    const modelCosts = MODEL_COSTS[model] || MODEL_COSTS[DEFAULT_TEXT_MODEL];
    const cost =
      (inputTokens / 1_000_000) * modelCosts.input +
      (outputTokens / 1_000_000) * modelCosts.output;

    // Track usage
    await trackUsage(cost);

    // Parse response - check content first, then reasoning field
    const message = data.choices?.[0]?.message;
    let content = message?.content;

    // If content is empty, try reasoning field (some models use this)
    if (!content && message?.reasoning) {
      content = message.reasoning;
    }

    if (!content) {
      console.error('OpenRouter: No content in response');
      return null;
    }

    // Try to parse JSON from response
    // First: try parsing the entire content as JSON
    try {
      const parsed = JSON.parse(content);
      // Handle both single object {"score":X} and batch {"data":[...]} formats
      if (typeof parsed.score === 'number') {
        return {
          score: Math.min(10, Math.max(1, parsed.score)),
          reason: parsed.reason || '',
          cost,
          fullResponse: data,
        };
      }
      // For batch responses, return with fullResponse for caller to parse
      return {
        score: 5, // Placeholder, caller will use fullResponse
        reason: '',
        cost,
        fullResponse: data,
      };
    } catch {
      // Content isn't pure JSON, try to extract it
    }

    // Second: try to find JSON in markdown code blocks or mixed content
    // Use greedy regex to get the largest JSON object
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = content.match(/\[[\s\S]*\]/);

    // Try the longer match first (more likely to be complete)
    const candidates = [jsonObjectMatch?.[0], jsonArrayMatch?.[0]].filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0));

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed.score === 'number') {
          return {
            score: Math.min(10, Math.max(1, parsed.score)),
            reason: parsed.reason || '',
            cost,
            fullResponse: data,
          };
        }
        // Batch format - return for caller to parse
        return {
          score: 5,
          reason: '',
          cost,
          fullResponse: data,
        };
      } catch {
        // Try next candidate
      }
    }

    console.error('OpenRouter: Could not parse JSON from content:', content.slice(0, 300));

    // Fallback: try to extract score from text like "Score: 7" or just a number
    const scoreMatch = content.match(/(?:score[:\s]*)?(\d+)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1], 10);
      if (score >= 1 && score <= 10) {
        log.debug('OpenRouter: Extracted score from fallback pattern:', score);
        return {
          score,
          reason: 'Extracted from non-JSON response',
          cost,
          fullResponse: data,
        };
      }
    }

    console.error('OpenRouter: Could not extract score from:', content);
    return null;
  } catch (error) {
    console.error('OpenRouter call failed:', error);
    return null;
  }
}

// Track API usage
async function trackUsage(cost: number): Promise<void> {
  const result = await chrome.storage.local.get('apiUsage');
  const usage = result.apiUsage as ApiUsage || {
    totalCalls: 0,
    totalCost: 0,
    lastReset: Date.now(),
  };

  usage.totalCalls++;
  usage.totalCost += cost;

  await chrome.storage.local.set({ apiUsage: usage });
}

// Get current usage stats
export async function getApiUsage(): Promise<ApiUsage> {
  const result = await chrome.storage.local.get('apiUsage');
  return result.apiUsage as ApiUsage || {
    totalCalls: 0,
    totalCost: 0,
    lastReset: Date.now(),
  };
}

// Reset usage stats
export async function resetApiUsage(): Promise<void> {
  await chrome.storage.local.set({
    apiUsage: {
      totalCalls: 0,
      totalCost: 0,
      lastReset: Date.now(),
    },
  });
}

// Validate API key
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
