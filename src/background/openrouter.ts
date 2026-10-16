import { log } from '../shared/constants';
import { extractScoreFromText } from '../shared/score-parse';
// API client for engagement scoring
// Supports OpenRouter and any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, etc.)

import { getSettings, getNarrativeThemes } from './storage';
import { ApiProviderConfig, NarrativeTheme } from '../shared/types';
import { fetchImageViaContentScript } from './index';
import { getFreeTierApiKey } from './provisioning';
import { buildBatchPrompt, buildSinglePrompt, parseDims, readScore, ScoreDims, ScorePlatform, ScoringPost } from '../shared/scoring-spec';

export interface ScoreResponse {
  score: number; // 1-10
  reason: string;
  cost: number; // USD
  fullResponse?: unknown; // Full API response for debugging
  narrativeMatches?: string[]; // Theme IDs that matched (from LLM detection)
  dims?: ScoreDims; // Sub-ratings (hook, effort, pull, value) from the scoring spec
}

export interface ApiUsage {
  totalCalls: number;
  totalCost: number;
  lastReset: number;
}

// API error state for free tier exhaustion
export interface ApiErrorState {
  exhausted: boolean;
  message: string;
  timestamp: number;
}

// Track and retrieve API error state
export async function setApiErrorState(state: ApiErrorState | null): Promise<void> {
  if (state) {
    await chrome.storage.local.set({ apiErrorState: state });
  } else {
    await chrome.storage.local.remove('apiErrorState');
  }
}

export async function getApiErrorState(): Promise<ApiErrorState | null> {
  const result = await chrome.storage.local.get('apiErrorState');
  return result.apiErrorState || null;
}

// Model pricing (per 1M tokens, approximate) - OpenRouter only
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'anthropic/claude-haiku-4.5': { input: 1, output: 5 },
  'anthropic/claude-sonnet-4.5': { input: 3, output: 15 },
  'openai/gpt-oss-120b': { input: 0.039, output: 0.19 },
  'z-ai/glm-4.6v': { input: 0.3, output: 0.9 },
  'meta-llama/llama-4-scout': { input: 0.11, output: 0.34},
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
};

// Default models for OpenRouter
// Gemini 2.5 Flash Lite replaced gpt-oss-120b (Oct 2026): on the scoring eval
// (scripts/eval) it scored 40/40 in range vs 32-36, got jokes gpt-oss missed, and
// answered a 10-post batch in ~2s vs ~4s at about the same cost
const DEFAULT_TEXT_MODEL = 'google/gemini-2.5-flash-lite';
// Llama 4 Scout's providers went unreliable (Oct 2026: Groq/Cerebras dropped it,
// the rest at 0-40% uptime); Gemini 2.5 Flash Lite is similar in price and reliable
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_VIDEO_MODEL = 'google/gemini-2.5-flash-lite';
const DEFAULT_FULL_VIDEO_MODEL = 'google/gemini-2.5-flash-lite';

// Provider configuration built from settings
interface ProviderConfig {
  type: 'openrouter' | 'openai-compatible';
  endpoint: string;
  apiKey: string;
  textModel: string;
  imageModel: string;
  videoModel: string;
  supportsVision: boolean;
  trackCosts: boolean;
  isFreeTier: boolean; // True if using provisioned free tier key
}

