import { log } from '../shared/constants';
import {
  RedditPost,
  Tweet,
  YouTubeVideo,
  InstagramPost,
  EngagementScore,
  ScoreFactors,
  NarrativeDetection,
  NarrativeTheme,
  isWhitelisted,
} from '../shared/types';
import {
  OUTRAGE_KEYWORDS,
  CURIOSITY_GAP_KEYWORDS,
  TRIBAL_KEYWORDS,
  SUBREDDIT_CATEGORIES,
  scoreToBucket,
  NARRATIVE_KEYWORDS,
} from '../shared/constants';
import { getCachedScores, cacheScores, logCalibration, getSettings, getNarrativeThemes } from './storage';
import { scoreTextPost, scoreImagePost, scoreVideoPost, scoreInstagramVideo, scoreTextPostsBatch, scoreTextPostsBatchWithGalleries, PostForScoring, ScoreResponse, fetchGalleryImages, describeImages, isApiConfigured } from './openrouter';
import { trackUnclassifiedPost } from './themeDiscovery';

// Main scoring function - API-first approach
export async function scorePosts(
  posts: Omit<RedditPost, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const postIds = posts.map(p => p.id);

  // Check if API is configured (OpenRouter with key, or local endpoint)
  const apiEnabled = await isApiConfigured();
  log.debug(` API enabled: ${apiEnabled}`);

  // Fetch active narrative themes for detection
  const narrativeEnabled = settings.narrativeDetection?.enabled !== false; // Default to enabled
  const themes = narrativeEnabled ? await getActiveThemes() : [];
  const t1 = performance.now();

  if (themes.length > 0) {
    log.debug(` Narrative detection active with ${themes.length} themes`);
  }

  // Check cache first
  const cached = await getCachedScores(postIds);
  const uncached = posts.filter(p => !cached.has(p.id));
  const t2 = performance.now();

  log.debug(` Reddit posts: ${posts.length} total, ${cached.size} cached, ${uncached.length} uncached`);

  // Score uncached posts with heuristics
  const newScores: EngagementScore[] = [];
  const scoreMap = new Map<string, EngagementScore>();

  // Separate posts by type for efficient API batching
  const textPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];
  const mediaPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = calculateHeuristicScore(post, themes);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(post.author, 'reddit', settings.whitelist);
    newScores.push(score);
    scoreMap.set(post.id, score);

    // API-first: send ALL posts to API when configured
    // Heuristic is only used as fallback when no API configured
    if (apiEnabled) {
      const isMediaPost = (
        (post.mediaType === 'video' || post.mediaType === 'gif') ||
        (post.mediaType === 'image' || post.mediaType === 'gallery')
      );

      if (isMediaPost) {
        mediaPostsForApi.push({ post, score });
      } else {
        textPostsForApi.push({ post, score });
      }
    }
    // No API key = use heuristic score as-is (fallback for free tier users)
  }
  const t3 = performance.now();

  // Process API calls in optimized order:
  // 1. Separate galleries from single-image/video posts
  // 2. Fetch all gallery metadata in parallel (fast Reddit API)
  // 3. Get all image descriptions in parallel (vision model)
  // 4. Batch all text scoring together (text posts + gallery descriptions)
  // 5. Score single images/videos in parallel (vision model)

  const galleries: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];
  const singleMedia: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];

  for (const item of mediaPostsForApi) {
    if (item.post.mediaType === 'gallery') {
      galleries.push(item);
    } else {
      singleMedia.push(item);
    }
  }

  log.debug(` Scoring ${textPostsForApi.length} text, ${galleries.length} galleries, ${singleMedia.length} single media`);

  // Run all three scoring tracks in parallel:
  // Track 1: Text-only posts (batch immediately, no dependencies)
  // Track 2: Single media posts (score individually in parallel, no dependencies)
  // Track 3: Galleries (fetch -> describe -> score pipeline, runs as one parallel track)

  const scoringTracks: Promise<void>[] = [];

  // Track 1: Text-only posts - batch immediately
  if (textPostsForApi.length > 0) {
    scoringTracks.push(
      enrichTextPostsBatch(textPostsForApi).catch(err => {
        console.error('Text batch API enrichment failed:', err);
      })
    );
  }

  // Track 2: Single media posts - score in parallel immediately
  if (singleMedia.length > 0) {
    const mediaPromises = singleMedia.map(({ post, score }) =>
      enrichWithApiScore(post, score).catch(err => {
        console.error('Single media API enrichment failed:', err);
      })
    );
    scoringTracks.push(Promise.all(mediaPromises).then(() => {}));
  }

  // Track 3: Galleries - sequential pipeline (fetch -> describe -> score) as one parallel track
  if (galleries.length > 0) {
    scoringTracks.push((async () => {
      // Step 3a: Fetch all gallery images in parallel
      const galleryFetches = galleries.map(async ({ post }) => {
        const images = await fetchGalleryImages(post.id);
        return { postId: post.id, images };
      });
      const galleryResults = await Promise.all(galleryFetches);
      const galleryImagesMap = new Map<string, string[]>();
      for (const { postId, images } of galleryResults) {
        galleryImagesMap.set(postId, images);
      }
      log.debug(` Fetched gallery images for ${galleryResults.length} galleries`);

      // Step 3b: Get all image descriptions in parallel
      const descriptionPromises = galleries.map(async ({ post }) => {
        const images = galleryImagesMap.get(post.id) || [];
        if (images.length > 1) {
          const description = await describeImages(images);
          return { postId: post.id, description };
        }
        return { postId: post.id, description: '' };
      });
      const descResults = await Promise.all(descriptionPromises);
      const galleryDescriptions = new Map<string, string>();
      for (const { postId, description } of descResults) {
        if (description) {
          galleryDescriptions.set(postId, description);
        }
      }
      log.debug(` Got descriptions for ${galleryDescriptions.size} galleries`);

      // Step 3c: Batch score galleries with their descriptions
      const galleriesForScoring = galleries.map(g => ({
        ...g,
        galleryDescription: galleryDescriptions.get(g.post.id),
      }));
      await enrichTextPostsBatchWithGalleries(galleriesForScoring).catch(err => {
        console.error('Gallery batch API enrichment failed:', err);
      });
    })());
  }

  // Wait for all tracks to complete
  await Promise.all(scoringTracks);
  const t4 = performance.now();

  const totalApiCalls = (textPostsForApi.length > 0 ? 1 : 0) + singleMedia.length + (galleries.length > 0 ? 1 : 0);
  log.debug(` Scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, heuristics: ${(t3-t2).toFixed(0)}ms, API: ${(t4-t3).toFixed(0)}ms, total: ${(t4-t0).toFixed(0)}ms (${uncached.length} uncached, ${totalApiCalls} API batches)`);

  // Cache new scores (now potentially enriched with API scores)
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Combine cached and new scores
  const allScores: EngagementScore[] = [];
  for (const post of posts) {
    const cachedScore = cached.get(post.id);
    if (cachedScore) {
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === post.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Score tweets - adapts Twitter content to the scoring system
export async function scoreTweets(
  tweets: Omit<Tweet, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const tweetIds = tweets.map(t => t.id);

  // Check if API is configured (OpenRouter with key, or local endpoint)
  const apiEnabled = await isApiConfigured();

  // Fetch active narrative themes for detection
  const narrativeEnabled = settings.narrativeDetection?.enabled !== false;
  const themes = narrativeEnabled ? await getActiveThemes() : [];
  const t1 = performance.now();

  // Check cache first
  const cached = await getCachedScores(tweetIds);
  const uncached = tweets.filter(t => !cached.has(t.id));
  const t2 = performance.now();

  // Score uncached tweets with heuristics
  const newScores: EngagementScore[] = [];

  // Collect tweets for batched API scoring
  const tweetsForApi: { tweet: Omit<Tweet, 'element'>; score: EngagementScore }[] = [];

  for (const tweet of uncached) {
    const score = calculateTweetHeuristicScore(tweet, themes);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(tweet.author, 'twitter', settings.whitelist);
    newScores.push(score);

    // API-first: send ALL tweets to API when configured
    if (apiEnabled) {
      tweetsForApi.push({ tweet, score });
    }
  }

  // Separate tweets by type for API scoring
  const textTweets: { tweet: Omit<Tweet, 'element'>; score: EngagementScore }[] = [];
  const mediaTweets: { tweet: Omit<Tweet, 'element'>; score: EngagementScore }[] = [];

  for (const item of tweetsForApi) {
    // Check for direct media on main tweet
    const hasDirectMedia = (item.tweet.mediaType === 'image' || item.tweet.mediaType === 'video' || item.tweet.mediaType === 'gif')
      && (item.tweet.imageUrl || item.tweet.thumbnailUrl);

    // Check for media in quoted tweet (if main tweet has no direct media)
    const hasQuotedMedia = item.tweet.quotedTweet?.imageUrl && !hasDirectMedia;

    if (hasDirectMedia || hasQuotedMedia) {
      mediaTweets.push(item);
    } else {
      textTweets.push(item);
    }
  }

  log.debug(` Scoring ${textTweets.length} text tweets, ${mediaTweets.length} media tweets via API`);

  // Process text tweets (including quote tweet text)
  if (textTweets.length > 0) {
    const textPromises = textTweets.map(async ({ tweet, score }) => {
      try {
        // Build content with quote tweet if present
        let content = tweet.text;
        if (tweet.isQuoteTweet && tweet.quotedTweet) {
          content += `\n\n[Quote from @${tweet.quotedTweet.author}]: ${tweet.quotedTweet.text}`;
        }

        const apiResult = await scoreTextPost(
          content,
          `@${tweet.author}`,
          tweet.likeCount,
          tweet.numComments,
          settings.openRouterApiKey!
        );
        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'twitter');
        }
      } catch (err) {
        console.error('Tweet text API scoring failed:', err);
      }
    });
    await Promise.all(textPromises);
  }

  // Process media tweets (with image scoring)
  if (mediaTweets.length > 0) {
    const mediaPromises = mediaTweets.map(async ({ tweet, score }) => {
      try {
        // Build content with quote tweet if present
        let content = tweet.text;
        log.debug(` Media tweet ${tweet.id} - isQuoteTweet=${tweet.isQuoteTweet}, quotedTweet=${JSON.stringify(tweet.quotedTweet)}`);

        // Determine image source: main tweet or quoted tweet
        let imageUrl = tweet.imageUrl || tweet.thumbnailUrl || '';
        let imageSource = 'main';

        // If no main tweet image but quoted tweet has one, use that
        if (!imageUrl && tweet.quotedTweet?.imageUrl) {
          imageUrl = tweet.quotedTweet.imageUrl;
          imageSource = 'quoted';
          log.debug(` Using quoted tweet image for ${tweet.id}`);
        }

        // Always include quote tweet text if present
        if (tweet.isQuoteTweet && tweet.quotedTweet) {
          const quoteInfo = tweet.quotedTweet.imageUrl
            ? `[Quote from @${tweet.quotedTweet.author} (with image)]: ${tweet.quotedTweet.text}`
            : `[Quote from @${tweet.quotedTweet.author}]: ${tweet.quotedTweet.text}`;
          content += `\n\n${quoteInfo}`;
          log.debug(` Added quote tweet info for ${tweet.id}, hasQuotedImage=${!!tweet.quotedTweet.imageUrl}`);
        }

        log.debug(` Media tweet ${tweet.id} - content="${content.slice(0, 100)}...", imageUrl=${imageUrl?.slice(0, 60)}..., source=${imageSource}`);

        // Use image/video scoring
        const apiResult = tweet.mediaType === 'video' || tweet.mediaType === 'gif'
          ? await scoreVideoPost(
              content,
              `@${tweet.author}`,
              imageUrl,
              tweet.likeCount,
              tweet.numComments,
              settings.openRouterApiKey!
            )
          : await scoreImagePost(
              content,
              `@${tweet.author}`,
              imageUrl,
              tweet.likeCount,
              tweet.numComments,
              '', // no postId for tweets
              undefined,
              settings.openRouterApiKey!
            );

        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'twitter');
        }
      } catch (err) {
        console.error('Tweet media API scoring failed:', err);
      }
    });
    await Promise.all(mediaPromises);
  }
  const t3 = performance.now();

  log.debug(` Tweet scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  // Cache new scores
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Combine cached and new scores
  const allScores: EngagementScore[] = [];
  for (const tweet of tweets) {
    const cachedScore = cached.get(tweet.id);
    if (cachedScore) {
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === tweet.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Heuristic scoring for tweets - DISABLED, API-only mode
function calculateTweetHeuristicScore(
  tweet: Omit<Tweet, 'element'>,
  _themes: NarrativeTheme[]
): EngagementScore {
  // Return neutral score - API will provide the real score
  return {
    postId: tweet.id,
    heuristicScore: 50,
    heuristicConfidence: 'low',
    bucket: 'medium',
    factors: {
      engagementRatio: 0,
      commentDensity: tweet.likeCount > 0 ? tweet.numComments / tweet.likeCount : 0,
      keywordFlags: [],
      viralVelocity: 0,
    },
    timestamp: Date.now(),
  };
}

// Batch enrich text posts with API scores
async function enrichTextPostsBatch(
  posts: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[]
): Promise<void> {
  log.debug(` enrichTextPostsBatch called with ${posts.length} posts, types: ${posts.map(p => p.post.mediaType).join(', ')}`);

  const postsForScoring: PostForScoring[] = posts.map(({ post }) => ({
    id: post.id,
    title: post.title,
    subreddit: post.subreddit,
    score: post.score,
    numComments: post.numComments,
  }));

  const results = await scoreTextPostsBatch(postsForScoring);
  log.debug(` enrichTextPostsBatch got ${results.size} results for ${posts.length} posts`);

  // Apply results to scores
  for (const { post, score } of posts) {
    const apiResult = results.get(post.id);
    log.debug(` Post ${post.id} (${post.mediaType}): apiResult=${apiResult ? 'found' : 'missing'}`);
    if (apiResult) {
      const apiScore = apiResult.score * 10; // Normalize 1-10 to 0-100
      score.apiScore = apiScore;
      score.apiReason = apiResult.reason;
      score.bucket = scoreToBucket(apiScore);

      // Log calibration data (with full post info for fine-tuning)
      await logCalibration(post.id, score.heuristicScore, apiScore, {
        // Core content
        permalink: post.permalink,
        title: post.title,
        subreddit: post.subreddit,
        // Engagement metrics
        score: post.score,
        numComments: post.numComments,
        upvoteRatio: post.upvoteRatio,
        // Post metadata
        mediaType: post.mediaType,
        flair: post.flair,
        isNsfw: post.isNsfw,
        domain: post.domain,
        createdUtc: post.createdUtc,
        // Media URLs
        imageUrl: post.imageUrl,
        thumbnailUrl: post.thumbnailUrl,
        // API response
        apiReason: apiResult.reason,
        heuristicFactors: score.factors.keywordFlags,
      });

      log.debug(
        `Batch API enrichment for post=${post.id}, heuristic=${score.heuristicScore}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
      );
    }
  }
}

