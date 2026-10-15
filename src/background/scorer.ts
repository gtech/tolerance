import { log } from '../shared/constants';
import {
  RedditPost,
  Tweet,
  YouTubeVideo,
  InstagramPost,
  FacebookPost,
  EngagementScore,
  PostContent,
  NarrativeTheme,
  isWhitelisted,
} from '../shared/types';
import {
  scoreToBucket,
} from '../shared/constants';
import { getCachedScores, cacheScores, logCalibration, savePostContent, getSettings, getNarrativeThemes, getCounterStrategies } from './storage';
import { getLastCallError, scoreTextPost, scoreImagePost, scoreVideoPost, scoreInstagramVideo, scoreTextPostsBatch, scoreTextPostsBatchWithGalleries, PostForScoring, ScoreResponse, fetchGalleryImages, describeImages, isApiConfigured } from './openrouter';
import { trackUnclassifiedPost } from './themeDiscovery';
import { anchorCacheId, foldAnchorScore } from '../shared/anchor-utils';
import { getSubscriptionList, isSubscribed } from './subscriptions';

// Twitter video/gif thumbnails are often uninformative first frames,
// but videos inherently grab more attention than text posts
const TWITTER_VIDEO_SCORE_FLOOR = 40;
const VIDEO_FLOOR_NOTE = ` (video: counted as at least ${TWITTER_VIDEO_SCORE_FLOOR})`;

// Raise a video/gif tweet's score to the floor, noting why in the reason
function applyVideoFloor(score: EngagementScore): void {
  if (score.apiScore === undefined || score.scoreFailed || score.apiScore >= TWITTER_VIDEO_SCORE_FLOOR) return;
  score.apiScore = TWITTER_VIDEO_SCORE_FLOOR;
  score.bucket = scoreToBucket(TWITTER_VIDEO_SCORE_FLOOR, 'twitter');
  if (!score.apiReason?.endsWith(VIDEO_FLOOR_NOTE)) score.apiReason = `${score.apiReason ?? ''}${VIDEO_FLOOR_NOTE}`.trim();
}

// Apply enabled counter-strategy modifiers to scores with detected narratives.
// Runs once per scoring batch, before caching, so the adjusted score flows
// everywhere consistently: badge numbers, blur decisions, buckets, and the
// score cache. The scheduler must NOT re-apply modifiers (it reads these
// already-adjusted scores).
async function applyCounterStrategies(
  scores: EngagementScore[],
  platform: 'reddit' | 'twitter' | 'youtube' | 'instagram' | 'facebook'
): Promise<void> {
  const withNarrative = scores.filter(s => s.factors.narrative && !s.scoreFailed);
  if (withNarrative.length === 0) return;

  const strategies = (await getCounterStrategies()).filter(s => s.enabled && s.scoreModifier !== 0);
  if (strategies.length === 0) return;

  const themes = await getNarrativeThemes();

  for (const score of withNarrative) {
    const detection = score.factors.narrative!;
    const strategy = strategies.find(s => s.themeId === detection.themeId);
    if (!strategy) continue;

    const original = score.apiScore;
    score.apiScore = Math.max(0, Math.min(100, original + strategy.scoreModifier));
    score.bucket = scoreToBucket(score.apiScore, platform);
    detection.appliedModifier = strategy.scoreModifier;

    // Make the adjustment visible in the on-screen explanation
    const themeName = themes.find(t => t.id === detection.themeId)?.name || detection.themeId;
    const sign = strategy.scoreModifier > 0 ? '+' : '';
    const note = `[${sign}${strategy.scoreModifier} counter-strategy: ${themeName}]`;
    score.apiReason = score.apiReason ? `${score.apiReason} ${note}` : note;

    log.debug(` Counter-strategy applied to ${score.postId}: ${original} → ${score.apiScore} (${sign}${strategy.scoreModifier}, theme: ${themeName})`);
  }
}

// Record the narrative theme the model matched, so counter-strategies can apply
function recordNarrativeMatch(score: EngagementScore, narrativeMatches?: string[]): void {
  if (!narrativeMatches || narrativeMatches.length === 0) return;
  score.factors.narrative = {
    themeId: narrativeMatches[0],
    confidence: 'high',
    matchedKeywords: [],
  };
}