// Build provider config from settings
async function getProviderConfig(): Promise<ProviderConfig> {
  const settings = await getSettings();
  const provider: ApiProviderConfig = settings.apiProvider || { type: 'openrouter' };

  log.debug(` Raw provider settings:`, JSON.stringify(provider));

  const isOpenRouter = provider.type !== 'openai-compatible';

  // Use appropriate API key based on provider type and tier
  let apiKey: string;
  let isFreeTier = false;

  if (isOpenRouter) {
    if (settings.apiTier === 'own-key' && settings.openRouterApiKey) {
      apiKey = settings.openRouterApiKey;
    } else {
      // Free tier - get provisioned key from backend
      isFreeTier = true;
      apiKey = await getFreeTierApiKey() || '';
      if (!apiKey) {
        log.debug(' Failed to get free tier API key - provisioning may have failed');
      }
    }
  } else {
    apiKey = provider.apiKey || '';
  }

  // Use custom models if specified (non-empty), otherwise use defaults
  // This works for both OpenRouter and custom endpoints
  const textModel = (provider.textModel && provider.textModel.trim()) || DEFAULT_TEXT_MODEL;
  const imageModel = (provider.imageModel && provider.imageModel.trim()) || DEFAULT_IMAGE_MODEL;
  const videoModel = (provider.imageModel && provider.imageModel.trim()) || DEFAULT_FULL_VIDEO_MODEL;

  log.debug(` Provider config: type=${isOpenRouter ? 'openrouter' : 'custom'}, hasKey=${!!apiKey}, isFreeTier=${isFreeTier}, textModel=${textModel}, imageModel=${imageModel}, supportsVision=${!isOpenRouter ? (provider.visionMode !== 'disabled') : true}`);

  return {
    type: provider.type || 'openrouter',
    endpoint: isOpenRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : (provider.endpoint || 'http://localhost:11434/v1/chat/completions'),
    apiKey,
    textModel,
    imageModel,
    videoModel,
    supportsVision: isOpenRouter ? true : (provider.visionMode !== 'disabled'),
    trackCosts: provider.trackCosts !== false && isOpenRouter,
    isFreeTier,
  };
}

// Check if API is configured (has key or is local endpoint)
export async function isApiConfigured(): Promise<boolean> {
  const config = await getProviderConfig();
  // OpenRouter requires API key, local endpoints may not
  if (config.type === 'openrouter') {
    return Boolean(config.apiKey);
  }
  // For local endpoints, just check if endpoint is set
  return Boolean(config.endpoint);
}

// Post data for batch scoring
export interface PostForScoring {
  id: string;
  title: string;
  subreddit: string; // For Reddit: subreddit name, for Twitter: @username
  score: number | null;
  numComments: number;
  platform?: ScorePlatform;
}

// Batch score result
export interface BatchScoreResult {
  id?: string;
  postId?: string;
  score: number;
  reason: string;
  narratives?: number[]; // Indices of matched themes (1-based from prompt)
}

// Helper: Convert 1-based narrative indices from LLM to theme IDs
function convertNarrativeIndicesToThemeIds(
  indices: number[] | undefined,
  activeThemes: NarrativeTheme[]
): string[] {
  if (!indices || !Array.isArray(indices) || indices.length === 0) {
    return [];
  }

  const themeIds: string[] = [];
  for (const idx of indices) {
    // Indices are 1-based in the prompt
    const theme = activeThemes[idx - 1];
    if (theme) {
      themeIds.push(theme.id);
      log.debug(` Matched narrative index ${idx} to theme "${theme.name}" (${theme.id})`);
    }
  }
  return themeIds;
}

