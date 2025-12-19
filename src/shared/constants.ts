// ==========================================
// Debug / Logging
// ==========================================

import type { LogLevel } from './types';

// Log level priority (higher = more verbose)
const LOG_PRIORITY: Record<LogLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

// Current log level (default: error only)
let currentLogLevel: LogLevel = 'error';

// Set the log level (called on init from settings)
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

// Get current log level
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

// Logging utility - respects current log level
export const log = {
  debug: (...args: unknown[]) => {
    if (LOG_PRIORITY[currentLogLevel] >= LOG_PRIORITY.debug) {
      console.log('Tolerance:', ...args);
    }
  },
  info: (...args: unknown[]) => {
    if (LOG_PRIORITY[currentLogLevel] >= LOG_PRIORITY.info) {
      console.log('Tolerance:', ...args);
    }
  },
  warn: (...args: unknown[]) => {
    if (LOG_PRIORITY[currentLogLevel] >= LOG_PRIORITY.warn) {
      console.warn('Tolerance:', ...args);
    }
  },
  error: (...args: unknown[]) => {
    if (LOG_PRIORITY[currentLogLevel] >= LOG_PRIORITY.error) {
      console.error('Tolerance:', ...args);
    }
  },
};

// ==========================================
// Keyword lists for heuristic scoring

export const OUTRAGE_KEYWORDS = [
  'destroyed',
  'slammed',
  'obliterated',
  'eviscerated',
  'unbelievable',
  'shocking',
  'outrageous',
  'disgusting',
  'admits',
  'exposed',
  'betrayed',
  'furious',
  'enraged',
  'insane',
  'crazy',
  'hypocrisy',
  'hypocrite',
  'liar',
  'lies',
  'corrupt',
  'scandal',
];

export const CURIOSITY_GAP_KEYWORDS = [
  "you won't believe",
  'what happened next',
  'finally',
  'here\'s why',
  'this is why',
  'the reason',
  'turns out',
  'actually',
  'secret',
  'revealed',
  'truth about',
  'nobody is talking about',
  'everyone is missing',
  'game changer',
  'mind blowing',
  'wait until you see',
];

export const TRIBAL_KEYWORDS = [
  // Political - intentionally balanced to detect tribalism from any direction
  'liberals',
  'conservatives',
  'leftist',
  'right-wing',
  'woke',
  'anti-woke',
  'maga',
  'socialist',
  'fascist',
  'communist',
  // Us vs them
  'these people',
  'those people',
  'they always',
  'they never',
  'typical',
  'imagine being',
  'of course they',
];

