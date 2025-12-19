// Productivity reminder card that replaces a random post in the feed

import { ProductivityStats, Settings, AppState } from '../shared/types';
import { log } from '../shared/constants';

export interface CardData {
  productivity: ProductivityStats | null;
  settings: Settings;
  state: AppState;
  highEngagementToday: number;
}

const CARD_ID = 'tolerance-reminder-card';

// Fun rotating messages for variety
const WRITING_PROMPTS = [
  'Resume Draft →',
  'Back to writing? →',
  'Your draft awaits →',
  'Pick up where you left off →',
  'The words won\'t write themselves →',
];

const JOB_PROMPTS = [
  'Reach out to someone',
  'Send one message today',
  'Future you will thank you',
  'One connection at a time',
  'Plant a seed today',
];

const CODING_PROMPTS = [
  'Open Project →',
  'Ship something →',
  'Back to the code →',
  'Build something cool →',
];

const HEADER_MESSAGES = [
  'Your Focus Today',
  'Meanwhile, in reality...',
  'A gentle nudge',
  'Quick check-in',
  'Your actual priorities',
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Format minutes for display
function formatMinutes(minutes: number): string {
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

// Create the reminder card element
export function createReminderCard(data: CardData): HTMLElement {
  const card = document.createElement('div');
  card.id = CARD_ID;
  card.className = 'thing tolerance-card';

  // Calculate days remaining in baseline (if applicable)
  let baselineInfo = '';
  if (data.state.mode === 'baseline') {
    const msElapsed = Date.now() - data.state.baselineStartDate;
    const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
    const daysRemaining = Math.max(0, data.state.baselineDurationDays - daysElapsed);
    baselineInfo = ` (baseline: ${daysRemaining.toFixed(0)} days)`;
  }

  const hasProductivity = data.productivity !== null;
  const title = hasProductivity ? randomFrom(HEADER_MESSAGES) : 'Tolerance';

  card.innerHTML = `
    <style>
      .tolerance-card {
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid #2a2a4a;
        border-radius: 8px;
        padding: 16px 20px;
        margin: 10px 0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #e0e0e0;
      }
      .tolerance-card-header {
        font-size: 14px;
        font-weight: 600;
        color: #a0a0c0;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .tolerance-card-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 0;
        border-bottom: 1px solid #2a2a4a;
      }
      .tolerance-card-row:last-of-type {
        border-bottom: none;
      }
      .tolerance-card-label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }
      .tolerance-card-value {
        font-size: 14px;
        font-weight: 500;
        color: #b0b0d0;
      }
      .tolerance-card-link {
        color: #7b8cde;
        text-decoration: none;
        font-size: 13px;
        padding: 4px 10px;
        background: rgba(123, 140, 222, 0.1);
        border-radius: 4px;
        transition: background 0.2s;
      }
      .tolerance-card-link:hover {
        background: rgba(123, 140, 222, 0.2);
        text-decoration: none;
      }
      .tolerance-card-divider {
        height: 1px;
        background: #2a2a4a;
        margin: 12px 0;
      }
      .tolerance-card-footer {
        font-size: 12px;
        color: #707090;
      }
      .tolerance-card-reminder {
        font-size: 13px;
        color: #a0a0c0;
        font-style: italic;
      }
      .tolerance-card-actions {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .tolerance-msg-icons {
        display: flex;
        gap: 8px;
      }
      .tolerance-icon-link {
        color: #707090;
        transition: color 0.2s;
        display: flex;
        align-items: center;
      }
      .tolerance-icon-link:hover {
        color: #b0b0d0;
      }
    </style>
    <div class="tolerance-card-header">
      <span>📊</span>
      <span>${title}</span>
    </div>
    ${hasProductivity ? buildProductivityRows(data) : buildFallbackRows(data)}
    <div class="tolerance-card-divider"></div>
    <div class="tolerance-card-footer">
      ${data.highEngagementToday} high-engagement posts seen today
      ${data.state.mode === 'active' ? ' · Feed reordering: active' : baselineInfo}
    </div>
  `;

  return card;
}

function buildProductivityRows(data: CardData): string {
  const p = data.productivity!;
  const settings = data.settings as Settings & { todoistUrl?: string };

  let rows = '';

  // Writing row
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>✍️</span>
        <span>Writing</span>
        <span class="tolerance-card-value">${formatMinutes(p.writing)}</span>
      </div>
      ${settings.obsidianUrl
        ? `<a href="${settings.obsidianUrl}" class="tolerance-card-link">${randomFrom(WRITING_PROMPTS)}</a>`
        : '<span class="tolerance-card-reminder">Set article in popup</span>'
      }
    </div>
  `;

  // Job search row with messaging app icons
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>💼</span>
        <span>Job Search</span>
        <span class="tolerance-card-value">${formatMinutes(p.jobSearch)}</span>
      </div>
      <div class="tolerance-card-actions">
        <span class="tolerance-card-reminder">${randomFrom(JOB_PROMPTS)}</span>
        <div class="tolerance-msg-icons">
          <a href="https://web.whatsapp.com/" target="_blank" title="WhatsApp" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          </a>
          <a href="sgnl://open" title="Signal" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3.6c4.635 0 8.4 3.765 8.4 8.4 0 4.635-3.765 8.4-8.4 8.4-1.5 0-2.906-.394-4.122-1.083l-.288-.166-2.988.783.798-2.916-.182-.298A8.347 8.347 0 013.6 12c0-4.635 3.765-8.4 8.4-8.4z"/></svg>
          </a>
          <a href="https://web.telegram.org/" target="_blank" title="Telegram" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          </a>
          <a href="https://www.linkedin.com/messaging/" target="_blank" title="LinkedIn" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          </a>
        </div>
      </div>
    </div>
  `;

  // Coding row
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>💻</span>
        <span>Coding</span>
        <span class="tolerance-card-value">${formatMinutes(p.coding)}</span>
      </div>
      ${settings.codingProjectLink
        ? `<a href="${settings.codingProjectLink}" target="_blank" class="tolerance-card-link">${randomFrom(CODING_PROMPTS)}</a>`
        : ''
      }
    </div>
  `;

  // Todoist row
  const todoistLink = settings.todoistUrl || 'https://todoist.com/app/today';
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>✅</span>
        <span>Tasks</span>
      </div>
      <a href="${todoistLink}" target="_blank" class="tolerance-card-link">Check Todoist →</a>
    </div>
  `;

  return rows;
}

function buildFallbackRows(data: CardData): string {
  const settings = data.settings as Settings & { todoistUrl?: string };

  let rows = '';

  // Writing row (no time, just link)
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>✍️</span>
        <span>Writing</span>
      </div>
      ${settings.obsidianUrl
        ? `<a href="${settings.obsidianUrl}" class="tolerance-card-link">${randomFrom(WRITING_PROMPTS)}</a>`
        : '<span class="tolerance-card-reminder">Set article in popup</span>'
      }
    </div>
  `;

  // Job search row with messaging icons
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>💼</span>
        <span>Job Search</span>
      </div>
      <div class="tolerance-card-actions">
        <span class="tolerance-card-reminder">${randomFrom(JOB_PROMPTS)}</span>
        <div class="tolerance-msg-icons">
          <a href="https://web.whatsapp.com/" target="_blank" title="WhatsApp" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          </a>
          <a href="sgnl://open" title="Signal" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 3.6c4.635 0 8.4 3.765 8.4 8.4 0 4.635-3.765 8.4-8.4 8.4-1.5 0-2.906-.394-4.122-1.083l-.288-.166-2.988.783.798-2.916-.182-.298A8.347 8.347 0 013.6 12c0-4.635 3.765-8.4 8.4-8.4z"/></svg>
          </a>
          <a href="https://web.telegram.org/" target="_blank" title="Telegram" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          </a>
          <a href="https://www.linkedin.com/messaging/" target="_blank" title="LinkedIn" class="tolerance-icon-link">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
          </a>
        </div>
      </div>
    </div>
  `;

  // Todoist row
  const todoistLink = settings.todoistUrl || 'https://todoist.com/app/today';
  rows += `
    <div class="tolerance-card-row">
      <div class="tolerance-card-label">
        <span>✅</span>
        <span>Tasks</span>
      </div>
      <a href="${todoistLink}" target="_blank" class="tolerance-card-link">Check Todoist →</a>
    </div>
  `;

  return rows;
}

// Inject the card into the feed, replacing a random post (position 2-5)
export function injectReminderCard(data: CardData): void {
  // Remove existing card if present
  const existing = document.getElementById(CARD_ID);
  if (existing) {
    // Restore previously hidden post
    const hiddenPostId = existing.dataset.hiddenPostId;
    if (hiddenPostId) {
      const hiddenPost = document.querySelector(`[data-fullname="${hiddenPostId}"]`) as HTMLElement;
      if (hiddenPost) {
        hiddenPost.style.display = '';
      }
    }
    existing.remove();
  }

  const siteTable = document.querySelector('#siteTable');
  if (!siteTable) {
    console.warn('Tolerance: Could not find #siteTable for card injection');
    return;
  }

  const posts = siteTable.querySelectorAll('.thing.link:not(.promoted)');
  const card = createReminderCard(data);

  // Random position between 2-5 (so position 3-6 in human terms)
  const minPos = 2;
  const maxPos = Math.min(5, posts.length - 1);
  const targetPos = minPos + Math.floor(Math.random() * (maxPos - minPos + 1));

  if (posts.length > targetPos) {
    const targetPost = posts[targetPos];
    targetPost.parentNode?.insertBefore(card, targetPost);
    (targetPost as HTMLElement).style.display = 'none';
    card.dataset.hiddenPostId = (targetPost as HTMLElement).dataset.fullname || '';
  } else if (posts.length > 0) {
    // Not enough posts, append at end
    siteTable.appendChild(card);
  }

  log.debug(` Reminder card injected at position ${targetPos + 1}`);
}

// Remove the card and restore hidden post
export function removeReminderCard(): void {
  const card = document.getElementById(CARD_ID);
  if (!card) return;

  // Restore hidden post if we have reference
  const hiddenPostId = card.dataset.hiddenPostId;
  if (hiddenPostId) {
    const hiddenPost = document.querySelector(`[data-fullname="${hiddenPostId}"]`) as HTMLElement;
    if (hiddenPost) {
      hiddenPost.style.display = '';
    }
  }

  card.remove();
}