function platformLabel(platform: ScorePlatform): string {
  return { reddit: 'Reddit', twitter: 'Twitter', youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook' }[platform];
}

function inferPlatform(source: string): ScorePlatform {
  return source.startsWith('@') ? 'twitter' : 'reddit';
}

// Source as the spec expects it: subreddit without r/, Twitter/Instagram with @
function sourceFor(platform: ScorePlatform, source: string): string {
  if (platform === 'reddit') return source.replace(/^r\//, '');
  if ((platform === 'twitter' || platform === 'instagram') && !source.startsWith('@')) return `@${source}`;
  return source;
}

function toScoringPost(p: PostForScoring): ScoringPost {
  const platform = p.platform ?? inferPlatform(p.subreddit);
  return {
    id: p.id,
    platform,
    text: p.title,
    source: sourceFor(platform, p.subreddit),
    likes: platform === 'youtube' ? undefined : p.score,
    comments: platform === 'youtube' ? undefined : p.numComments,
  };
}

// Score multiple text posts in a single API call
export async function scoreTextPostsBatch(
  posts: PostForScoring[]
): Promise<Map<string, ScoreResponse>> {
  const batchStart = performance.now();
  log.debug(` scoreTextPostsBatch START for ${posts.length} posts at t=${batchStart.toFixed(0)}`);

  if (posts.length === 0) {
    return new Map();
  }

  // Load active narrative themes for LLM detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);
  log.debug(` Loaded ${activeThemes.length} active narrative themes`);

  const prompt = buildBatchPrompt(posts.map(toScoringPost), activeThemes);

  try {
    const response = await callOpenRouter(prompt, undefined, undefined, 'text-batch', posts.length);
    log.debug(` Batch API response:`, response ? 'got response' : 'null response');
    if (!response) {
      log.debug(` Batch API returned null`);
      return new Map();
    }

    // Parse batch response - expect array in fullResponse
    log.debug(` fullResponse type:`, typeof response.fullResponse);
    let content = (response.fullResponse as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content || '';
    log.debug(' Batch response content:', content.slice(0, 500));

    // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
      log.debug(' Stripped markdown code block, content now:', content.slice(0, 200));
    }

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
      } else if (typeof fullParsed.id === 'string' && typeof fullParsed.score === 'number') {
        // Handle single object response (when model returns one object instead of array)
        // This happens sometimes with single-post batches
        parsed = [fullParsed];
        log.debug(' Wrapped single object response into array');
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
        const itemId = String(item.id || (item as unknown as { postId?: string }).postId ||
                      (item as unknown as { post_id?: string }).post_id || '').trim();
        const itemScore = readScore(item);
        if (itemScore === undefined) {
          log.debug(` Batch item ${itemId || i} has no usable score, leaving it unscored:`, JSON.stringify(item).slice(0, 200));
          continue;
        }
        const reason = item.reason || '';

        // Convert narrative indices to theme IDs
        const narrativeMatches: string[] = [];
        if (item.narratives && Array.isArray(item.narratives) && item.narratives.length > 0) {
          log.debug(` Post ${itemId} has narratives:`, item.narratives);
          for (const idx of item.narratives) {
            // Indices are 1-based in the prompt
            const theme = activeThemes[idx - 1];
            if (theme) {
              narrativeMatches.push(theme.id);
              log.debug(` Matched narrative index ${idx} to theme "${theme.name}" (${theme.id})`);
            } else {
              log.debug(` Narrative index ${idx} did not match any theme (activeThemes.length=${activeThemes.length})`);
            }
          }
        } else if (activeThemes.length > 0 && reason.toLowerCase().includes('kardashian')) {
          // Debug: LLM mentioned kardashian in reason but didn't return narrative match
          log.debug(` Post ${itemId} mentions kardashian in reason but narratives=${JSON.stringify(item.narratives)}`);
        }

        const scoreResponse: ScoreResponse = {
          score: itemScore,
          reason,
          cost: costPerPost,
          narrativeMatches: narrativeMatches.length > 0 ? narrativeMatches : undefined,
          dims: parseDims(item),
        };

        if (itemId && posts.some(p => p.id === itemId)) {
          results.set(itemId, scoreResponse);
        } else if (i < posts.length) {
          // Fall back to matching by order
          results.set(posts[i].id, scoreResponse);
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
  posts: (PostForScoring & { galleryDescription?: string })[]
): Promise<Map<string, ScoreResponse>> {
  const batchStart = performance.now();
  log.debug(` scoreTextPostsBatchWithGalleries START for ${posts.length} posts`);

  if (posts.length === 0) {
    return new Map();
  }

  // Load active narrative themes for LLM detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);

  const prompt = buildBatchPrompt(posts.map(p => ({
    ...toScoringPost(p),
    media: p.galleryDescription ? 'gallery' as const : 'text' as const,
    imageDescriptions: p.galleryDescription,
  })), activeThemes);

  try {
    const response = await callOpenRouter(prompt, undefined, undefined, 'text-batch', posts.length);
    if (!response) {
      return new Map();
    }

    let content = (response.fullResponse as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content || '';

    // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
    }

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
      } else if (typeof fullParsed.id === 'string' && typeof fullParsed.score === 'number') {
        // Handle single object response (when model returns one object instead of array)
        // This happens sometimes with single-post batches
        parsed = [fullParsed];
        log.debug(' Wrapped single object response into array');
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
        const itemId = String(item.id || (item as unknown as { postId?: string }).postId ||
                      (item as unknown as { post_id?: string }).post_id || '').trim();
        const itemScore = readScore(item);
        if (itemScore === undefined) {
          log.debug(` Batch item ${itemId || i} has no usable score, leaving it unscored:`, JSON.stringify(item).slice(0, 200));
          continue;
        }
        const reason = item.reason || '';

        // Convert narrative indices to theme IDs
        const narrativeMatches: string[] = [];
        if (item.narratives && Array.isArray(item.narratives)) {
          for (const idx of item.narratives) {
            // Indices are 1-based in the prompt
            const theme = activeThemes[idx - 1];
            if (theme) {
              narrativeMatches.push(theme.id);
            }
          }
        }

        const scoreResponse: ScoreResponse = {
          score: itemScore,
          reason,
          cost: costPerPost,
          narrativeMatches: narrativeMatches.length > 0 ? narrativeMatches : undefined,
          dims: parseDims(item),
        };

        if (itemId && posts.some(p => p.id === itemId)) {
          results.set(itemId, scoreResponse);
        } else if (i < posts.length) {
          results.set(posts[i].id, scoreResponse);
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
  platform?: ScorePlatform
): Promise<ScoreResponse | null> {
  // Check if API is configured (OpenRouter key OR custom endpoint)
  const apiConfigured = await isApiConfigured();
  if (!apiConfigured) {
    return null;
  }

  // Load active narrative themes for detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);
  const prompt = buildSinglePrompt(
    toScoringPost({ id: '', title, subreddit, score, numComments, platform: platform ?? inferPlatform(subreddit) }),
    activeThemes
  );

  return callOpenRouter(prompt, undefined, undefined, 'text-single', 1, activeThemes);
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
  imageUrls: string[]
): Promise<string> {
  log.debug(` describeImages called with ${imageUrls.length} URLs:`, imageUrls);

  const config = await getProviderConfig();

  // If vision not supported, return placeholder
  if (!config.supportsVision) {
    return 'Vision model not available - images not analyzed.';
  }

  const prompt = `Briefly describe each image in 1-2 sentences. Focus on: subject matter, emotional tone, any text visible, and anything striking, cute, funny or provocative about it.`;

  // Build image content with URLs
  const imageContents: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: 'text', text: prompt }
  ];

  for (const url of imageUrls.slice(0, 4)) { // Limit to 4 images
    // Keep original URL - preview.redd.it URLs have auth tokens in query params
    let imageUrl = url;

    // Reddit images: fetch via content script and convert to base64
    // Reddit blocks API servers from fetching directly (403 error)
    if (imageUrl.includes('redd.it') && !imageUrl.startsWith('data:')) {
      log.debug(` Fetching Reddit gallery image via content script: ${imageUrl.slice(0, 60)}...`);
      const base64 = await fetchImageViaContentScript(imageUrl);
      if (base64) {
        imageUrl = base64;
        log.debug(` Converted gallery image to base64 (${base64.length} chars)`);
      } else {
        // Skip images we can't fetch - gallery will use text-only scoring
        log.debug(` Skipping gallery image (403 blocked)`);
        continue;
      }
    }

    log.debug(` Adding image: ${imageUrl.startsWith('data:') ? 'base64' : imageUrl.slice(0, 60)}...`);
    imageContents.push({ type: 'image_url', image_url: { url: imageUrl } });
  }

  if (imageContents.length === 1) {
    return 'No images could be loaded.';
  }

  try {
    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (config.type === 'openrouter') {
      headers['HTTP-Referer'] = 'chrome-extension://tolerance';
      headers['X-Title'] = 'Tolerance';
    }

    // Build request body
    const requestBody: Record<string, unknown> = {
      model: config.imageModel,
      messages: [{ role: 'user', content: imageContents }],
      max_tokens: 500,
      temperature: 0.3,
    };

    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
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
// source can be "subredditName" for Reddit or "@username" for Twitter/Instagram
// platform parameter explicitly specifies the platform (defaults to detecting from source prefix)
export async function scoreImagePost(
  title: string,
  source: string,
  imageUrl: string,
  score: number | null,
  numComments: number,
  postId?: string,
  bodyText?: string,
  platform?: ScorePlatform
): Promise<ScoreResponse | null> {
  // Check if API is configured (OpenRouter key OR custom endpoint)
  const apiConfigured = await isApiConfigured();
  if (!apiConfigured) {
    return null;
  }

  // Load active narrative themes for detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);
  const plat = platform ?? inferPlatform(source);
  const platformName = platformLabel(plat);
  const post: ScoringPost = {
    platform: plat, text: title, source: sourceFor(plat, source),
    likes: score, comments: numComments, bodyText, media: 'image',
  };

  // Log what we're scoring
  log.debug(` scoreImagePost - platform=${platformName}, text="${title.slice(0, 50)}...", imageUrl=${imageUrl}`);

  // Check if this is a gallery - try to fetch all images (Reddit only)
  let imageDescriptions = '';
  let galleryImages: string[] = [];

  if (postId && platformName === 'Reddit') {
    galleryImages = await fetchGalleryImages(postId);
  }

  if (galleryImages.length > 1) {
    // Multi-image: get descriptions then score with text model
    log.debug(` Gallery detected with ${galleryImages.length} images, using two-step scoring`);

    imageDescriptions = await describeImages(galleryImages);
    log.debug(` Image descriptions: ${imageDescriptions.slice(0, 200)}...`);

    // Now score with text model using descriptions
    const prompt = buildSinglePrompt({ ...post, media: 'gallery', imageDescriptions }, activeThemes);

    return callOpenRouter(prompt, undefined, undefined, 'image', 1, activeThemes);
  }

  // Single image: use vision model from config
  const config = await getProviderConfig();
  log.debug(` scoreImagePost single image - config.type=${config.type}, config.imageModel=${config.imageModel}, imageUrl=${imageUrl}`);

  const prompt = buildSinglePrompt(post, activeThemes);

  return callOpenRouter(prompt, config.imageModel, imageUrl, 'image', 1, activeThemes);
}

// Score a video/gif post using thumbnail
// source can be "subredditName" for Reddit or "@username" for Twitter/Instagram
// platform parameter explicitly specifies the platform (defaults to detecting from source prefix)
export async function scoreVideoPost(
  title: string,
  source: string,
  thumbnailUrl: string,
  score: number | null,
  numComments: number,
  platform?: ScorePlatform
): Promise<ScoreResponse | null> {
  // Check if API is configured (OpenRouter key OR custom endpoint)
  const apiConfigured = await isApiConfigured();
  if (!apiConfigured) {
    return null;
  }

  // Load active narrative themes for detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);
  const plat = platform ?? inferPlatform(source);
  const platformName = platformLabel(plat);

  // Use image model from config for thumbnail-based scoring
  const config = await getProviderConfig();

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

  log.debug(` scoreVideoPost - platform=${platformName}, text="${title.slice(0, 50)}...", thumbnail=${imageUrl}`);

  const prompt = buildSinglePrompt({
    platform: plat, text: title, source: sourceFor(plat, source),
    likes: score, comments: numComments, media: 'video',
  }, activeThemes);

  return callOpenRouter(prompt, config.imageModel, imageUrl || undefined, 'video', 1, activeThemes);
}

// Score Instagram video/reel using Gemini video model
// This sends the actual video URL for analysis (not just thumbnail)
export async function scoreInstagramVideo(
  caption: string,
  author: string,
  videoUrl: string,
  likeCount: number | null,
  commentCount: number
): Promise<ScoreResponse | null> {
  // Check if API is configured (OpenRouter key OR custom endpoint)
  const apiConfigured = await isApiConfigured();
  if (!apiConfigured) {
    return null;
  }

  // Load active narrative themes for detection
  const allThemes = await getNarrativeThemes();
  const activeThemes = allThemes.filter(t => t.active && t.description);
  log.debug(` scoreInstagramVideo - author=@${author}, caption="${caption.slice(0, 50)}...", videoUrl=${videoUrl}`);

  const prompt = buildSinglePrompt({
    platform: 'instagram', text: caption, source: sourceFor('instagram', author),
    likes: likeCount, comments: commentCount, media: 'reel',
  }, activeThemes);

  // Use the Gemini video model for full video analysis
  return callOpenRouter(prompt, DEFAULT_FULL_VIDEO_MODEL, videoUrl, 'instagram-video', 1, activeThemes);
}

// Call type for tracking
type ApiCallType = 'text-batch' | 'image' | 'video' | 'gallery-describe' | 'instagram-video' | 'text-single';

// Core API call function - supports both OpenRouter and OpenAI-compatible endpoints
async function callApi(
  config: ProviderConfig,
  prompt: string,
  model: string,
  imageUrl?: string,
  callType: ApiCallType = 'text-single',
  postCount: number = 1,
  activeThemes?: NarrativeTheme[]
): Promise<ScoreResponse | null> {
  const callStart = performance.now();
  log.debug(` callApi START at t=${callStart.toFixed(0)}, model=${model}, endpoint=${config.endpoint}`);

  // If vision requested but not supported, skip the image
  const effectiveImageUrl = (imageUrl && config.supportsVision) ? imageUrl : undefined;
  if (imageUrl && !config.supportsVision) {
    log.debug(' Vision not supported, falling back to text-only scoring');
  }

  try {
    const messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: 'low' | 'high' | 'auto' } }>;
    }> = [];

    if (effectiveImageUrl) {
      // Transform image URLs for better API accessibility
      let transformedImageUrl = effectiveImageUrl;

      // Keep preview.redd.it URLs as-is - they have auth tokens in query params
      // Don't transform to i.redd.it which strips the auth

      // Twitter: Convert query-param format to direct URL format
      if (effectiveImageUrl.includes('pbs.twimg.com/media/') && effectiveImageUrl.includes('?format=')) {
        const mediaMatch = effectiveImageUrl.match(/pbs\.twimg\.com\/media\/([^?]+)\?format=(\w+)/);
        if (mediaMatch) {
          const mediaId = mediaMatch[1];
          const format = mediaMatch[2];
          transformedImageUrl = `https://pbs.twimg.com/media/${mediaId}.${format}`;
          log.debug(` Transformed Twitter URL: ${effectiveImageUrl.slice(0, 50)}... -> ${transformedImageUrl}`);
        }
      }

      // Fetch ALL images via content script to resize them (reduces tokens from ~2000 to ~200-400)
      // Content script resizes to max 512px before base64 encoding
      if (!transformedImageUrl.startsWith('data:')) {
        log.debug(` Fetching image via content script for resize: ${transformedImageUrl.slice(0, 60)}...`);
        const base64 = await fetchImageViaContentScript(transformedImageUrl);
        if (base64) {
          transformedImageUrl = base64;
          log.debug(` Image resized and converted to base64 (${base64.length} chars)`);
        } else {
          // Can't fetch image - fall back to text-only scoring
          log.debug(` Image fetch failed, falling back to text-only scoring`);
          messages.push({
            role: 'user',
            content: prompt,
          });
          transformedImageUrl = ''; // Clear so we don't add image below
        }
      }

      // Only add image if we have a valid URL/base64
      if (transformedImageUrl) {
        log.debug(` Sending to ${model}, image=${transformedImageUrl.startsWith('data:') ? 'base64' : transformedImageUrl.slice(0, 60)}...`);

        // Multimodal message with image URL
        // Use detail: 'low' to reduce token cost from ~1500-2500 to ~85 tokens
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: transformedImageUrl, detail: 'low' } },
          ],
        });
      }
    } else {
      messages.push({
        role: 'user',
        content: prompt,
      });
    }

    // Build request body - keep it minimal for local model compatibility
    // Image/video scoring only needs ~40 tokens for {"score": N, "reason": "..."}
    // Text batches need more for multiple post responses
    const isImageCall = callType === 'image' || callType === 'video' || callType === 'instagram-video';
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      // A 40-video YouTube batch takes ~3,300 tokens with sub-ratings
      max_tokens: isImageCall ? 300 : 8000, // 40 truncated the JSON mid-reason; sub-ratings need more
      stream: false,
    };

    // Only add OpenRouter-specific options
    if (config.type === 'openrouter') {
      requestBody.temperature = 0.3;
      // gpt-oss-120b (the old default text model) is fastest on Groq/Cerebras
      if (model === 'openai/gpt-oss-120b') {
        requestBody.provider = {
          order: ['groq', 'cerebras'],
          allow_fallbacks: true,
        };
      }
      // Only add JSON mode for OpenRouter non-vision requests
      if (!effectiveImageUrl) {
        requestBody.response_format = { type: 'json_object' };
      }
    }

    // Build headers - OpenRouter needs specific headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add auth header if API key is provided
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    // OpenRouter-specific headers
    if (config.type === 'openrouter') {
      headers['HTTP-Referer'] = 'chrome-extension://tolerance';
      headers['X-Title'] = 'Tolerance';
    }

    // Log request details
    log.debug(` API request - endpoint=${config.endpoint}, model=${model}`);

    const fetchStart = performance.now();
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    const fetchEnd = performance.now();
    log.debug(` fetch completed in ${(fetchEnd - fetchStart).toFixed(0)}ms`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API error: ${response.status} for model=${model}`, errorText);
      // A 429 from the model's provider ("rate-limited upstream") is transient and says
      // nothing about the user's key; only key/account limits set the error state
      const upstreamLimited = response.status === 429 && /upstream|provider returned error/i.test(errorText);
      lastCallError = upstreamLimited
        ? `${UPSTREAM_RATE_LIMITED} (${model})`
        : `API error ${response.status} (${model}): ${errorText.slice(0, 160)}`;

      // Check for budget exhaustion / key limit / rate limit errors (402, 403, 429)
      if (!upstreamLimited && (response.status === 402 || response.status === 403 || response.status === 429)) {
        await setApiErrorState({
          exhausted: true,
          message: config.isFreeTier
            ? 'Free tier daily limit reached. Add your own API key for unlimited usage.'
            : `OpenRouter rejected the API key (${response.status}). Check the key's spend limit and account credits at openrouter.ai.`,
          timestamp: Date.now(),
        });
        log.debug(config.isFreeTier
          ? ' Free tier exhausted - setting error state'
          : ` API key error (${response.status}) - setting error state`);
      }

      return null;
    }

    // Clear any previous error state on successful request
    const errorState = await getApiErrorState();
    if (errorState?.exhausted) {
      await setApiErrorState(null);
      log.debug(' API working again - cleared error state');
    }

    const data = await response.json();

    // Extract usage for cost calculation
    const usage = data.usage || {};
    const inputTokens = usage.prompt_tokens || 0;
    const outputTokens = usage.completion_tokens || 0;

    // Calculate cost only for OpenRouter (local models are free)
    let cost = 0;
    if (config.trackCosts) {
      const modelCosts = MODEL_COSTS[model] || { input: 0, output: 0 };
      cost = (inputTokens / 1_000_000) * modelCosts.input +
             (outputTokens / 1_000_000) * modelCosts.output;
    }

    // Track usage with details for benchmarking
    await trackUsage(cost, config.trackCosts, {
      model,
      type: callType,
      postCount,
      inputTokens,
      outputTokens,
    });

    // Parse response - check content first, then reasoning field
    const message = data.choices?.[0]?.message;
    let content = message?.content;

    // If content is empty, try reasoning field (some models use this)
    if (!content && message?.reasoning) {
      content = message.reasoning;
    }

    if (!content) {
      console.error('API: No content in response');
      lastCallError = `Empty reply from ${model}`;
      return null;
    }

    // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      content = codeBlockMatch[1].trim();
    }

    // Try to parse JSON from response
    try {
      const parsed = JSON.parse(content);
      const parsedScore = readScore(parsed);
      if (parsedScore !== undefined) {
        // Convert narrative indices to theme IDs if themes provided
        const narrativeMatches = activeThemes
          ? convertNarrativeIndicesToThemeIds(parsed.narratives, activeThemes)
          : undefined;
        return {
          score: parsedScore,
          reason: parsed.reason || '',
          cost,
          fullResponse: data,
          narrativeMatches: narrativeMatches?.length ? narrativeMatches : undefined,
          dims: parseDims(parsed),
        };
      }
      return noScoreResult(callType, model, content, cost, data);
    } catch {
      // Content isn't pure JSON, try to extract it
    }

    // Try to find JSON in markdown code blocks or mixed content
    const jsonObjectMatch = content.match(/\{[\s\S]*\}/);
    const jsonArrayMatch = content.match(/\[[\s\S]*\]/);

    const candidates = [jsonObjectMatch?.[0], jsonArrayMatch?.[0]].filter(Boolean).sort((a, b) => (b?.length || 0) - (a?.length || 0));

    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        const parsedScore = readScore(parsed);
        if (parsedScore !== undefined) {
          // Convert narrative indices to theme IDs if themes provided
          const narrativeMatches = activeThemes
            ? convertNarrativeIndicesToThemeIds(parsed.narratives, activeThemes)
            : undefined;
          return {
            score: parsedScore,
            reason: parsed.reason || '',
            cost,
            fullResponse: data,
            narrativeMatches: narrativeMatches?.length ? narrativeMatches : undefined,
            dims: parseDims(parsed),
          };
        }
        return noScoreResult(callType, model, content, cost, data);
      } catch {
        // Try next candidate
      }
    }

    console.error('API: Could not parse JSON from content:', content.slice(0, 300));

    // Fallback: an explicitly labelled score only. Otherwise return null: the post
    // stays a failed score (neutral 50, not cached) and is re-scored next time.
    const extracted = extractScoreFromText(content);
    if (extracted) {
      log.debug('API: Extracted score from fallback pattern:', extracted.score);
      return { ...extracted, cost, fullResponse: data };
    }

    console.error('API: Could not extract score from:', content);
    lastCallError = `Unreadable reply from ${model}: "${content.slice(0, 160)}"`;
    return null;
  } catch (error) {
    console.error('API call failed:', error);
    lastCallError = `Request failed: ${error instanceof Error ? error.message : String(error)}`;
    return null;
  }
}

