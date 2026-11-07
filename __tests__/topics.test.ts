import { describe, it, expect } from 'vitest';
import { addTopicHit, buildTopic, customThemesFirst, HIDE_MODIFIER, TOPIC_RECENT_MAX } from '../src/shared/topics';
import { NarrativeTheme } from '../src/shared/types';

describe('topics', () => {
  it('builds a theme and a matching strategy from one line of text', () => {
    const { theme, strategy } = buildTopic('  vagueposting  ');
    expect(theme.name).toBe('vagueposting');
    expect(theme.description).toContain('vagueposting');
    expect(theme.isSystemTheme).toBe(false);
    expect(theme.active).toBe(true);
    expect(strategy.themeId).toBe(theme.id);
    expect(strategy.scoreModifier).toBe(HIDE_MODIFIER);
    expect(strategy.enabled).toBe(true);
  });

  it('shortens long names but keeps the whole text for detection', () => {
    const text = 'x'.repeat(200);
    const { theme } = buildTopic(text);
    expect(theme.name.length).toBeLessThanOrEqual(60);
    expect(theme.description).toContain(text);
  });

  it('counts per day, and keeps the latest reasons across days', () => {
    let hits = addTopicHit({}, 't', '2026-11-06', 'one');
    hits = addTopicHit(hits, 't', '2026-11-06', 'two');
    expect(hits.t.count).toBe(2);
    expect(hits.t.recent).toEqual(['two', 'one']);
    hits = addTopicHit(hits, 't', '2026-11-07', 'three');
    expect(hits.t.count).toBe(1);
    expect(hits.t.recent).toEqual(['three', 'two', 'one']);
  });

  it('caps the kept reasons', () => {
    let hits = {};
    for (let i = 0; i < TOPIC_RECENT_MAX + 3; i++) hits = addTopicHit(hits, 't', 'd', `r${i}`);
    expect((hits as { t: { recent: string[] } }).t.recent).toHaveLength(TOPIC_RECENT_MAX);
  });

  it('orders custom themes ahead of built-in ones', () => {
    const theme = (id: string, isSystemTheme: boolean) => ({ id, name: id, description: id, isSystemTheme, active: true }) as NarrativeTheme;
    const ordered = customThemesFirst([theme('doom', true), theme('mine', false), theme('conspiracy', true)]);
    expect(ordered.map(t => t.id)).toEqual(['mine', 'doom', 'conspiracy']);
  });
});