// Create a pending score — will be replaced by API result
export function createPendingScore(postId: string): EngagementScore {
  return {
    postId,
    apiScore: 50,
    bucket: 'medium',
    factors: {},
    timestamp: Date.now(),
    scoreFailed: true, // Will be cleared when API succeeds
  };
}

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
  // When API is enabled, only consider scores with apiScore as cached (re-score broken entries)
  const cached = await getCachedScores(postIds);
  const uncached = posts.filter(p => !cached.has(p.id));
  const t2 = performance.now();

  log.debug(` Reddit posts: ${posts.length} total, ${cached.size} cached, ${uncached.length} uncached`);

  // Initialize scores for uncached posts
  const newScores: EngagementScore[] = [];
  const scoreMap = new Map<string, EngagementScore>();

  // Separate posts by type for efficient API batching
  const textPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];
  const mediaPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = createPendingScore(post.id);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(post.author, 'reddit', settings.whitelist);
    newScores.push(score);
    scoreMap.set(post.id, score);

    // API-first: send ALL posts to API when configured
    // Send to API when configured
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
    // No API key = score stays at default (50) with scoreFailed flag
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

  await applyCounterStrategies(newScores, 'reddit');

  // Cache new scores (scoreFailed entries are cached but skipped on lookup)
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Save post content for ML training data (setting-gated inside savePostContent)
  await savePostContent(uncached.map(post => ({
    postId: post.id,
    platform: 'reddit' as const,
    text: post.text,
    title: post.title,
    author: post.author,
    subreddit: post.subreddit,
    imageUrl: post.imageUrl,
    thumbnailUrl: post.thumbnailUrl,
    mediaType: post.mediaType,
    timestamp: Date.now(),
  })));

  // Combine cached and new scores, applying whitelist to all
  const allScores: EngagementScore[] = [];
  for (const post of posts) {
    const cachedScore = cached.get(post.id);
    if (cachedScore) {
      // Re-check whitelist for cached scores (user may have whitelisted after caching)
      cachedScore.whitelisted = isWhitelisted(post.author, 'reddit', settings.whitelist);
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === post.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Score each anchored tweet's anchor (quoted tweet or thread parent) and fold it
// into the tweet's score. Anchor scores are reused from this batch or the cache
// when possible (a viral bait post gets quoted many times), else scored as text.
async function applyAnchorScores(
  tweets: Omit<Tweet, 'element'>[],
  scores: EngagementScore[]
): Promise<EngagementScore[]> {
  const byId = new Map(scores.map(s => [s.postId, s]));
  // Already-folded scores are re-folded too, so they track the anchor's latest score
  const anchored = tweets.filter(t => t.anchor && byId.has(t.id));
  if (anchored.length === 0) return [];

  const anchorIds = [...new Set(anchored.map(t => anchorCacheId(t.anchor!)))];
  const anchorScores = await getCachedScores(anchorIds.filter(id => !byId.has(id)));
  for (const id of anchorIds) {
    const inBatch = byId.get(id);
    if (inBatch && !inBatch.scoreFailed) anchorScores.set(id, inBatch);
  }

  // Score the anchors we haven't seen, once each
  const toScore = new Map<string, Omit<Tweet, 'element'>['anchor']>();
  for (const t of anchored) {
    const id = anchorCacheId(t.anchor!);
    if (!anchorScores.has(id) && t.anchor!.text) toScore.set(id, t.anchor);
  }
  const fresh: EngagementScore[] = [];
  await Promise.all([...toScore].map(async ([id, anchor]) => {
    try {
      const result = await scoreTextPost(anchor!.text, `@${anchor!.author}`, 0, 0);
      if (!result) return;
      const score = createPendingScore(id);
      score.apiScore = result.score * 10;
      score.apiReason = result.reason;
      score.scoreFailed = false;
      score.bucket = scoreToBucket(score.apiScore, 'twitter');
      anchorScores.set(id, score);
      // Thread parents are real tweets already cached under their own ID; only cache quote anchors
      if (id.startsWith('anchor:')) fresh.push(score);
    } catch (err) {
      console.error('Anchor scoring failed:', err);
    }
  }));
  if (fresh.length > 0) await cacheScores(fresh);

  const changed: EngagementScore[] = [];
  for (const t of anchored) {
    const score = byId.get(t.id);
    const anchorScore = anchorScores.get(anchorCacheId(t.anchor!));
    if (!score || !anchorScore) continue;
    const before = score.apiScore;
    if (foldAnchorScore(score, t.anchor!, anchorScore)) {
      changed.push(score);
      log.debug(` Anchor folded into ${t.id}: ${before} -> ${score.apiScore} (${t.anchor!.kind} of @${t.anchor!.author})`);
    } else if (!score.anchor) {
      log.debug(` Anchor for ${t.id} (@${t.anchor!.author}, ${anchorScore.apiScore}) not higher than own score ${score.apiScore}`);
    }
  }
  return changed;
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
  // When API is enabled, only consider scores with apiScore as cached
  const cached = await getCachedScores(tweetIds);
  const uncached = tweets.filter(t => !cached.has(t.id));
  const t2 = performance.now();

  // Score uncached tweets with heuristics
  const newScores: EngagementScore[] = [];

  // Collect tweets for batched API scoring
  const tweetsForApi: { tweet: Omit<Tweet, 'element'>; score: EngagementScore }[] = [];

  for (const tweet of uncached) {
    const score = createPendingScore(tweet.id);
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
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'twitter');
          recordNarrativeMatch(score, apiResult.narrativeMatches);
          if (tweet.mediaType === 'video' || tweet.mediaType === 'gif') applyVideoFloor(score);
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
              'twitter'
            )
          : await scoreImagePost(
              content,
              `@${tweet.author}`,
              imageUrl,
              tweet.likeCount,
              tweet.numComments,
              '', // no postId for tweets
              undefined,
              'twitter'
            );

        if (apiResult) {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'twitter');
          if (tweet.mediaType === 'video' || tweet.mediaType === 'gif') applyVideoFloor(score);

          // Apply narrative detection from LLM response
          if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
            score.factors.narrative = {
              themeId: apiResult.narrativeMatches[0],
              confidence: 'high',
              matchedKeywords: [],
            };
          }
        }
      } catch (err) {
        console.error('Tweet media API scoring failed:', err);
      }
    });
    await Promise.all(mediaPromises);
  }
  const t3 = performance.now();

  log.debug(` Tweet scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  await applyCounterStrategies(newScores, 'twitter');

  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Save post content for ML training data
  await savePostContent(uncached.map(tweet => ({
    postId: tweet.id,
    platform: 'twitter' as const,
    text: tweet.text,
    author: tweet.author,
    subreddit: `@${tweet.author}`,
    imageUrl: tweet.imageUrl,
    thumbnailUrl: tweet.thumbnailUrl,
    mediaType: tweet.mediaType,
    quotedText: tweet.isQuoteTweet && tweet.quotedTweet
      ? `[Quote from @${tweet.quotedTweet.author}]: ${tweet.quotedTweet.text}`
      : undefined,
    timestamp: Date.now(),
  })));

  // Combine cached and new scores, applying whitelist to all
  const allScores: EngagementScore[] = [];
  for (const tweet of tweets) {
    const cachedScore = cached.get(tweet.id);
    if (cachedScore) {
      cachedScore.whitelisted = isWhitelisted(tweet.author, 'twitter', settings.whitelist);
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === tweet.id);
      if (newScore) allScores.push(newScore);
    }
  }

  // Responses to bait count as bait: fold in the score of the quoted / replied-to
  // post. Runs over cached scores too, so replies scored before their anchor was
  // known (or before this feature) get updated.
  if (apiEnabled) {
    const changed = await applyAnchorScores(tweets, allScores);
    if (changed.length > 0) await cacheScores(changed);
  }

  const flooredCached: EngagementScore[] = [];
  // Final safety net: enforce video/gif score floor on ALL scores
  // This catches cached scores, race conditions, and any scoring path
  // that might have missed the floor
  for (const tweet of tweets) {
    if (tweet.mediaType === 'video' || tweet.mediaType === 'gif') {
      const score = allScores.find(s => s.postId === tweet.id);
      if (score && score.apiScore !== undefined && score.apiScore < TWITTER_VIDEO_SCORE_FLOOR) {
        log.debug(` Video floor applied: tweet ${tweet.id} score ${score.apiScore} -> ${TWITTER_VIDEO_SCORE_FLOOR}`);
        applyVideoFloor(score);
        flooredCached.push(score);
      }
    }
  }
  // Persist, so the cache matches what's shown (e.g. a GIF first scraped before it loaded)
  if (flooredCached.length > 0) await cacheScores(flooredCached);

  return allScores;
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
      score.scoreFailed = false;
      score.apiReason = apiResult.reason;
      score.bucket = scoreToBucket(apiScore);

      // Apply narrative detection from LLM response
      if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
        score.factors.narrative = {
          themeId: apiResult.narrativeMatches[0],
          confidence: 'high',
          matchedKeywords: [],
        };
        log.debug(` Set narrative on score for post ${post.id}: themeId=${score.factors.narrative.themeId}`);
      }

      // Log calibration data (with full post info for fine-tuning)
      await logCalibration(post.id, apiScore, {
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
      });

      log.debug(
        `Batch API enrichment for post=${post.id}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
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
      score.scoreFailed = false;
      score.apiReason = apiResult.reason;
      score.bucket = scoreToBucket(apiScore);

      // Apply narrative detection from LLM response
      if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
        score.factors.narrative = {
          themeId: apiResult.narrativeMatches[0],
          confidence: 'high',
          matchedKeywords: [],
        };
      }

      await logCalibration(post.id, apiScore, {
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
      });

      log.debug(
        `Batch API enrichment for post=${post.id}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
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
      score.scoreFailed = false;
      score.apiReason = apiResult.reason;
      score.bucket = scoreToBucket(apiScore);

      // Apply narrative detection from LLM response
      if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
        score.factors.narrative = {
          themeId: apiResult.narrativeMatches[0],
          confidence: 'high',
          matchedKeywords: [],
        };
      }

      // Log calibration data for analysis (with full post info for fine-tuning)
      await logCalibration(post.id, apiScore, {
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
      });

      log.debug(
        `API enrichment for post=${post.id}, api=${apiScore}, bucket=${score.bucket}, reason="${apiResult.reason}"`
      );
    }
  } catch (error) {
    console.error('API enrichment failed:', error);
  }
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
  // When API is enabled, only consider scores with apiScore as cached
  const cached = await getCachedScores(videoIds);
  const uncached = videos.filter(v => !cached.has(v.id));
  const t2 = performance.now();

  // Score uncached videos with heuristics
  const newScores: EngagementScore[] = [];

  // Collect videos for API scoring
  const videosForApi: { video: Omit<YouTubeVideo, 'element'>; score: EngagementScore }[] = [];

  // Pre-fetch subscription list if subscriptions-only mode is enabled
  const subsOnlyMode = settings.subscriptionsOnly ?? false;
  const subsList = subsOnlyMode ? await getSubscriptionList() : null;

  for (const video of uncached) {
    const score = createPendingScore(video.id);
    // Check pre-filter whitelist - trusted sources bypass blur but still get scored
    score.whitelisted = isWhitelisted(video.channel, 'youtube', settings.whitelist);

    // Subscriptions-only mode: mark subscribed sources as whitelisted
    if (subsOnlyMode && !score.whitelisted && subsList) {
      score.whitelisted = isSubscribed(video.channel, 'youtube', subsList);
    }

    newScores.push(score);

    // API-first: send ALL videos to API when configured
    if (apiEnabled) {
      videosForApi.push({ video, score });
    }
  }

  // Process API scoring for videos (BATCHED - single API call for all videos)
  if (videosForApi.length > 0) {
    log.debug(` Scoring ${videosForApi.length} videos via batched API`);

    // Build batch request
    const postsForBatch: PostForScoring[] = videosForApi.map(({ video }) => ({
      id: video.id,
      title: video.title,
      subreddit: video.channel || '@unknown', // Channel name in subreddit field
      score: null, // No score/likes visible before clicking
      numComments: 0, // No comments visible
      platform: 'twitter' as const, // Use Twitter format (@channel)
    }));

    try {
      const batchResults = await scoreTextPostsBatch(postsForBatch);

      // Apply results to scores
      for (const { video, score } of videosForApi) {
        const result = batchResults.get(video.id);
        if (result) {
          const apiScore = result.score * 10;
          score.apiScore = apiScore;
          score.scoreFailed = false;
          score.apiReason = result.reason;
          score.bucket = scoreToBucket(apiScore, 'youtube');
          recordNarrativeMatch(score, result.narrativeMatches);
        }
      }
    } catch (err) {
      console.error('Video batch API scoring failed:', err);
    }
  }
  const t3 = performance.now();

  log.debug(` Video scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  await applyCounterStrategies(newScores, 'youtube');

  // Cache new scores (only those with API scores when API is enabled)
  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Save post content for ML training data
  await savePostContent(uncached.map(video => ({
    postId: video.id,
    platform: 'youtube' as const,
    text: video.title,
    title: video.title,
    author: video.channel,
    thumbnailUrl: video.thumbnailUrl,
    timestamp: Date.now(),
  })));

  // Combine cached and new scores, applying whitelist to all
  const allScores: EngagementScore[] = [];
  for (const video of videos) {
    const cachedScore = cached.get(video.id);
    if (cachedScore) {
      cachedScore.whitelisted = isWhitelisted(video.channel, 'youtube', settings.whitelist);
      if (subsOnlyMode && !cachedScore.whitelisted && subsList) {
        cachedScore.whitelisted = isSubscribed(video.channel, 'youtube', subsList);
      }
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === video.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
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
  // When API is enabled, only consider scores with apiScore as cached
  const cached = await getCachedScores(postIds);
  const uncached = posts.filter(p => !cached.has(p.id));
  const t2 = performance.now();

  // Initialize scores for uncached posts
  const newScores: EngagementScore[] = [];

  // Collect posts for API scoring
  const postsForApi: { post: Omit<InstagramPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = createPendingScore(post.id);
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
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'instagram');

          // Apply narrative detection from LLM response
          if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
            score.factors.narrative = {
              themeId: apiResult.narrativeMatches[0],
              confidence: 'high',
              matchedKeywords: [],
            };
          }
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
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'instagram');

          // Apply narrative detection from LLM response
          if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
            score.factors.narrative = {
              themeId: apiResult.narrativeMatches[0],
              confidence: 'high',
              matchedKeywords: [],
            };
          }
        }
      } catch (err) {
        console.error('Instagram media API scoring failed:', err);
      }
    });
    await Promise.all(mediaPromises);
  }
  const t3 = performance.now();

  log.debug(` Instagram scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  await applyCounterStrategies(newScores, 'instagram');

  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Save post content for ML training data
  await savePostContent(uncached.map(post => ({
    postId: post.id,
    platform: 'instagram' as const,
    text: post.caption,
    author: post.authorUsername,
    imageUrl: post.imageUrl,
    thumbnailUrl: post.thumbnailUrl,
    mediaType: post.mediaType,
    timestamp: Date.now(),
  })));

  // Combine cached and new scores, applying whitelist to all
  const allScores: EngagementScore[] = [];
  for (const post of posts) {
    const cachedScore = cached.get(post.id);
    if (cachedScore) {
      cachedScore.whitelisted = isWhitelisted(post.author, 'instagram', settings.whitelist);
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === post.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}

// Score Facebook posts - adapts Facebook content to the scoring system
// Modeled on scoreInstagramPosts
export async function scoreFacebookPosts(
  posts: Omit<FacebookPost, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const postIds = posts.map(p => p.id);

  const apiEnabled = await isApiConfigured();
  const narrativeEnabled = settings.narrativeDetection?.enabled !== false;
  const themes = narrativeEnabled ? await getActiveThemes() : [];
  const t1 = performance.now();

  const cached = await getCachedScores(postIds);
  const uncached = posts.filter(p => !cached.has(p.id));
  const t2 = performance.now();

  const newScores: EngagementScore[] = [];
  const postsForApi: { post: Omit<FacebookPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = createPendingScore(post.id);
    // Whitelist uses display name for Facebook (no @handles)
    score.whitelisted = isWhitelisted(post.authorDisplayName, 'facebook', settings.whitelist);
    newScores.push(score);

    if (apiEnabled) {
      postsForApi.push({ post, score });
    } else {
      score.apiReason = 'Scoring failed: no API key configured';
    }
  }

  // Separate by type
  const textPosts: { post: Omit<FacebookPost, 'element'>; score: EngagementScore }[] = [];
  const mediaPosts: { post: Omit<FacebookPost, 'element'>; score: EngagementScore }[] = [];

  for (const item of postsForApi) {
    const hasMedia = item.post.mediaType === 'video' ||
                     item.post.mediaType === 'image' ||
                     item.post.mediaType === 'gallery';
    const hasImage = item.post.imageUrl || item.post.thumbnailUrl;

    if (hasMedia && hasImage) {
      mediaPosts.push(item);
    } else {
      textPosts.push(item);
    }
  }

  log.debug(` Scoring ${textPosts.length} text Facebook posts, ${mediaPosts.length} media posts via API`);

  // Process text posts
  if (textPosts.length > 0) {
    const textPromises = textPosts.map(async ({ post, score }) => {
      try {
        const apiResult = await scoreTextPost(
          post.caption || post.text,
          post.authorDisplayName,
          post.likeCount,
          post.commentCount
        );
        if (!apiResult) {
          score.apiReason = `Scoring failed: ${getLastCallError() ?? 'no response'}`;
        } else {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'facebook');

          if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
            score.factors.narrative = {
              themeId: apiResult.narrativeMatches[0],
              confidence: 'high',
              matchedKeywords: [],
            };
          }
        }
      } catch (err) {
        console.error('Facebook text API scoring failed:', err);
        score.apiReason = `Scoring failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    await Promise.all(textPromises);
  }

  // Process media posts
  if (mediaPosts.length > 0) {
    const mediaPromises = mediaPosts.map(async ({ post, score }) => {
      try {
        const content = post.caption || post.text;
        const isVideo = post.mediaType === 'video';

        let apiResult;
        if (isVideo) {
          const imageUrl = post.imageUrl || post.thumbnailUrl || '';
          apiResult = await scoreVideoPost(
            content,
            post.authorDisplayName,
            imageUrl,
            post.likeCount,
            post.commentCount,
            'facebook'
          );
        } else {
          const imageUrl = post.imageUrl || post.thumbnailUrl || '';
          apiResult = await scoreImagePost(
            content,
            post.authorDisplayName,
            imageUrl,
            post.likeCount,
            post.commentCount,
            post.id,
            undefined,
            'facebook'
          );
        }

        if (!apiResult) {
          score.apiReason = `Scoring failed: ${getLastCallError() ?? 'no response'}`;
        } else {
          const apiScore = apiResult.score * 10;
          score.apiScore = apiScore;
          score.scoreFailed = false;
          score.apiReason = apiResult.reason;
          score.bucket = scoreToBucket(apiScore, 'facebook');

          if (apiResult.narrativeMatches && apiResult.narrativeMatches.length > 0) {
            score.factors.narrative = {
              themeId: apiResult.narrativeMatches[0],
              confidence: 'high',
              matchedKeywords: [],
            };
          }
        }
      } catch (err) {
        console.error('Facebook media API scoring failed:', err);
        score.apiReason = `Scoring failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    await Promise.all(mediaPromises);
  }
  const t3 = performance.now();

  log.debug(` Facebook scoring timing - setup: ${(t1-t0).toFixed(0)}ms, cache: ${(t2-t1).toFixed(0)}ms, scoring: ${(t3-t2).toFixed(0)}ms, total: ${(t3-t0).toFixed(0)}ms (${uncached.length} uncached)`);

  await applyCounterStrategies(newScores, 'facebook');

  if (newScores.length > 0) {
    await cacheScores(newScores);
  }

  // Save post content for ML training data
  await savePostContent(uncached.map(post => ({
    postId: post.id,
    platform: 'facebook' as const,
    text: post.caption,
    author: post.authorDisplayName,
    imageUrl: post.imageUrl,
    thumbnailUrl: post.thumbnailUrl,
    mediaType: post.mediaType,
    timestamp: Date.now(),
  })));

  // Combine cached and new scores
  const allScores: EngagementScore[] = [];
  for (const post of posts) {
    const cachedScore = cached.get(post.id);
    if (cachedScore) {
      cachedScore.whitelisted = isWhitelisted(post.authorDisplayName, 'facebook', settings.whitelist);
      allScores.push(cachedScore);
    } else {
      const newScore = newScores.find(s => s.postId === post.id);
      if (newScore) allScores.push(newScore);
    }
  }

  return allScores;
}