// Valid JSON but no usable score. Batch callers read the per-post results from
// fullResponse themselves, so they get it back; a single post fails (left unscored
// and re-scored later) instead of getting a made-up 5.
function noScoreResult(callType: ApiCallType, model: string, content: string, cost: number, data: unknown): ScoreResponse | null {
  if (callType === 'text-batch') return { score: 5, reason: '', cost, fullResponse: data };
  lastCallError = `Reply from ${model} had no score: "${content.slice(0, 160)}"`;
  return null;
}

// Internal wrapper - calls callApi with loaded config
// Why the most recent call returned null, for showing on failed scores (best effort:
// concurrent calls can overwrite it)
let lastCallError: string | null = null;
const UPSTREAM_RATE_LIMITED = 'Rate limited by the model provider';
export function getLastCallError(): string | null {
  return lastCallError;
}

async function callOpenRouter(
  prompt: string,
  model?: string,
  imageUrl?: string,
  callType: ApiCallType = 'text-single',
  postCount: number = 1,
  activeThemes?: NarrativeTheme[]
): Promise<ScoreResponse | null> {
  const config = await getProviderConfig();
  const effectiveModel = model || config.textModel;
  log.debug(` callOpenRouter using model: ${effectiveModel} (passed: ${model}, config: ${config.textModel})`);
  lastCallError = null;
  const result = await callApi(config, prompt, effectiveModel, imageUrl, callType, postCount, activeThemes);
  if (result || !getLastCallError()?.startsWith(UPSTREAM_RATE_LIMITED)) return result;

  // Provider rate limit: one retry after a short, jittered pause
  await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 1500));
  lastCallError = null;
  return callApi(config, prompt, effectiveModel, imageUrl, callType, postCount, activeThemes);
}

