// Topics card: describe something, then hide it or always show it, everywhere.
import { CounterStrategy, NarrativeTheme } from '../shared/types';
import { buildTopic, HIDE_MODIFIER, SHOW_MODIFIER, topicStrategy, TopicHits } from '../shared/topics';
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

function statusLine(theme: NarrativeTheme, strategy: CounterStrategy | undefined, count: number): string {
  if (!theme.active) return 'Paused';
  if (!strategy) return 'Spotted, but not hidden or shown';
  const posts = `${count} ${count === 1 ? 'post' : 'posts'}`;
  if (strategy.scoreModifier < 0) return count === 0 ? 'Always shown. Nothing matched yet today' : `Always shown. Kept ${posts} visible today`;
  return count === 0 ? 'Hidden. Nothing caught yet today' : `Hidden. Caught ${posts} today`;
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
    summary.textContent = 'What it matched';
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
    for (const [label, modifier] of [['Hide it', HIDE_MODIFIER], ['Show it', SHOW_MODIFIER]] as const) {
      actions.appendChild(button(label, async () => {
        await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy: topicStrategy(theme, modifier) });
        await handlers?.onChange();
      }));
    }
  }
  actions.appendChild(button('Edit', () => handlers?.onEdit(theme.id)));
  actions.appendChild(button(theme.active ? 'Pause' : 'Resume', async () => {
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme: { ...theme, active: !theme.active } });
    await handlers?.onChange();
  }));
  actions.appendChild(button('Delete', async () => {
    if (!confirm(`Remove "${theme.name}"?`)) return;
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
  const hide = document.getElementById('topic-add-btn');
  const show = document.getElementById('topic-show-btn');
  const note = document.getElementById('topic-note');
  if (!input || !hide || !show) return;

  const addTopic = async (modifier: number) => {
    const text = input.value.trim();
    if (!text) return;
    const { theme, strategy } = buildTopic(text, modifier);
    await chrome.runtime.sendMessage({ type: 'UPDATE_NARRATIVE_THEME', theme });
    await chrome.runtime.sendMessage({ type: 'SAVE_COUNTER_STRATEGY', strategy });
    input.value = '';
    if (note) note.textContent = 'Added. Reload your feeds to see it working.';
    await handlers?.onChange();
  };

  hide.addEventListener('click', () => void addTopic(HIDE_MODIFIER));
  show.addEventListener('click', () => void addTopic(SHOW_MODIFIER));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void addTopic(HIDE_MODIFIER);
  });
}