// Batch enrich text posts AND galleries (with pre-fetched descriptions) in a single API call
async function enrichTextPostsBatchWithGalleries(
  posts: { post: Omit<RedditPost, 'element'>; score: EngagementScore; galleryDescription?: string }[]
): Promise<void> {
  if (posts.length === 0) return;

  // Build batch request including gallery descriptions
  const postsForScoring: (PostForScoring & { galleryDescription?: string })[] = posts.map(({ post, galleryDescription }) => ({
    id: post.id,
    title: post.title,
    subreddit: post.subreddit,
    score: post.score,
    numComments: post.numComments,
    galleryDescription,
  }));

  const results = await scoreTextPostsBatchWithGalleries(postsForScoring);

  log.debug(` Batch results: ${results.size} scores returned for ${posts.length} posts`);
  if (results.size === 0) {
    log.debug(` No results returned from batch API call`);
  }

  // Apply results to scores
  for (const { post, score } of posts) {
    const apiResult = results.get(post.id);
    log.debug(` Looking for post ${post.id}, found: ${apiResult ? 'yes' : 'no'}`);
    if (apiResult) {
      const apiScore = apiResult.score * 10;
      score.apiScore = apiScore;
      score.apiReason = apiResult.reason;
      score.bucket = scoreToBucket(apiScore);

      await logCalibration(post.id, score.heuristicScore, apiScore, {
        permalink: post.permalink,
        title: post.title,
        subreddit: post.subreddit,
        score: post.score,
        numComments: post.numComments,
        upvoteRatio: post.upvoteRatio,
        mediaType: post.mediaType,
        flair: post.flair,
        isNsfw: post.isNsfw,
        domain: post.domain,
        createdUtc: post.createdUtc,
        imageUrl: post.imageUrl,
        thumbnailUrl: post.thumbnailUrl,
        apiReason: apiResult.reason,
        heuristicFactors: score.factors.keywordFlags,
      });

      log.debug(
        `Tolerance: Batch API enrichment for post=${post.id}, heuristic=${score.heuristicScore}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
      );
    }
  }
}

// Enrich an uncertain score with API result (for media posts)
async function enrichWithApiScore(
  post: Omit<RedditPost, 'element'>,
  score: EngagementScore
): Promise<void> {
  const startTime = performance.now();
  log.debug(` API call STARTED for post=${post.id} at t=${startTime.toFixed(0)}`);

  try {
    let apiResult;

    // Use appropriate scoring based on media type
    // Determine best available image URL
    const effectiveImageUrl = post.imageUrl || (
      post.thumbnailUrl &&
      !post.thumbnailUrl.includes('self') &&
      !post.thumbnailUrl.includes('default')
        ? post.thumbnailUrl
        : undefined
    );

    log.debug(` API routing for post=${post.id}, mediaType=${post.mediaType}, imageUrl=${post.imageUrl}, thumbnailUrl=${post.thumbnailUrl}, effectiveImageUrl=${effectiveImageUrl}`);

    if (
      (post.mediaType === 'video' || post.mediaType === 'gif') &&
      post.thumbnailUrl
    ) {
      // Video/gif posts use thumbnail with fast image model
      apiResult = await scoreVideoPost(
        post.title,
        post.subreddit,
        post.thumbnailUrl,
        post.score,
        post.numComments
      );
    } else if (
      (post.mediaType === 'image' || post.mediaType === 'gallery') &&
      (effectiveImageUrl || post.mediaType === 'gallery')
    ) {
      // Image/gallery posts - pass postId for gallery fetching
      apiResult = await scoreImagePost(
        post.title,
        post.subreddit,
        effectiveImageUrl || '',
        post.score,
        post.numComments,
        post.id // Pass postId for gallery image fetching
      );
    } else {
      // Text/link posts use text model
      apiResult = await scoreTextPost(
        post.title,
        post.subreddit,
        post.score,
        post.numComments
      );
    }

    if (apiResult) {
      const apiScore = apiResult.score * 10; // Normalize 1-10 to 0-100
      score.apiScore = apiScore;
      score.apiReason = apiResult.reason;
      // Update bucket based on API score (more accurate)
      score.bucket = scoreToBucket(apiScore);

      // Log calibration data for analysis (with full post info for fine-tuning)
      await logCalibration(post.id, score.heuristicScore, apiScore, {
        // Core content
        permalink: post.permalink,
        title: post.title,
        subreddit: post.subreddit,
        // Engagement metrics
        score: post.score,
        numComments: post.numComments,
        upvoteRatio: post.upvoteRatio,
        // Post metadata
        mediaType: post.mediaType,
        flair: post.flair,
        isNsfw: post.isNsfw,
        domain: post.domain,
        createdUtc: post.createdUtc,
        // Media URLs
        imageUrl: post.imageUrl,
        thumbnailUrl: post.thumbnailUrl,
        // API response
        apiReason: apiResult.reason,
        apiFullResponse: apiResult.fullResponse,
        heuristicFactors: score.factors.keywordFlags,
      });

      log.debug(
        `Tolerance: API enrichment for uncertain post=${post.id}, heuristic=${score.heuristicScore}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
      );
    }
  } catch (error) {
    console.error('API enrichment failed:', error);
  }
}