// Detailed API call tracking for benchmarking
export interface ApiCallLog {
  timestamp: number;
  model: string;
  type: 'text-batch' | 'image' | 'video' | 'gallery-describe' | 'instagram-video';
  postCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

// Track API usage
async function trackUsage(cost: number, trackCosts: boolean = true, details?: Partial<ApiCallLog>): Promise<void> {
  const result = await chrome.storage.local.get(['apiUsage', 'apiCallLog']);
  const usage = result.apiUsage as ApiUsage || {
    totalCalls: 0,
    totalCost: 0,
    lastReset: Date.now(),
  };

  // Always increment call count
  usage.totalCalls++;
  // Only add cost if tracking is enabled (OpenRouter)
  if (trackCosts) {
    usage.totalCost += cost;
  }

  // Detailed call logging (keep last 100 calls)
  if (details) {
    const callLog: ApiCallLog[] = result.apiCallLog || [];
    callLog.push({
      timestamp: Date.now(),
      model: details.model || 'unknown',
      type: details.type || 'text-batch',
      postCount: details.postCount || 1,
      inputTokens: details.inputTokens || 0,
      outputTokens: details.outputTokens || 0,
      cost,
    });
    // Keep only last 100 calls
    const trimmedLog = callLog.slice(-100);
    await chrome.storage.local.set({ apiUsage: usage, apiCallLog: trimmedLog });
  } else {
    await chrome.storage.local.set({ apiUsage: usage });
  }
}

// Get API call log for benchmarking
export async function getApiCallLog(): Promise<ApiCallLog[]> {
  const result = await chrome.storage.local.get('apiCallLog');
  return result.apiCallLog || [];
}

// Get call breakdown summary
export async function getApiCallSummary(): Promise<Record<string, { calls: number; cost: number; posts: number }>> {
  const log = await getApiCallLog();
  const summary: Record<string, { calls: number; cost: number; posts: number }> = {};

  for (const call of log) {
    const key = call.type;
    if (!summary[key]) {
      summary[key] = { calls: 0, cost: 0, posts: 0 };
    }
    summary[key].calls++;
    summary[key].cost += call.cost;
    summary[key].posts += call.postCount;
  }

  return summary;
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
