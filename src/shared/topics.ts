// Topics are the plain-language face of narrative themes plus counter-strategies: one
// box on the dashboard creates both, and each topic keeps a tally of what it caught.
import { CounterStrategy, NarrativeTheme } from './types';

// Enough to take a post to the top score, so it's blurred in every phase
export const HIDE_MODIFIER = 100;
// And to the bottom one, so it never is
export const SHOW_MODIFIER = -100;

const NAME_MAX = 60;

export function buildTopic(text: string, modifier = HIDE_MODIFIER, now = Date.now()): { theme: NarrativeTheme; strategy: CounterStrategy } {
  const description = text.trim();
  const id = `user_${now}_${Math.random().toString(36).slice(2, 11)}`;
  const theme: NarrativeTheme = {
    id,
    name: description.length > NAME_MAX ? `${description.slice(0, NAME_MAX - 1).trim()}…` : description,
    description: `Posts that clearly fit this description: "${description}". Similar or neighboring subjects don't count.`,
    keywords: [],
    isSystemTheme: false,
    active: true,
    discoveredAt: now,
  };
  return { theme, strategy: topicStrategy(theme, modifier, now) };
}

export function topicStrategy(theme: NarrativeTheme, modifier = HIDE_MODIFIER, now = Date.now()): CounterStrategy {
  return {
    id: `strategy_${now}_${Math.random().toString(36).slice(2, 7)}`,
    themeId: theme.id,
    thesis: theme.description,
    scoreModifier: modifier,
    enabled: true,
    createdAt: now,
  };
}

// What a topic has caught. Reasons are the model's neutral summaries, kept so someone
// can check for mistakes without seeing the posts themselves.
export interface TopicHit {
  date: string;      // Day the count belongs to
  count: number;     // Posts caught that day
  recent: string[];  // Latest first
}
export type TopicHits = Record<string, TopicHit>;

export const TOPIC_RECENT_MAX = 5;

export function addTopicHit(hits: TopicHits, themeId: string, date: string, reason?: string): TopicHits {
  const hit = hits[themeId];
  const recent = hit?.recent ?? [];
  return {
    ...hits,
    [themeId]: {
      date,
      count: hit?.date === date ? hit.count + 1 : 1,
      recent: reason ? [reason, ...recent].slice(0, TOPIC_RECENT_MAX) : recent,
    },
  };
}

// Custom topics come first, so a post matching both one of them and a built-in theme
// is counted against the topic the user asked for: only the first match gets applied
export function customThemesFirst(themes: NarrativeTheme[]): NarrativeTheme[] {
  return [...themes].sort((a, b) => Number(a.isSystemTheme) - Number(b.isSystemTheme));
}
