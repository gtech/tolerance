import { describe, it, expect } from 'vitest';
import { archiveUsageDay, averageMinutes, recentUsageDays } from '../src/shared/usage-history';

describe('usage history', () => {
  it('archives a day and drops days past the retention window', () => {
    const history = archiveUsageDay({ '2026-01-01': 10, '2026-11-01': 20 }, '2026-11-06', 30, '2026-11-07');
    expect(history).toEqual({ '2026-11-01': 20, '2026-11-06': 30 });
  });

  it('separates untracked days from days with no use', () => {
    const days = recentUsageDays({ '2026-11-04': 40, '2026-11-06': 15 }, '2026-11-07', 5, 5);
    expect(days).toEqual([
      { date: '2026-11-03', minutes: null },
      { date: '2026-11-04', minutes: 40 },
      { date: '2026-11-05', minutes: 0 },
      { date: '2026-11-06', minutes: 15 },
      { date: '2026-11-07', minutes: 5 },
    ]);
  });

  it('uses the live minutes for today, with nothing before it on a first day', () => {
    expect(recentUsageDays({}, '2026-11-07', 12, 2)).toEqual([
      { date: '2026-11-06', minutes: null },
      { date: '2026-11-07', minutes: 12 },
    ]);
  });

  it('crosses month and daylight saving boundaries one day at a time', () => {
    const days = recentUsageDays({}, '2026-03-02', 0, 3).map(d => d.date);
    expect(days).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
    const dst = recentUsageDays({}, '2026-11-02', 0, 3).map(d => d.date);
    expect(dst).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('only averages fully tracked stretches', () => {
    expect(averageMinutes([{ date: 'a', minutes: 10 }, { date: 'b', minutes: 20 }])).toBe(15);
    expect(averageMinutes([{ date: 'a', minutes: null }, { date: 'b', minutes: 20 }])).toBeNull();
    expect(averageMinutes([])).toBeNull();
  });
});
