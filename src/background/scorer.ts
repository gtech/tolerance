import { log } from '../shared/constants';
import {
  RedditPost,
  Tweet,
  YouTubeVideo,
  EngagementScore,
  ScoreFactors,
  NarrativeDetection,
  NarrativeTheme,
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
import { scoreTextPost, scoreImagePost, scoreVideoPost, scoreTextPostsBatch, scoreTextPostsBatchWithGalleries, PostForScoring, ScoreResponse, fetchGalleryImages, describeImages } from './openrouter';
import { trackUnclassifiedPost } from './themeDiscovery';

// Main scoring function - API-first approach
export async function scorePosts(
  posts: Omit<RedditPost, 'element'>[]
): Promise<EngagementScore[]> {
  const t0 = performance.now();
  const settings = await getSettings();
  const postIds = posts.map(p => p.id);

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

  // Score uncached posts with heuristics
  const newScores: EngagementScore[] = [];
  const scoreMap = new Map<string, EngagementScore>();

  // Separate posts by type for efficient API batching
  const textPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];
  const mediaPostsForApi: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[] = [];

  for (const post of uncached) {
    const score = calculateHeuristicScore(post, themes);
    newScores.push(score);
    scoreMap.set(post.id, score);

    // API-first: send ALL posts to API when key is configured
    // Heuristic is only used as fallback when no API key
    if (settings.openRouterApiKey) {
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

  // Step 1: Fetch all gallery images in parallel
  const galleryImagesMap = new Map<string, string[]>();
  if (galleries.length > 0) {
    const galleryFetches = galleries.map(async ({ post }) => {
      const images = await fetchGalleryImages(post.id);
      return { postId: post.id, images };
    });
    const galleryResults = await Promise.all(galleryFetches);
    for (const { postId, images } of galleryResults) {
      galleryImagesMap.set(postId, images);
    }
    log.debug(` Fetched gallery images for ${galleryResults.length} galleries`);
  }

  // Step 2: Get all image descriptions in parallel
  const galleryDescriptions = new Map<string, string>();
  if (galleries.length > 0) {
    const descriptionPromises = galleries.map(async ({ post }) => {
      const images = galleryImagesMap.get(post.id) || [];
      if (images.length > 1) {
        const description = await describeImages(settings.openRouterApiKey!, images);
        return { postId: post.id, description };
      }
      return { postId: post.id, description: '' };
    });
    const descResults = await Promise.all(descriptionPromises);
    for (const { postId, description } of descResults) {
      if (description) {
        galleryDescriptions.set(postId, description);
      }
    }
    log.debug(` Got descriptions for ${galleryDescriptions.size} galleries`);
  }

  // Step 3: Batch all text scoring (text posts + galleries with descriptions)
  const allTextForBatch: { post: Omit<RedditPost, 'element'>; score: EngagementScore; galleryDescription?: string }[] = [
    ...textPostsForApi,
    ...galleries.map(g => ({
      ...g,
      galleryDescription: galleryDescriptions.get(g.post.id),
    })),
  ];

  if (allTextForBatch.length > 0) {
    await enrichTextPostsBatchWithGalleries(allTextForBatch, settings.openRouterApiKey!).catch(err => {
      console.error('Batch API enrichment failed:', err);
    });
  }

  // Step 4: Score single images/videos in parallel
  if (singleMedia.length > 0) {
    const mediaPromises = singleMedia.map(({ post, score }) =>
      enrichWithApiScore(post, score, settings.openRouterApiKey!).catch(err => {
        console.error('API enrichment failed:', err);
      })
    );
    await Promise.all(mediaPromises);
  }
  const t4 = performance.now();

  const totalApiCalls = allTextForBatch.length > 0 ? 1 : 0 + singleMedia.length + galleries.length;
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
    newScores.push(score);

    // API-first: send ALL tweets to API when key is configured
    if (settings.openRouterApiKey) {
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

// Heuristic scoring for tweets
function calculateTweetHeuristicScore(
  tweet: Omit<Tweet, 'element'>,
  themes: NarrativeTheme[]
): EngagementScore {
  const factors: ScoreFactors = {
    engagementRatio: 0,
    commentDensity: tweet.likeCount > 0 ? tweet.numComments / tweet.likeCount : 0,
    keywordFlags: [],
    viralVelocity: 0,
  };

  let score = 30;
  let confidencePoints = 0;

  // Title pattern heuristics (use tweet text)
  const titlePatternScore = analyzeTitlePatterns(tweet.text, tweet.likeCount);
  score += titlePatternScore.points;
  confidencePoints += titlePatternScore.confidence;
  factors.keywordFlags.push(...titlePatternScore.flags);

  // Engagement ratio for tweets: reply ratio relative to likes
  // High replies relative to likes = controversial
  if (tweet.likeCount > 0) {
    const replyRatio = tweet.numComments / tweet.likeCount;
    if (replyRatio > 0.5) score += 15; // Highly controversial
    else if (replyRatio > 0.2) score += 8;
    confidencePoints += 1;

    // Retweet ratio - high RT ratio = viral/shareable
    const rtRatio = tweet.retweetCount / tweet.likeCount;
    if (rtRatio > 0.3) {
      score += 10;
      factors.keywordFlags.push('twitter:high_rt_ratio');
    }
  }

  // Keyword detection
  const textLower = tweet.text.toLowerCase();

  // Outrage keywords
  const outrageMatches = OUTRAGE_KEYWORDS.filter(kw => textLower.includes(kw));
  score += Math.min(outrageMatches.length * 8, 20);
  factors.keywordFlags.push(...outrageMatches.map(k => `outrage:${k}`));
  if (outrageMatches.length > 0) confidencePoints += 2;

  // Curiosity gap keywords
  const curiosityMatches = CURIOSITY_GAP_KEYWORDS.filter(kw => textLower.includes(kw));
  score += Math.min(curiosityMatches.length * 6, 15);
  factors.keywordFlags.push(...curiosityMatches.map(k => `curiosity:${k}`));
  if (curiosityMatches.length > 0) confidencePoints += 2;

  // Tribal keywords
  const tribalMatches = TRIBAL_KEYWORDS.filter(kw => textLower.includes(kw));
  score += Math.min(tribalMatches.length * 7, 15);
  factors.keywordFlags.push(...tribalMatches.map(k => `tribal:${k}`));
  if (tribalMatches.length > 0) confidencePoints += 1;

  // Twitter-specific signals
  if (tweet.isRetweet) {
    score += 5; // Retweets are often engagement-optimized
    factors.keywordFlags.push('twitter:retweet');
  }

  if (tweet.isQuoteTweet) {
    score += 8; // Quote tweets often add commentary/opinion
    factors.keywordFlags.push('twitter:quote_tweet');
  }

  if (tweet.isThread) {
    score += 5; // Threads are designed for engagement
    factors.keywordFlags.push('twitter:thread');
  }

  // Verified accounts often post more engagement-optimized content
  if (tweet.isVerified) {
    score += 3;
    factors.keywordFlags.push('twitter:verified');
  }

  // Hashtag density - many hashtags = engagement farming
  if (tweet.hashtags.length >= 3) {
    score += 8;
    factors.keywordFlags.push('twitter:hashtag_heavy');
  }

  // Viral velocity for tweets
  const ageHours = (Date.now() / 1000 - tweet.createdUtc) / 3600;
  if (ageHours > 0 && ageHours < 24) {
    const velocity = tweet.likeCount / ageHours;
    factors.viralVelocity = velocity;

    if (velocity > 1000) score += 15;
    else if (velocity > 300) score += 10;
    else if (velocity > 100) score += 5;

    confidencePoints += 1;
  }

  // Media type adjustment
  if (tweet.mediaType === 'image' || tweet.mediaType === 'video') {
    score += 5;
  }

  // View count analysis (if available)
  if (tweet.viewCount && tweet.likeCount > 0) {
    const engagementRate = tweet.likeCount / tweet.viewCount;
    if (engagementRate > 0.05) {
      score += 5; // Highly engaging content
      factors.keywordFlags.push('twitter:high_engagement_rate');
    }
  }

  // Narrative theme detection
  if (themes.length > 0) {
    const narrative = detectNarrative(tweet.text, themes);
    if (narrative) {
      factors.narrative = narrative;
      if (narrative.confidence === 'high') score += 10;
      else if (narrative.confidence === 'medium') score += 5;
      confidencePoints += 1;

      factors.keywordFlags.push(
        ...narrative.matchedKeywords.map(k => `narrative:${narrative.themeId}:${k}`)
      );
    } else {
      trackUnclassifiedPost(tweet.id, tweet.text);
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine confidence
  let confidence: 'low' | 'medium' | 'high';
  if (confidencePoints >= 5) confidence = 'high';
  else if (confidencePoints >= 3) confidence = 'medium';
  else confidence = 'low';

  return {
    postId: tweet.id,
    heuristicScore: score,
    heuristicConfidence: confidence,
    bucket: scoreToBucket(score, 'twitter'),
    factors,
    timestamp: Date.now(),
  };
}

// Batch enrich text posts with API scores
async function enrichTextPostsBatch(
  posts: { post: Omit<RedditPost, 'element'>; score: EngagementScore }[],
  apiKey: string
): Promise<void> {
  const postsForScoring: PostForScoring[] = posts.map(({ post }) => ({
    id: post.id,
    title: post.title,
    subreddit: post.subreddit,
    score: post.score,
    numComments: post.numComments,
  }));

  const results = await scoreTextPostsBatch(postsForScoring, apiKey);

  // Apply results to scores
  for (const { post, score } of posts) {
    const apiResult = results.get(post.id);
    if (apiResult) {
      const apiScore = apiResult.score * 10; // Normalize 1-10 to 0-100
      score.apiScore = apiScore;
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
  posts: { post: Omit<RedditPost, 'element'>; score: EngagementScore; galleryDescription?: string }[],
  apiKey: string
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

  const results = await scoreTextPostsBatchWithGalleries(postsForScoring, apiKey);

  // Apply results to scores
  for (const { post, score } of posts) {
    const apiResult = results.get(post.id);
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
  score: EngagementScore,
  apiKey: string
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
        post.numComments,
        apiKey
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
        post.id, // Pass postId for gallery image fetching
        undefined, // bodyText
        apiKey
      );
    } else {
      // Text/link posts use text model
      apiResult = await scoreTextPost(
        post.title,
        post.subreddit,
        post.score,
        post.numComments,
        apiKey
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

// Heuristic scoring - runs locally, instant
function calculateHeuristicScore(
  post: Omit<RedditPost, 'element'>,
  themes: NarrativeTheme[]
): EngagementScore {
  const factors = calculateFactors(post);
  // Start with baseline score - most content has some engagement optimization
  let score = 30;
  let confidencePoints = 0;

  // Title pattern heuristics
  const titlePatternScore = analyzeTitlePatterns(post.title, post.score);
  score += titlePatternScore.points;
  confidencePoints += titlePatternScore.confidence;
  factors.keywordFlags.push(...titlePatternScore.flags);

  // Engagement ratio factor (0-20 points)
  // High ratio with lots of votes = confirmed good content
  // Low ratio = controversial
  if (post.upvoteRatio !== undefined) {
    if (post.upvoteRatio < 0.7) {
      score += 15; // Controversial
    } else if (post.upvoteRatio > 0.95) {
      score += 5; // Universally liked, less manipulative
    }
    confidencePoints += 2;
  }

  // Comment density (0-15 points)
  // High comments relative to score = engaging/argumentative
  if (post.score > 0) {
    const density = post.numComments / post.score;
    if (density > 0.5) score += 15;
    else if (density > 0.2) score += 8;
    confidencePoints += 1;
  }

  // Keyword detection (0-30 points)
  const titleLower = post.title.toLowerCase();

  // Outrage keywords
  const outrageMatches = OUTRAGE_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(outrageMatches.length * 8, 20);
  factors.keywordFlags.push(...outrageMatches.map(k => `outrage:${k}`));
  if (outrageMatches.length > 0) confidencePoints += 2;

  // Curiosity gap keywords
  const curiosityMatches = CURIOSITY_GAP_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(curiosityMatches.length * 6, 15);
  factors.keywordFlags.push(...curiosityMatches.map(k => `curiosity:${k}`));
  if (curiosityMatches.length > 0) confidencePoints += 2;

  // Tribal keywords
  const tribalMatches = TRIBAL_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(tribalMatches.length * 7, 15);
  factors.keywordFlags.push(...tribalMatches.map(k => `tribal:${k}`));
  if (tribalMatches.length > 0) confidencePoints += 1;

  // Subreddit category (0-20 points)
  const subredditLower = post.subreddit.toLowerCase();
  const category = SUBREDDIT_CATEGORIES[subredditLower];
  factors.subredditCategory = category;

  if (category === 'outrage') score += 20;
  else if (category === 'drama') score += 15;
  else if (category === 'political') score += 15;
  else if (category === 'news') score += 10;
  else if (category === 'educational') score += 0;
  else if (category === 'wholesome') score -= 5;

  if (category) confidencePoints += 1;

  // Viral velocity (0-15 points)
  // High score in short time = viral, likely manipulative
  const ageHours = (Date.now() / 1000 - post.createdUtc) / 3600;
  if (ageHours > 0 && ageHours < 24) {
    const velocity = post.score / ageHours;
    factors.viralVelocity = velocity;

    if (velocity > 500) score += 15;
    else if (velocity > 200) score += 10;
    else if (velocity > 50) score += 5;

    confidencePoints += 1;
  }

  // Media type adjustment
  if (post.mediaType === 'image' || post.mediaType === 'video') {
    score += 5; // Visual content tends to be more engaging/less informative
  }

  // Narrative theme detection
  if (themes.length > 0) {
    const narrative = detectNarrative(post.title, themes);
    if (narrative) {
      factors.narrative = narrative;
      // Narrative themes also contribute to engagement score
      if (narrative.confidence === 'high') score += 10;
      else if (narrative.confidence === 'medium') score += 5;
      confidencePoints += 1;

      factors.keywordFlags.push(
        ...narrative.matchedKeywords.map(k => `narrative:${narrative.themeId}:${k}`)
      );
      log.debug(` Narrative detected - ${narrative.themeId} (${narrative.confidence}) for "${post.title.slice(0, 50)}..."`);
    } else {
      // Track unclassified posts for theme discovery
      trackUnclassifiedPost(post.id, post.title);
    }
  } else {
    log.debug('Tolerance: No active themes for narrative detection');
  }

  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine confidence
  let confidence: 'low' | 'medium' | 'high';
  if (confidencePoints >= 5) confidence = 'high';
  else if (confidencePoints >= 3) confidence = 'medium';
  else confidence = 'low';

  return {
    postId: post.id,
    heuristicScore: score,
    heuristicConfidence: confidence,
    bucket: scoreToBucket(score),
    factors,
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
    newScores.push(score);

    // API-first: send ALL videos to API when key is configured
    if (settings.openRouterApiKey) {
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

// Heuristic scoring for YouTube videos
function calculateVideoHeuristicScore(
  video: Omit<YouTubeVideo, 'element'>,
  themes: NarrativeTheme[]
): EngagementScore {
  const factors: ScoreFactors = {
    engagementRatio: 0,
    commentDensity: 0,
    keywordFlags: [],
    viralVelocity: 0,
  };

  let score = 30;
  let confidencePoints = 0;

  // Title pattern heuristics
  const titlePatternScore = analyzeTitlePatterns(video.title, video.viewCount || 0);
  score += titlePatternScore.points;
  confidencePoints += titlePatternScore.confidence;
  factors.keywordFlags.push(...titlePatternScore.flags);

  // Keyword detection in title
  const titleLower = video.title.toLowerCase();

  // Outrage keywords
  const outrageMatches = OUTRAGE_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(outrageMatches.length * 8, 20);
  factors.keywordFlags.push(...outrageMatches.map(k => `outrage:${k}`));
  if (outrageMatches.length > 0) confidencePoints += 2;

  // Curiosity gap keywords (very common in YouTube clickbait)
  const curiosityMatches = CURIOSITY_GAP_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(curiosityMatches.length * 8, 20); // Higher weight for YouTube
  factors.keywordFlags.push(...curiosityMatches.map(k => `curiosity:${k}`));
  if (curiosityMatches.length > 0) confidencePoints += 2;

  // Tribal keywords
  const tribalMatches = TRIBAL_KEYWORDS.filter(kw => titleLower.includes(kw));
  score += Math.min(tribalMatches.length * 7, 15);
  factors.keywordFlags.push(...tribalMatches.map(k => `tribal:${k}`));
  if (tribalMatches.length > 0) confidencePoints += 1;

  // YouTube-specific clickbait patterns
  const youtubeClickbait = [
    /\b(gone wrong|gone sexual|not clickbait|watch till end)\b/i,
    /\b(exposed|leaked|secrets?|truth about)\b/i,
    /\b(you won'?t believe|what happens next|shocking)\b/i,
    /\b(\d+\s*(reasons?|ways?|things?|secrets?|hacks?|tricks?))\b/i,
    /\b(challenge|prank|reaction|mukbang)\b/i,
    /\b(tier list|ranking|rating)\b/i,
    /^[A-Z\s!?]+$/, // ALL CAPS TITLES
  ];

  for (const pattern of youtubeClickbait) {
    if (pattern.test(video.title)) {
      score += 8;
      factors.keywordFlags.push('youtube:clickbait_pattern');
      confidencePoints += 1;
      break;
    }
  }

  // Shorts are often more engagement-optimized
  if (video.isShort) {
    score += 5;
    factors.keywordFlags.push('youtube:short');
  }

  // Very high view counts suggest viral/engagement-optimized content
  if (video.viewCount) {
    if (video.viewCount > 10000000) score += 10;
    else if (video.viewCount > 1000000) score += 5;
    else if (video.viewCount > 100000) score += 3;
    confidencePoints += 1;
  }

  // Narrative theme detection
  if (themes.length > 0) {
    const narrative = detectNarrative(video.title, themes);
    if (narrative) {
      factors.narrative = narrative;
      if (narrative.confidence === 'high') score += 10;
      else if (narrative.confidence === 'medium') score += 5;
      confidencePoints += 1;

      factors.keywordFlags.push(
        ...narrative.matchedKeywords.map(k => `narrative:${narrative.themeId}:${k}`)
      );
    } else {
      trackUnclassifiedPost(video.id, video.title);
    }
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine confidence
  let confidence: 'low' | 'medium' | 'high';
  if (confidencePoints >= 5) confidence = 'high';
  else if (confidencePoints >= 3) confidence = 'medium';
  else confidence = 'low';

  return {
    postId: video.id,
    heuristicScore: score,
    heuristicConfidence: confidence,
    bucket: scoreToBucket(score, 'youtube'),
    factors,
    timestamp: Date.now(),
  };
}
