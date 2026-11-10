import { log } from '../shared/constants';
import { getSettings, getTodayDateString } from './storage';
import {
  addToDay, evaluateDay, lastFinishedDay,
  type FieldTally, type HealthAlert, type HealthHistory, type HealthPlatform, type HealthReport,
} from '../shared/scrape-health';

// The background half of the scraper health check: keeps each day's counts, runs the
// check once a day, and raises a mark on the toolbar icon when something looks broken.

const HISTORY_KEY = 'scrapeHealth';
const REPORT_KEY = 'scrapeHealthReport';

async function read(): Promise<{ history: HealthHistory; report: HealthReport | null }> {
  const stored = await chrome.storage.local.get<{ scrapeHealth?: HealthHistory; scrapeHealthReport?: HealthReport }>([HISTORY_KEY, REPORT_KEY]);
  return { history: stored.scrapeHealth ?? {}, report: stored.scrapeHealthReport ?? null };
}

// Counts arrive from several tabs; one at a time, so none overwrites another
let queue: Promise<void> = Promise.resolve();

export function recordScrapeHealth(
  platform: HealthPlatform,
  delta: { loads?: number; posts?: number; fields?: Record<string, FieldTally> }
): Promise<void> {
  queue = queue.then(async () => {
    if ((await getSettings()).scrapeHealthCheck !== true) return;
    const { history } = await read();
    await chrome.storage.local.set({ [HISTORY_KEY]: addToDay(history, getTodayDateString(), platform, delta) });
  }).catch(e => log.debug(' Scrape health: could not record', e));
  return queue;
}

function showBadge(alerts: number): void {
  // Not every browser build has the toolbar badge; the dashboard card shows the same thing
  try {
    void chrome.action?.setBadgeText({ text: alerts > 0 ? '!' : '' });
    if (alerts > 0) void chrome.action?.setBadgeBackgroundColor({ color: '#d03b3b' });
  } catch { /* no badge support */ }
}

// Check the latest finished day, unless it has been checked already. Called hourly; the
// work happens once, the first time it runs after a day ends.
export async function runDailyScrapeHealthCheck(): Promise<void> {
  if ((await getSettings()).scrapeHealthCheck !== true) return;
  const { history, report } = await read();
  const day = lastFinishedDay(history, getTodayDateString());
  if (!day || report?.day === day) return;
  await check(history, day);
}

// Check now, including today so far (the "Check now" button)
export async function runScrapeHealthCheckNow(): Promise<HealthReport | null> {
  const { history } = await read();
  const today = getTodayDateString();
  const day = history[today] ? today : lastFinishedDay(history, today);
  return day ? check(history, day) : null;
}

async function check(history: HealthHistory, day: string): Promise<HealthReport> {
  const alerts: HealthAlert[] = evaluateDay(history, day);
  const report: HealthReport = { day, checkedAt: Date.now(), alerts, seen: alerts.length === 0 };
  await chrome.storage.local.set({ [REPORT_KEY]: report });
  showBadge(alerts.length);
  if (alerts.length > 0) log.warn(` Scrape health for ${day}: ${alerts.map(a => a.message).join(' | ')}`);
  return report;
}

// For the dashboard card. Opening it counts as having seen the alerts.
export async function getScrapeHealth(): Promise<{ history: HealthHistory; report: HealthReport | null; today: string }> {
  const { history, report } = await read();
  if (report && !report.seen) {
    report.seen = true;
    await chrome.storage.local.set({ [REPORT_KEY]: report });
  }
  showBadge(0);
  return { history, report, today: getTodayDateString() };
}
