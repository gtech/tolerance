// The usage chart, shared by the popup and the dashboard.
import { averageMinutes, UsageDay } from './usage-history';

// Gray only, like the rest of Tolerance: nothing here should pull the eye
const CHART_CSS = `
  .usage-readout { font-size: 13px; font-weight: 500; min-height: 16px; }
  .usage-summary { font-size: 12px; color: #888; margin-top: 2px; min-height: 15px; }
  .usage-chart { position: relative; margin-top: 18px; }
  .usage-scale { position: absolute; top: -14px; right: 0; font-size: 10px; color: #888; }
  .usage-plot { display: flex; align-items: flex-end; border-top: 1px solid #333; border-bottom: 1px solid #555; }
  .usage-column { flex: 1; min-width: 0; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .usage-column:hover { background: rgba(255, 255, 255, 0.06); }
  .usage-bar { width: calc(100% - 2px); min-height: 2px; background: #777; border-radius: 2px 2px 0 0; }
  .usage-column:hover .usage-bar, .usage-bar.today { background: #c8c8c8; }
  .usage-axis { display: flex; justify-content: space-between; font-size: 10px; color: #888; margin-top: 4px; }
`;

export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  if (total < 60) return `${total}m`;
  const mins = total % 60;
  return mins ? `${Math.floor(total / 60)}h ${mins}m` : `${Math.floor(total / 60)}h`;
}

function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function describeDay(day: UsageDay, isToday: boolean): string {
  const name = isToday ? 'Today' : formatDay(day.date);
  if (day.minutes === null) return `${name}: not tracked yet`;
  return `${name}: ${day.minutes < 0.5 ? 'no use' : formatMinutes(day.minutes)}`;
}

// This week against the one before, once both have been fully tracked
function usageSummary(days: UsageDay[]): string {
  const thisWeek = averageMinutes(days.slice(-7));
  const lastWeek = averageMinutes(days.slice(-14, -7));
  if (thisWeek === null) return '';
  const average = `${formatMinutes(thisWeek)} a day this week`;
  if (lastWeek === null || lastWeek < 1) return average;
  const change = Math.round((thisWeek - lastWeek) / lastWeek * 100);
  if (change === 0) return `${average}, same as last week`;
  return `${average}, ${change < 0 ? 'down' : 'up'} ${Math.abs(change)}% from last week`;
}

function textDiv(className: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function renderUsageChart(root: HTMLElement, days: UsageDay[], heightPx: number): void {
  if (!document.getElementById('tolerance-usage-chart-css')) {
    const style = document.createElement('style');
    style.id = 'tolerance-usage-chart-css';
    style.textContent = CHART_CSS;
    document.head.appendChild(style);
  }

  const today = days[days.length - 1];
  const peak = Math.max(...days.map(d => d.minutes ?? 0));
  const top = Math.max(60, Math.ceil(peak / 30) * 30); // at least an hour tall, in half hours
  const summary = usageSummary(days);

  const readout = textDiv('usage-readout', describeDay(today, true));

  const plot = document.createElement('div');
  plot.className = 'usage-plot';
  plot.style.height = `${heightPx}px`;
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', [`Minutes per day for the last ${days.length} days.`, describeDay(today, true), summary].filter(Boolean).join(' '));
  plot.addEventListener('mouseleave', () => { readout.textContent = describeDay(today, true); });

  for (const day of days) {
    const isToday = day === today;
    const column = document.createElement('div');
    column.className = 'usage-column';
    column.title = describeDay(day, isToday);
    if (day.minutes !== null && day.minutes >= 0.5) {
      const bar = document.createElement('div');
      bar.className = isToday ? 'usage-bar today' : 'usage-bar';
      bar.style.height = `${day.minutes / top * 100}%`;
      column.appendChild(bar);
    }
    column.addEventListener('mouseenter', () => { readout.textContent = describeDay(day, isToday); });
    plot.appendChild(column);
  }

  const axis = document.createElement('div');
  axis.className = 'usage-axis';
  axis.append(textDiv('', formatDay(days[0].date)), textDiv('', 'Today'));

  const chart = document.createElement('div');
  chart.className = 'usage-chart';
  chart.append(textDiv('usage-scale', formatMinutes(top)), plot, axis);

  root.replaceChildren(readout, textDiv('usage-summary', summary), chart);
}

export async function loadUsageChart(rootId: string, dayCount: number, heightPx: number): Promise<void> {
  try {
    const root = document.getElementById(rootId);
    const result = await chrome.runtime.sendMessage({ type: 'GET_USAGE_DAYS', count: dayCount }) as { days: UsageDay[] } | null;
    if (root && result?.days?.length) renderUsageChart(root, result.days, heightPx);
  } catch (error) {
    console.error('Failed to get usage history:', error);
  }
}