// Subreddit categories (expanded list)
export const SUBREDDIT_CATEGORIES: Record<string, string> = {
  // High engagement / outrage risk
  'politics': 'political',
  'conservative': 'political',
  'liberal': 'political',
  'libertarian': 'political',
  'politicalcompassmemes': 'political',
  'worldnews': 'news',
  'news': 'news',
  'upliftingnews': 'news',
  'nottheonion': 'news',
  'publicfreakout': 'outrage',
  'actualpublicfreakouts': 'outrage',
  'facepalm': 'outrage',
  'trashy': 'outrage',
  'cringetopia': 'outrage',
  'iamatotalpieceofshit': 'outrage',
  'choosingbeggars': 'outrage',
  'antiwork': 'outrage',
  'latestagecapitalism': 'outrage',
  'fuckcars': 'outrage',
  'mildlyinfuriating': 'outrage',
  'idiotsincars': 'outrage',
  'entitledparents': 'drama',
  'maliciouscompliance': 'drama',
  'pettyrevenge': 'drama',
  'prorevenge': 'drama',
  'nuclearrevenge': 'drama',

  // Drama / relationship
  'amitheasshole': 'drama',
  'relationship_advice': 'drama',
  'relationships': 'drama',
  'tifu': 'drama',
  'confessions': 'drama',
  'offmychest': 'drama',
  'trueoffmychest': 'drama',
  'unpopularopinion': 'drama',
  'changemyview': 'discussion',
  'amithebuttface': 'drama',
  'bestofredditorupdates': 'drama',

  // Discussion / educational
  'askreddit': 'discussion',
  'nostupidquestions': 'discussion',
  'outoftheloop': 'discussion',
  'askscience': 'educational',
  'todayilearned': 'educational',
  'explainlikeimfive': 'educational',
  'science': 'educational',
  'space': 'educational',
  'history': 'educational',
  'dataisbeautiful': 'educational',
  'personalfinance': 'educational',
  'lifeprotips': 'educational',
  'youshouldknow': 'educational',

  // Hobby / interest
  'gaming': 'hobby',
  'games': 'hobby',
  'pcgaming': 'hobby',
  'music': 'hobby',
  'movies': 'hobby',
  'television': 'hobby',
  'books': 'hobby',
  'art': 'hobby',
  'diy': 'hobby',
  'cooking': 'hobby',
  'food': 'hobby',
  'fitness': 'hobby',
  'sports': 'hobby',
  'nba': 'hobby',
  'nfl': 'hobby',
  'soccer': 'hobby',
  'photography': 'hobby',
  'gardening': 'hobby',
  'woodworking': 'hobby',

  // Tech
  'programming': 'technical',
  'webdev': 'technical',
  'technology': 'technical',
  'android': 'technical',
  'apple': 'technical',
  'linux': 'technical',
  'sysadmin': 'technical',
  'buildapc': 'technical',
  'homelab': 'technical',

  // Wholesome / positive
  'aww': 'wholesome',
  'mademesmile': 'wholesome',
  'humansbeingbros': 'wholesome',
  'animalsbeingbros': 'wholesome',
  'wholesomememes': 'wholesome',
  'eyebleach': 'wholesome',
  'rarepuppers': 'wholesome',
  'contagiouslaughter': 'wholesome',

  // Entertainment / memes
  'pics': 'media',
  'videos': 'media',
  'gifs': 'media',
  'funny': 'entertainment',
  'memes': 'entertainment',
  'dankmemes': 'entertainment',
  'me_irl': 'entertainment',
  'jokes': 'entertainment',
  'comics': 'entertainment',
  'interestingasfuck': 'media',
  'oddlysatisfying': 'media',
  'nextfuckinglevel': 'media',
  'damnthatsinteresting': 'media',
  'blackmagicfuckery': 'media',
};

// Score thresholds - platform-specific based on heuristic score distribution
// Reddit: heuristic mean ~45, 90th percentile ~55
// Twitter: heuristic mean ~40, 90th percentile ~48 (more compressed range)
export const SCORE_THRESHOLDS = {
  reddit: {
    HIGH: 70,
    MEDIUM: 40,
  },
  twitter: {
    // Twitter heuristics produce lower scores, adjust thresholds accordingly
    // 75th percentile: 43, 90th: 48, 95th: 51
    HIGH: 48,   // ~top 10-15% of tweets
    MEDIUM: 38, // ~50th percentile
  },
  youtube: {
    // YouTube thresholds - to be calibrated after data collection
    // Starting with values between Reddit and Twitter
    HIGH: 55,
    MEDIUM: 40,
  },
};

// Bucket boundaries
export function scoreToBucket(score: number, platform: 'reddit' | 'twitter' | 'youtube' = 'reddit'): 'low' | 'medium' | 'high' {
  const thresholds = SCORE_THRESHOLDS[platform];
  if (score >= thresholds.HIGH) return 'high';
  if (score >= thresholds.MEDIUM) return 'medium';
  return 'low';
}

// ==========================================
// Narrative Awareness Keywords
// ==========================================

