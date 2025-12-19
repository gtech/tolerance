// RescueTime API client for productivity tracking

import { getSettings } from './storage';

export interface ProductivityStats {
  writing: number;      // minutes
  jobSearch: number;    // minutes
  coding: number;       // minutes
  lastUpdated: number;  // timestamp
}

interface RescueTimeRow {
  0: number;  // rank
  1: number;  // time spent (seconds)
  2: number;  // number of people (always 1 for individual)
  3: string;  // activity name
  4: string;  // category
  5: number;  // productivity score
}

// Activity name patterns for each category
const ACTIVITY_PATTERNS = {
  writing: [
    /obsidian/i,
    /lesswrong/i,
    /google docs/i,
    /notion/i,
    /bear/i,
    /typora/i,
    /scrivener/i,
    /ulysses/i,
    /ia writer/i,
  ],
  jobSearch: [
    /linkedin/i,
    /indeed/i,
    /glassdoor/i,
    /angel\.co/i,
    /wellfound/i,
    /lever\.co/i,
    /greenhouse/i,
    /workday/i,
    /jobs/i,
    /careers/i,
  ],
  coding: [
    /cursor/i,
    /vs\s?code/i,
    /visual studio code/i,
    /kitty/i,
    /iterm/i,
    /terminal/i,
    /github/i,
    /gitlab/i,
    /sublime/i,
    /intellij/i,
    /pycharm/i,
    /webstorm/i,
    /xcode/i,
    /android studio/i,
    /neovim/i,
    /vim/i,
    /emacs/i,
  ],
};

// Cache for productivity stats
let cachedStats: ProductivityStats | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function getProductivityStats(): Promise<ProductivityStats | null> {
  // Check cache first
  if (cachedStats && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedStats;
  }

  const settings = await getSettings();
  const apiKey = (settings as { rescueTimeApiKey?: string }).rescueTimeApiKey;

  if (!apiKey) {
    return null;
  }

  try {
    const stats = await fetchRescueTimeData(apiKey);
    cachedStats = stats;
    cacheTimestamp = Date.now();
    return stats;
  } catch (error) {
    console.error('Tolerance: RescueTime API error:', error);
    return cachedStats; // Return stale cache on error
  }
}

async function fetchRescueTimeData(apiKey: string): Promise<ProductivityStats> {
  const today = new Date().toISOString().split('T')[0];

  const url = new URL('https://www.rescuetime.com/anapi/data');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('perspective', 'interval');
  url.searchParams.set('restrict_kind', 'activity');
  url.searchParams.set('restrict_begin', today);
  url.searchParams.set('restrict_end', today);
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`RescueTime API error: ${response.status}`);
  }

  const data = await response.json();
  const rows: RescueTimeRow[] = data.rows || [];

  // Aggregate time by category
  const stats: ProductivityStats = {
    writing: 0,
    jobSearch: 0,
    coding: 0,
    lastUpdated: Date.now(),
  };

  for (const row of rows) {
    const activityName = row[3];
    const timeSeconds = row[1];
    const timeMinutes = Math.round(timeSeconds / 60);

    // Check which category this activity belongs to
    for (const pattern of ACTIVITY_PATTERNS.writing) {
      if (pattern.test(activityName)) {
        stats.writing += timeMinutes;
        break;
      }
    }

    for (const pattern of ACTIVITY_PATTERNS.jobSearch) {
      if (pattern.test(activityName)) {
        stats.jobSearch += timeMinutes;
        break;
      }
    }

    for (const pattern of ACTIVITY_PATTERNS.coding) {
      if (pattern.test(activityName)) {
        stats.coding += timeMinutes;
        break;
      }
    }
  }

  return stats;
}

// Format minutes for display
export function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${mins}m`;
}

// Clear cache (useful for testing)
export function clearProductivityCache(): void {
  cachedStats = null;
  cacheTimestamp = 0;
}
