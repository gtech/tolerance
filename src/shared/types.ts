// Core types for Tolerance

// ==========================================
// Narrative Awareness Types
// ==========================================

// Dynamic theme - can be seed (predefined) or user-discovered
export interface NarrativeTheme {
  id: string;              // 'doom', 'conspiracy', 'identity', or user-generated ID
  name: string;            // Display name
  description: string;     // What this narrative looks like
  keywords: string[];      // Detection keywords (can grow)
  isSystemTheme: boolean;  // true for seed themes, false for discovered
  active: boolean;         // Whether to detect this theme
  discoveredAt?: number;   // When this theme was first detected
  exampleTitles?: string[]; // Example posts that match
}

// Detection result for a single post
export interface NarrativeDetection {
  themeId: string;         // References NarrativeTheme.id
  confidence: 'low' | 'medium' | 'high';
  matchedKeywords: string[];
}

// Discovered but unconfirmed narrative cluster
export interface EmergingNarrative {
  id: string;
  suggestedName: string;      // LLM-generated name
  description: string;        // LLM-generated description
  sampleTitles: string[];     // 5-10 example titles
  firstSeen: number;
  postCount: number;          // How many posts match
  status: 'pending' | 'confirmed' | 'dismissed';
}

// Daily aggregated stats for narrative exposure
export interface DailyNarrativeStats {
  date: string;  // YYYY-MM-DD
  themeCounts: Record<string, number>;  // Theme ID → count
  totalPosts: number;
  exposure: Record<string, number>;     // Theme ID → percentage (0-100)
  baselineAvg?: Record<string, number>; // 7-day rolling average
}

// User-defined counter-strategy (dialectical approach)
export interface CounterStrategy {
  id: string;
  themeId: string;           // References NarrativeTheme.id
  thesis: string;            // The detected narrative (auto-filled from theme description)
  antithesis: string;        // User-defined direct opposite
  synthesis: string;         // User-defined nuanced counter
  suppressThreshold: number; // 0-100 (0 = no suppression)
  surfaceKeywords: string[]; // Keywords for counter-content to boost
  enabled: boolean;
  createdAt: number;
  notes?: string;            // User's reasoning/brainstorming
}

// ==========================================
// Core Social Media Types
// ==========================================

// Base interface for any social media post (Reddit, Twitter, YouTube, Instagram, etc.)
export interface SocialPost {
  id: string;
  platform: 'reddit' | 'twitter' | 'youtube' | 'instagram';
  author: string;
  text: string;              // Post content (title for Reddit, tweet text for Twitter, caption for Instagram)
  score: number | null;      // Likes/upvotes
  numComments: number;       // Comments/replies
  mediaType: 'text' | 'image' | 'video' | 'link' | 'gallery' | 'gif' | 'reel';
  permalink: string;
  createdUtc: number;
  thumbnailUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  element: HTMLElement;      // Reference to DOM element (not serialized)
}

// ==========================================
// Reddit Types
// ==========================================

export interface RedditPost extends SocialPost {
  platform: 'reddit';
  title: string;             // Reddit has separate title
  subreddit: string;
  upvoteRatio?: number;
  flair?: string;
  isNsfw: boolean;
  domain: string;
}

// ==========================================
// Twitter Types
// ==========================================

export interface Tweet extends SocialPost {
  platform: 'twitter';
  // Engagement metrics
  retweetCount: number;
  quoteCount: number;
  likeCount: number;         // Same as score, but explicit
  viewCount?: number;        // Twitter shows views
  bookmarkCount?: number;
  // Tweet metadata
  isRetweet: boolean;
  isQuoteTweet: boolean;
  isReply: boolean;
  isThread: boolean;         // Part of a thread
  retweetedBy?: string;      // If RT, who retweeted
  quotedTweet?: {            // If quote tweet, the quoted content
    author: string;
    text: string;
    imageUrl?: string;        // Image in quoted tweet (if any)
  };
  replyToAuthor?: string;    // If reply, who they're replying to
  // Content
  hashtags: string[];
  mentions: string[];
  urls: string[];            // Expanded URLs in tweet
  isVerified: boolean;       // Blue check / verified
  followerCount?: number;    // Author's followers (if available)
}

// ==========================================
// YouTube Types
// ==========================================

export interface YouTubeVideo {
  id: string;                    // Video ID from URL (e.g., "dQw4w9WgXcQ")
  platform: 'youtube';
  title: string;                 // Video title
  channel: string;               // Channel name
  viewCount: number;             // Parsed from "1.2M views"
  uploadDate?: string;           // "2 days ago", "3 months ago"
  duration?: string;             // "12:34" format
  thumbnailUrl?: string;
  isShort?: boolean;             // YouTube Shorts
  isLive?: boolean;              // Live stream
  element: HTMLElement;          // Reference to DOM element
}