// Title pattern analysis for engagement signals
function analyzeTitlePatterns(
  title: string,
  postScore: number
): { points: number; confidence: number; flags: string[] } {
  let points = 0;
  let confidence = 0;
  const flags: string[] = [];

  // Caps ratio - excessive caps indicates shouting/clickbait
  const letters = title.replace(/[^a-zA-Z]/g, '');
  const capsCount = (title.match(/[A-Z]/g) || []).length;
  const capsRatio = letters.length > 0 ? capsCount / letters.length : 0;
  if (capsRatio > 0.3 && letters.length > 10) {
    points += 10;
    confidence += 1;
    flags.push(`pattern:caps_${Math.round(capsRatio * 100)}%`);
  }

  // Punctuation density - !!!, ???, or mixed
  const exclamations = (title.match(/!/g) || []).length;
  const questions = (title.match(/\?/g) || []).length;
  if (exclamations >= 2 || questions >= 2 || (exclamations >= 1 && questions >= 1)) {
    points += 8;
    confidence += 1;
    flags.push('pattern:punctuation_heavy');
  }

  // Short sensational titles with high engagement
  if (title.length < 40 && postScore > 1000) {
    points += 5;
    flags.push('pattern:short_viral');
  }

  // Rhetorical question patterns
  const rhetoricalPatterns = [
    /^why (do|does|is|are|can't|won't|don't)/i,
    /^how (is|are|can|could|do|does)/i,
    /^what (if|would|is wrong|happened)/i,
    /anyone else/i,
    /am i the only/i,
    /does anyone/i,
  ];
  for (const pattern of rhetoricalPatterns) {
    if (pattern.test(title)) {
      points += 5;
      confidence += 1;
      flags.push('pattern:rhetorical_question');
      break;
    }
  }

  // Emotional intensifiers
  const intensifiers = [
    'absolutely', 'literally', 'completely', 'totally', 'insanely',
    'incredibly', 'extremely', 'ridiculously', 'perfectly', 'genuinely',
  ];
  const titleLower = title.toLowerCase();
  for (const word of intensifiers) {
    if (titleLower.includes(word)) {
      points += 3;
      flags.push(`pattern:intensifier_${word}`);
      break;
    }
  }

  return { points, confidence, flags };
}

// Heuristic scoring - DISABLED, API-only mode
// Returns neutral score, all real scoring happens via API
function calculateHeuristicScore(
  post: Omit<RedditPost, 'element'>,
  _themes: NarrativeTheme[]
): EngagementScore {
  // Return neutral score - API will provide the real score
  return {
    postId: post.id,
    heuristicScore: 50, // Neutral - will be replaced by API
    heuristicConfidence: 'low',
    bucket: 'medium',
    factors: {
      engagementRatio: post.upvoteRatio || 0,
      commentDensity: post.numComments / Math.max(1, post.score ?? 1),
      keywordFlags: [],
      viralVelocity: 0,
    },
    timestamp: Date.now(),
  };
}

function calculateFactors(post: Omit<RedditPost, 'element'>): ScoreFactors {
  return {
    engagementRatio: post.upvoteRatio || 0,
    commentDensity: post.score > 0 ? post.numComments / post.score : 0,
    keywordFlags: [],
    viralVelocity: 0,
  };
}

// Narrative theme detection - checks against active themes
function detectNarrative(
  title: string,
  themes: NarrativeTheme[]
): NarrativeDetection | undefined {
  const titleLower = title.toLowerCase();

  let bestMatch: NarrativeDetection | undefined;
  let maxScore = 0;

  for (const theme of themes) {
    if (!theme.active) continue;

    let themeScore = 0;
    const matchedKeywords: string[] = [];

    for (const keyword of theme.keywords) {
      if (titleLower.includes(keyword.toLowerCase())) {
        themeScore++;
        matchedKeywords.push(keyword);
      }
    }

    if (themeScore > maxScore && themeScore >= 1) {
      maxScore = themeScore;
      const confidence = themeScore >= 3 ? 'high' : themeScore >= 2 ? 'medium' : 'low';
      bestMatch = {
        themeId: theme.id,
        confidence,
        matchedKeywords,
      };
    }
  }

  return bestMatch;
}

// Cached themes to avoid fetching on every post
let cachedThemes: NarrativeTheme[] | null = null;
let themeCacheTime = 0;
const THEME_CACHE_TTL = 60000; // 1 minute

async function getActiveThemes(): Promise<NarrativeTheme[]> {
  const now = Date.now();
  if (cachedThemes && now - themeCacheTime < THEME_CACHE_TTL) {
    return cachedThemes.filter(t => t.active);
  }

  const allThemes = await getNarrativeThemes();
  log.debug('Tolerance: Loaded themes from storage:', allThemes.map(t => `${t.id}(active=${t.active})`).join(', '));
  cachedThemes = allThemes;
  themeCacheTime = now;
  return cachedThemes.filter(t => t.active);
}

// Score YouTube videos - similar to tweets but adapted for video titles
export async function scoreVideos(
  videos: Omit<YouTubeVideo, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const videoIds = videos.map(v => v.id);

  // Check if API is configured (OpenRouter with key, or local endpoint)
  const apiEnabled = await isApiConfigured();

  // Fetch active narrative themes for detection
  const narrativeEnabled = settings.narrativeDetection?.enabled !== false;
  const themes = narrativeEnabled ? await getActiveThemes() : [];
  const t1 = performance.now();

  // Check cache first
  const cached = await getCachedScores(videoIds);
  const uncached = videos.filter(v => !cached.has(v.id));
  const t2 = performance.now();

  // Score uncached videos with heuristics
  const newScores: EngagementScore[] = [];

  // Collect videos for API scoring
  const videosForApi: { video: Omit<YouTubeVideo, 'element'>; score: EngagementScore }[] = [];

  for (const video of uncached) {
    const score = calculateVideoHeuristicScore(video, themes);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(video.channel, 'youtube', settings.whitelist);
    newScores.push(score);

    // API-first: send ALL videos to API when configured
    if (apiEnabled) {
      videosForApi.push({ video, score });
    }
  }

  // Process API scoring for videos (batch text scoring)
  if (videosForApi.length > 0) {
    log.debug(` Scoring ${videosForApi.length} videos via API`);

    const apiPromises = videosForApi.map(async ({ video, score }) => {
      try {
        // Score video title as text
        const apiResult = await scoreTextPost(
          video.title,
          video.channel || '@unknown',
          null, // No score/likes visible before clicking
          0, // No comments visible
          settings.openRouterApiKey!
        );
        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'youtube');
        }
      } catch (err) {
        console.error('Video API scoring failed:', err);
      }
    });
    await Promise.all(apiPromises);
  }
  const t3 = performance.now();

  log.debug(` Video scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  // Cache new scores
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Combine cached and new scores
  const allScores: EngagementScore[] = [];
  for (const video of videos) {
    const cachedScore = cached.get(video.id);
    if (cachedScore) {
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === video.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Heuristic scoring for YouTube videos - DISABLED, API-only mode
function calculateVideoHeuristicScore(
  video: Omit<YouTubeVideo, 'element'>,
  _themes: NarrativeTheme[]
): EngagementScore {
  // Return neutral score - API will provide the real score
  return {
    postId: video.id,
    heuristicScore: 50,
    heuristicConfidence: 'low',
    bucket: 'medium',
    factors: {
      engagementRatio: 0,
      commentDensity: 0,
      keywordFlags: [],
      viralVelocity: 0,
    },
    timestamp: Date.now(),
  };
}

// Score Instagram posts - adapts Instagram content to the scoring system
// Uses video model (Gemini) for reels/videos, similar to YouTube
export async function scoreInstagramPosts(
  posts: Omit<InstagramPost, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const postIds = posts.map(p => p.id);

  // Check if API is configured (OpenRouter with key, or local endpoint)
  const apiEnabled = await isApiConfigured();

  // Fetch active narrative themes for detection
  const narrativeEnabled = settings.narrativeDetection?.enabled !== false;
  const themes = narrativeEnabled ? await getActiveThemes() : [];
  const t1 = performance.now();

  // Check cache first
  const cached = await getCachedScores(postIds);
  const uncached = posts.filter(p => !cached.has(p.id));
  const t2 = performance.now();

  // Score uncached posts with heuristics
  const newScores: EngagementScore[] = [];

  // Collect posts for API scoring
  const postsForApi: { post: Omit<InstagramPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = calculateInstagramHeuristicScore(post, themes);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(post.author, 'instagram', settings.whitelist);
    newScores.push(score);

    // API-first: send ALL posts to API when configured
    if (apiEnabled) {
      postsForApi.push({ post, score });
    }
  }

  // Separate posts by type for API scoring
  const textPosts: { post: Omit<InstagramPost, 'element'>; score: EngagementScore }[] = [];
  const mediaPosts: { post: Omit<InstagramPost, 'element'>; score: EngagementScore }[] = [];

  for (const item of postsForApi) {
    // Instagram is media-heavy - check for video/reel or image content
    const hasMedia = item.post.isReel || item.post.mediaType === 'video' ||
                     item.post.mediaType === 'image' || item.post.mediaType === 'gallery';
    const hasImage = item.post.imageUrl || item.post.thumbnailUrl;

    if (hasMedia && hasImage) {
      mediaPosts.push(item);
    } else {
      // Caption-only posts (rare on Instagram)
      textPosts.push(item);
    }
  }

  log.debug(` Scoring ${textPosts.length} text Instagram posts, ${mediaPosts.length} media posts via API`);

  // Process text posts (caption-only)
  if (textPosts.length > 0) {
    const textPromises = textPosts.map(async ({ post, score }) => {
      try {
        const apiResult = await scoreTextPost(
          post.caption || post.text,
          `@${post.author}`,
          post.likeCount,
          post.commentCount,
          settings.openRouterApiKey!
        );
        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'instagram');
        }
      } catch (err) {
        console.error('Instagram text API scoring failed:', err);
      }
    });
    await Promise.all(textPromises);
  }

  // Process media posts (images/videos/reels)
  if (mediaPosts.length > 0) {
    const mediaPromises = mediaPosts.map(async ({ post, score }) => {
      try {
        const content = post.caption || post.text;
        const isVideo = post.isReel || post.mediaType === 'video' || post.mediaType === 'reel';

        let apiResult;

        if (isVideo && post.videoUrl) {
          // Use Gemini video model for reels/videos with actual video URL
          log.debug(` Instagram: Scoring video with Gemini - post=${post.id}, videoUrl=${post.videoUrl}`);
          apiResult = await scoreInstagramVideo(
            content,
            post.author,
            post.videoUrl,
            post.likeCount,
            post.commentCount,
            settings.openRouterApiKey!
          );
        } else if (isVideo) {
          // Fallback to thumbnail scoring if no video URL available
          const imageUrl = post.imageUrl || post.thumbnailUrl || '';
          log.debug(` Instagram: No video URL, using thumbnail - post=${post.id}, imageUrl=${imageUrl}`);
          apiResult = await scoreVideoPost(
            content,
            `@${post.author}`,
            imageUrl,
            post.likeCount,
            post.commentCount,
            settings.openRouterApiKey!,
            'instagram'
          );
        } else {
          // Image posts
          const imageUrl = post.imageUrl || post.thumbnailUrl || '';
          apiResult = await scoreImagePost(
            content,
            `@${post.author}`,
            imageUrl,
            post.likeCount,
            post.commentCount,
            post.id,
            undefined,
            settings.openRouterApiKey!,
            'instagram'
          );
        }

        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'instagram');
        }
      } catch (err) {
        console.error('Instagram media API scoring failed:', err);
      }
    });
    await Promise.all(mediaPromises);
  }
  const t3 = performance.now();

  log.debug(` Instagram scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  // Cache new scores
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Combine cached and new scores
  const allScores: EngagementScore[] = [];
  for (const post of posts) {
    const cachedScore = cached.get(post.id);
    if (cachedScore) {
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === post.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Heuristic scoring for Instagram posts - DISABLED, API-only mode
function calculateInstagramHeuristicScore(
  post: Omit<InstagramPost, 'element'>,
  _themes: NarrativeTheme[]
): EngagementScore {
  // Return neutral score - API will provide the real score
  return {
    postId: post.id,
    heuristicScore: 50,
    heuristicConfidence: 'low',
    bucket: 'medium',
    factors: {
      engagementRatio: 0,
      commentDensity: post.likeCount ? post.commentCount / post.likeCount : 0,
      keywordFlags: [],
      viralVelocity: 0,
    },
    timestamp: Date.now(),
  };
}
