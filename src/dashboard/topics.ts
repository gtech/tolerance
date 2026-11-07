// "Topics to Hide" card: type what you're tired of seeing, and it's blurred everywhere.
import { CounterStrategy, NarrativeTheme } from '../shared/types';
import { buildTopic, hideStrategy, TopicHits } from '../shared/topics';
import { getTodayDateString } from '../background/storage';

interface TopicHandlers {
  onChange: () => Promise<void>;       // Something changed: refresh everything that shows topics
  onEdit: (themeId: string) => void;   // Open the edit dialog
}

let handlers: TopicHandlers | null = null;

function button(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'btn-secondary';
  btn.type = 'button';
  btn.textContent = label;
  btn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
  btn.addEventListener('click', () => void onClick());
  return btn;
}

function statusLine(theme: NarrativeTheme, hiding: CounterStrategy | undefined, count: number): string {
  if (!theme.active) return 'Paused';
  if (!hiding) return 'Spotted but not hidden';
  if (hiding.scoreModifier <= 0) return 'Shown more often';
  return count === 0 ? 'Nothing caught yet today' : `Caught ${count} ${count === 1 ? 'post' : 'posts'} today`;
}

function renderRow(theme: NarrativeTheme, strategy: CounterStrategy | undefined, hits: TopicHits, today: string): HTMLElement {
  const hit = hits[theme.id];
  const count = hit?.date === today ? hit.count : 0;

  const row = document.createElement('div');
  row.className = 'topic-row';

  const main = document.createElement('div');
  main.className = 'topic-main';
  const name = document.createElement('div');
  name.className = 'topic-name';
  name.textContent = theme.name;
  const status = document.createElement('div');
  status.className = 'topic-status';
  status.textContent = statusLine(theme, strategy, count);
  main.append(name, status);

  if (hit?.recent.length) {
    const details = document.createElement('details');
    details.className = 'topic-recent';
    const summary = document.createElement('summary');
    summary.textContent = 'What it caught';
    const list = document.createElement('ul');
    for (const reason of hit.recent) {
      const item = document.createElement('li');
      item.textContent = reason;
      list.appendChild(item);
    }
    details.append(summary, list);
    main.appendChild(details);
  }

  const actions = document.createElement('div');
  actions.className = 'topic-actions';
  if (theme.active && !strategy) {
    actions.appendChild(button('Hide it', async () => {
      await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy: hideStrategy(theme) });
      await handlers?.onChange();
    }));
  }
  actions.appendChild(button('Edit', () => handlers?.onEdit(theme.id)));
  actions.appendChild(button(theme.active ? 'Pause' : 'Resume', async () => {
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme: { ...theme, active: !theme.active } });
    await handlers?.onChange();
  }));
  actions.appendChild(button('Delete', async () => {
    if (!confirm(`Stop hiding "${theme.name}"?`)) return;
    await chrome.runtime.sendMessage({ type: 'DELETE_NARRATIVE_THEME', themeId: theme.id });
    await handlers?.onChange();
  }));

  row.append(main, actions);
  return row;
}

export async function renderTopics(themes: NarrativeTheme[], strategies: CounterStrategy[]): Promise<void> {
  const list = document.getElementById('topics-list');
  if (!list) return;

  const { topicHits } = await chrome.storage.local.get('topicHits');
  const hits = (topicHits as TopicHits | undefined) ?? {};
  const today = getTodayDateString();

  const rows = themes
    .filter(t => !t.isSystemTheme)
    .map(t => renderRow(t, strategies.find(s => s.themeId === t.id && s.enabled), hits, today));
  list.replaceChildren(...rows);
}

export function setupTopics(topicHandlers: TopicHandlers): void {
  handlers = topicHandlers;
  const input = document.getElementById('topic-input') as HTMLInputElement | null;
  const add = document.getElementById('topic-add-btn');
  const note = document.getElementById('topic-note');
  if (!input || !add) return;

  const addTopic = async () => {
    const text = input.value.trim();
    if (!text) return;
    const { theme, strategy } = buildTopic(text);
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme });
    await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy });
    input.value = '';
    if (note) note.textContent = 'Added. Reload your feeds to see it working.';
    await handlers?.onChange();
  };

  add.addEventListener('click', () => void addTopic());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addTopic();
  });
}