// ==========================================
// Instagram Types
// ==========================================

export interface InstagramPost extends SocialPost {
  platform: 'instagram';
  caption: string;               // Post caption (same as text, explicit for clarity)
  likeCount: number | null;      // Number of likes (may be hidden)
  commentCount: number;          // Number of comments
  isReel: boolean;               // Is this a Reel (video in feed)
  isCarousel: boolean;           // Multiple images/videos
  carouselCount?: number;        // Number of items in carousel
  authorUsername: string;        // @username
  authorProfilePic?: string;     // Profile picture URL
  isSponsored?: boolean;         // Paid partnership / ad
  hasAudio?: boolean;            // For reels - has audio
}

export interface EngagementScore {
  postId: string;
  heuristicScore: number; // 0-100
  heuristicConfidence: 'low' | 'medium' | 'high';
  apiScore?: number; // 0-100, from OpenRouter when called
  apiReason?: string; // Reason from API for the score
  bucket: 'low' | 'medium' | 'high';
  factors: ScoreFactors;
  timestamp: number;
}

export interface ScoreFactors {
  engagementRatio: number;
  commentDensity: number;
  keywordFlags: string[];
  subredditCategory?: string;
  viralVelocity: number;
  narrative?: NarrativeDetection;  // Detected narrative theme
}

export interface PostImpression {
  timestamp: number;
  postId: string;
  score: number;
  bucket: 'low' | 'medium' | 'high';
  position: number;
  originalPosition: number;
  subreddit: string;
  wasReordered: boolean;
  narrativeThemeId?: string;  // Detected narrative theme ID (if any)
}

export interface SessionLog {
  sessionId: string;
  startTime: number;
  endTime?: number;
  posts: PostImpression[];
  engagementDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  mode: 'baseline' | 'active';
}

export interface AppState {
  mode: 'baseline' | 'active';
  baselineStartDate: number;
  baselineDurationDays: number;
  currentSessionId: string | null;
  sessionTabId: number | null; // Track which tab owns the session
}

export interface SchedulerConfig {
  highEngagementRatio: number; // e.g., 0.2 = 1 in 5 posts can be high
  cooldownPosts: number; // min posts between high-engagement
  enabled: boolean;
  // Progressive boredom (tracks ALL social media time)
  progressiveBoredomEnabled: boolean;
  phaseThresholds: {
    normal: number;      // minutes before reduction (default 30)
    reduced: number;     // minutes before wind-down (default 60)
    windDown: number;    // minutes before minimal (default 90)
  };
  phaseRatios: {
    normal: number;      // default 0.2
    reduced: number;     // default 0.1
    windDown: number;    // default 0.05
    minimal: number;     // default 0
  };
}

// Global session tracking across all social media platforms
export interface GlobalSession {
  startTimestamp: number;        // When this daily session started
  totalMinutes: number;          // Cumulative minutes across all platforms
  lastHeartbeat: number;         // Last activity timestamp
  resetDate: string;             // YYYY-MM-DD - resets when this changes
  maxPhaseReached: 'normal' | 'reduced' | 'wind-down' | 'minimal';  // Highest phase reached today
}

// ==========================================
// Adaptive Calibration Types
// ==========================================

// Daily feedback from user about their experience
export interface CalibrationFeedback {
  date: string;                  // YYYY-MM-DD
  sessionMinutes: number;        // How long they browsed that day
  maxPhase: 'normal' | 'reduced' | 'wind-down' | 'minimal';
  response: 'restricted' | 'balanced' | 'too_easy';
  timestamp: number;             // When feedback was given
}

// Adaptive settings that adjust based on user feedback
export interface AdaptiveSettings {
  // Blur threshold offset: negative = more aggressive (lower threshold), positive = gentler
  // Range: -20 to +20, applied to base thresholds
  blurThresholdOffset: number;

  // Phase speed multiplier: <1 = slower progression, >1 = faster
  // Range: 0.5 to 2.0
  phaseSpeedMultiplier: number;

  // Track calibration history
  feedbackHistory: CalibrationFeedback[];
  lastFeedbackDate: string | null;  // YYYY-MM-DD of last feedback

  // Running adjustment (smoothed over time)
  adjustmentVelocity: number;  // How fast we're currently adjusting (-1 to +1)
}

export const DEFAULT_ADAPTIVE_SETTINGS: AdaptiveSettings = {
  blurThresholdOffset: 0,
  phaseSpeedMultiplier: 1.0,
  feedbackHistory: [],
  lastFeedbackDate: null,
  adjustmentVelocity: 0,
};

