// Minutes on social media per local day, kept in storage as { 'YYYY-MM-DD': minutes }.
// The daily session in storage.ts only holds today, so each day is archived here when
// it rolls over.
export type UsageHistory = Record<string, number>;

export interface UsageDay {
  date: string;
  minutes: number | null; // null = before tracking started, not zero use
}

export const USAGE_HISTORY_DAYS = 90;

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Whole days are counted through the calendar, so daylight saving changes don't skip one
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return dateKey(new Date(y, m - 1, d + days));
}

export function archiveUsageDay(history: UsageHistory, date: string, minutes: number, today: string): UsageHistory {
  const oldest = shiftDate(today, -USAGE_HISTORY_DAYS);
  const kept = Object.entries(history).filter(([d]) => d >= oldest);
  return { ...Object.fromEntries(kept), [date]: minutes };
}

// The last `count` days, oldest first, ending today. A day missing after tracking
// started had no use: nothing rolled over because no site was opened that day.
export function recentUsageDays(history: UsageHistory, today: string, todayMinutes: number, count: number): UsageDay[] {
  const firstTracked = Object.keys(history).sort()[0] ?? today;
  const days: UsageDay[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = shiftDate(today, -i);
    let minutes: number | null = date < firstTracked ? null : history[date] ?? 0;
    if (date === today) minutes = todayMinutes;
    days.push({ date, minutes });
  }
  return days;
}

// Average per day over a stretch of days, skipping those before tracking started.
// Null unless every day in the stretch was tracked, so a partial week isn't compared.
export function averageMinutes(days: UsageDay[]): number | null {
  if (days.length === 0 || days.some(d => d.minutes === null)) return null;
  return days.reduce((sum, d) => sum + (d.minutes ?? 0), 0) / days.length;
}