// Doom/Hopelessness keywords - organized by sub-theme
export const DOOM_KEYWORDS = {
  economic: [
    'collapse', 'crash', 'recession', 'depression', 'hyperinflation',
    'bubble burst', 'bubble bursting', "can't afford", 'priced out',
    'housing crisis', 'wage stagnation', 'layoffs everywhere',
    'job market dead', 'economy tanking', 'market crash',
    'financial ruin', 'going bankrupt', 'poverty',
  ],
  political: [
    'democracy dying', 'democracy dead', 'end times', 'country is doomed',
    'no hope left', 'nothing will change', 'both sides same', 'rigged system',
    'point of no return', 'too far gone', 'beyond saving',
    'irreversible damage', 'no way back', 'failed state',
  ],
  existential: [
    'humanity doomed', 'no future', 'too late', 'giving up',
    'why bother', "what's the point", 'learned helplessness',
    'nothing matters', 'inevitable decline', 'all downhill',
    'beyond repair', 'hopeless', 'despair', 'nihilism',
  ],
};

// Conspiracy/Manipulation keywords
export const CONSPIRACY_KEYWORDS = {
  hidden_forces: [
    "they don't want you to know", 'wake up', 'open your eyes',
    'hidden agenda', 'puppet masters', 'pulling strings',
    'controlled opposition', 'deep state', 'powers that be',
    'shadow government', 'secret cabal', 'ruling class',
  ],
  coordinated: [
    'psyop', 'propaganda', 'manufactured', 'astroturfing',
    'narrative control', 'media manipulation', 'cover up',
    'suppressed', 'silenced', 'censored truth', 'coordinated attack',
    'disinformation campaign', 'controlled narrative',
  ],
  revelation: [
    'exposed', 'leaked', 'whistleblower', 'secret documents',
    'finally revealed', 'proof they', 'caught red handed',
    'smoking gun', 'hidden truth', 'real story',
  ],
};

// Identity/Isolation keywords
export const IDENTITY_KEYWORDS = {
  alienation: [
    'forever alone', 'no one understands', 'outsider', "don't belong",
    'black sheep', 'outcast', 'invisible', 'nobody cares',
    'all alone', 'isolated', 'disconnected', 'alienated',
  ],
  grievance: [
    'always blamed', 'under attack', 'discriminated against',
    'demonized', 'scapegoat', 'targeted', 'hated for being',
    'persecuted', 'vilified', 'marginalized',
  ],
  hopelessness: [
    'will never', 'impossible to', 'gave up on', 'not for people like me',
    'rigged against', "can't win", 'system designed to fail',
    'born to lose', 'no chance', 'destined to fail',
  ],
};

// Combined map for iteration
export const NARRATIVE_KEYWORDS: Record<string, Record<string, string[]>> = {
  doom: DOOM_KEYWORDS,
  conspiracy: CONSPIRACY_KEYWORDS,
  identity: IDENTITY_KEYWORDS,
};

// Seed narrative themes (system-defined)
import type { NarrativeTheme } from './types';

export const SEED_NARRATIVE_THEMES: NarrativeTheme[] = [
  {
    id: 'doom',
    name: 'Doom / Hopelessness',
    description: 'Content promoting despair, learned helplessness, economic collapse fears, or nihilism. Often frames situations as irreversible and action as pointless.',
    keywords: [
      ...DOOM_KEYWORDS.economic,
      ...DOOM_KEYWORDS.political,
      ...DOOM_KEYWORDS.existential,
    ],
    isSystemTheme: true,
    active: true,
  },
  {
    id: 'conspiracy',
    name: 'Conspiracy / Manipulation',
    description: 'Content suggesting hidden forces control events, "they don\'t want you to know" framing, or coordinated cover-ups without evidence.',
    keywords: [
      ...CONSPIRACY_KEYWORDS.hidden_forces,
      ...CONSPIRACY_KEYWORDS.coordinated,
      ...CONSPIRACY_KEYWORDS.revelation,
    ],
    isSystemTheme: true,
    active: true,
  },
  {
    id: 'identity',
    name: 'Identity / Isolation',
    description: 'Content promoting alienation, identity-based grievance, or "forever alone" narratives. Often frames social connection as impossible.',
    keywords: [
      ...IDENTITY_KEYWORDS.alienation,
      ...IDENTITY_KEYWORDS.grievance,
      ...IDENTITY_KEYWORDS.hopelessness,
    ],
    isSystemTheme: true,
    active: true,
  },
];