// Log level for console output
export type LogLevel = 'off' | 'error' | 'warn' | 'info' | 'debug';

// API Provider configuration for custom endpoints
export interface ApiProviderConfig {
  type: 'openrouter' | 'openai-compatible';
  endpoint?: string;           // Custom endpoint URL (for openai-compatible)
  textModel?: string;          // Override default text model
  imageModel?: string;         // Override default vision model
  visionMode?: 'auto' | 'enabled' | 'disabled';  // Vision capability
  trackCosts?: boolean;        // Track API costs (default true for OpenRouter)
}

export interface Settings {
  scheduler: SchedulerConfig;
  openRouterApiKey?: string;
  apiProvider?: ApiProviderConfig;  // Custom API endpoint configuration
  apiSampleRate: number; // e.g., 0.1 = 10% of posts validated via API
  // Quality Mode - blur everything above 20 (show only genuine content)
  qualityMode?: boolean;
  // Logging level for console output
  logLevel?: LogLevel;
  // Platform toggles - enable/disable Tolerance on each platform
  platforms: {
    reddit: boolean;
    twitter: boolean;
    youtube: boolean;
    instagram: boolean;
  };
  // Productivity card settings
  productivityCardEnabled?: boolean;  // Show productivity card in Reddit feed (default: false)
  rescueTimeApiKey?: string;
  obsidianUrl?: string;        // Full obsidian:// URL to current article
  jobSearchLink?: string;      // Link to job search (default: LinkedIn)
  codingProjectLink?: string;  // Link to current project (optional)
  todoistUrl?: string;         // Link to Todoist (default: today view)
  // Narrative awareness settings
  narrativeDetection: {
    enabled: boolean;
    apiValidationRate: number;  // Sample rate for API validation of themes
    discoveryEnabled: boolean;  // Whether to run theme discovery
    discoveryThreshold: number; // Min unclassified posts before discovery runs
  };
  // Telemetry settings (opt-in only)
  telemetry?: {
    enabled: boolean;          // Default false - must be explicitly enabled
    endpoint?: string;         // Future: community-archive.org integration
    anonymizeSubreddits?: boolean; // Hash subreddit names for privacy
  };
  // Calibration data settings
  calibration?: {
    storeApiReason: boolean;   // Store API reason text (can get heavy)
    maxEntries?: number;       // Max calibration entries to keep (0 = unlimited)
  };
  // Twitter-specific settings (also applies to YouTube)
  twitter?: {
    reorderEnabled: boolean;       // Whether to reorder tweets (default: false)
    blurHighEngagement: boolean;   // Blur high-engagement content (default: true)
    blurIntensity: number;         // Blur amount in pixels (default: 8)
    hoverRevealDelay: number;      // Seconds to hover before revealing (default: 3)
  };
  // Custom threshold overrides (user-adjustable, resets to calibrated defaults)
  customThresholds?: {
    // Blur thresholds per phase (score at which content gets blurred)
    blurThresholds: {
      normal: number;      // Default: 100 (no blur)
      reduced: number;     // Default: 55
      windDown: number;    // Default: 45
      minimal: number;     // Default: 30
    };
    // Phase timing (minutes before transitioning)
    phaseTiming: {
      normal: number;      // Default: 15 (minutes before reduced)
      reduced: number;     // Default: 45 (minutes before wind-down)
      windDown: number;    // Default: 75 (minutes before minimal)
    };
    // Whether custom values are active (vs using calibrated defaults)
    enabled: boolean;
  };
}

// Telemetry payload for future central server/decentralized network
export interface TelemetryPayload {
  postHash: string;          // SHA256 of title (not raw content)
  heuristicScore: number;
  apiScore?: number;
  delta?: number;            // Difference between heuristic and API
  narrativeThemes: string[]; // Theme IDs detected
  subreddit: string;         // Plain or hashed depending on settings
  timestamp: number;
  extensionVersion: string;
}

export interface ProductivityStats {
  writing: number;      // minutes today
  jobSearch: number;    // minutes today
  coding: number;       // minutes today
  lastUpdated: number;  // timestamp
}

// Message types for content <-> background communication
export type MessageType =
  | { type: 'SCORE_POSTS'; posts: Omit<RedditPost, 'element'>[] }
  | { type: 'SCORE_TWEETS'; tweets: Omit<Tweet, 'element'>[] }
  | { type: 'SCORE_VIDEOS'; videos: Omit<YouTubeVideo, 'element'>[] }
  | { type: 'SCORE_INSTAGRAM_POSTS'; posts: Omit<InstagramPost, 'element'>[] }
  | { type: 'SCORES_RESULT'; scores: EngagementScore[] }
  | { type: 'LOG_IMPRESSIONS'; impressions: PostImpression[] }
  | { type: 'GET_STATE' }
  | { type: 'STATE_RESULT'; state: AppState; settings: Settings }
  | { type: 'GET_SCHEDULER_ORDER'; postIds: string[]; scores: EngagementScore[] }
  | { type: 'SCHEDULER_ORDER_RESULT'; orderedIds: string[] }
  | { type: 'ENSURE_SESSION' }
  | { type: 'GET_API_USAGE' }
  | { type: 'RESET_API_USAGE' }
  | { type: 'CLEAR_SCORE_CACHE' }
  | { type: 'GET_DASHBOARD_DATA' }
  | { type: 'GET_PRODUCTIVITY' }
  | { type: 'GET_CARD_DATA' } // Combined data for reminder card
  // Narrative awareness messages
  | { type: 'GET_NARRATIVE_TRENDS'; days: number }
  | { type: 'GET_NARRATIVE_THEMES' }
  | { type: 'UPDATE_NARRATIVE_THEME'; theme: NarrativeTheme }
  | { type: 'GET_EMERGING_NARRATIVES' }
  | { type: 'CONFIRM_EMERGING_NARRATIVE'; id: string; name?: string }
  | { type: 'DISMISS_EMERGING_NARRATIVE'; id: string }
  | { type: 'TRIGGER_NARRATIVE_DISCOVERY' }
  | { type: 'GET_COUNTER_STRATEGIES' }
  | { type: 'SAVE_COUNTER_STRATEGY'; strategy: CounterStrategy }
  | { type: 'DELETE_COUNTER_STRATEGY'; strategyId: string }
  // Calibration stats
  | { type: 'GET_CALIBRATION_STATS'; period?: '24h' | '7d' | 'all' }
  // Global session (cross-platform tracking)
  | { type: 'GET_GLOBAL_SESSION' }
  // Adaptive calibration
  | { type: 'GET_ADAPTIVE_SETTINGS' }
  | { type: 'SUBMIT_CALIBRATION_FEEDBACK'; response: 'restricted' | 'balanced' | 'too_easy' }
  | { type: 'GET_FEEDBACK_PROMPT_STATUS' }  // Check if we should show feedback prompt
  | { type: 'GET_EFFECTIVE_BLUR_THRESHOLD'; phase: 'normal' | 'reduced' | 'wind-down' | 'minimal' };

export const DEFAULT_SETTINGS: Settings = {
  scheduler: {
    highEngagementRatio: 0.33,  // Match Reddit's ~2:1 medium:high ratio
    cooldownPosts: 3,
    enabled: true,
    progressiveBoredomEnabled: true,
    phaseThresholds: {
      normal: 15,    // First 15 min: baseline (no blur on Twitter/YouTube)
      reduced: 45,   // 15-45 min: reduced (high-engagement blurred)
      windDown: 75,  // 45-75 min: wind down, then minimal (score >= 30 blurred)
    },
    phaseRatios: {
      normal: 0.33,  // 1 in 3 posts (2:1 ratio, matches Reddit)
      reduced: 0.2,  // 1 in 5 posts (4:1 ratio)
      windDown: 0.1, // 1 in 10 posts (9:1 ratio)
      minimal: 0,    // No high-engagement posts
    },
  },
  apiSampleRate: 0.1,
  platforms: {
    reddit: true,
    twitter: true,
    youtube: true,
    instagram: true,
  },
  narrativeDetection: {
    enabled: true,
    apiValidationRate: 0.1,
    discoveryEnabled: true,
    discoveryThreshold: 50,  // Run discovery after 50 unclassified posts
  },
  telemetry: {
    enabled: false,  // Opt-in only - default off
    anonymizeSubreddits: true,  // Privacy by default
  },
  calibration: {
    storeApiReason: true,  // Store by default, user can disable
    maxEntries: 500,       // Keep last 500 entries by default
  },
  twitter: {
    reorderEnabled: false,      // Disabled by default - Twitter's virtual scroll makes reordering janky
    blurHighEngagement: true,   // Blur high-engagement content instead
    blurIntensity: 8,           // 8px blur
    hoverRevealDelay: 3,        // 3 seconds to hover before revealing
  },
};

export const DEFAULT_STATE: AppState = {
  mode: 'active',
  baselineStartDate: Date.now(),
  baselineDurationDays: 7,
  currentSessionId: null,
  sessionTabId: null,
};
