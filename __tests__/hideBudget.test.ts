import { describe, it, expect } from 'vitest';
import { createHideBudget, HIDE_BUDGET_MAX, HIDE_BUDGET_WINDOW_MS } from '../src/shared/hide-budget';

describe('hide budget', () => {
  it('allows hides up to the cap, then refuses', () => {
    const budget = createHideBudget(3, 1000);
    expect(budget.take(0)).toBe(true);
    expect(budget.take(1)).toBe(true);
    expect(budget.take(2)).toBe(true);
    expect(budget.take(3)).toBe(false);
    expect(budget.used(3)).toBe(3);
  });

  it('does not count refused hides', () => {
    const budget = createHideBudget(1, 1000);
    budget.take(0);
    for (let i = 1; i < 50; i++) expect(budget.take(i)).toBe(false);
    // The one counted hide ages out on schedule; refusals did not extend the window
    expect(budget.take(1000)).toBe(true);
  });

  it('frees a slot as each hide leaves the window', () => {
    const budget = createHideBudget(2, 1000);
    budget.take(0);
    budget.take(600);
    expect(budget.take(900)).toBe(false);
    expect(budget.take(1000)).toBe(true);   // the hide at 0 has aged out
    expect(budget.take(1100)).toBe(false);  // 600 and 1000 still count
    expect(budget.take(1600)).toBe(true);
  });

  it('stops a page that hides everything', () => {
    // One video hidden every 200ms for ten minutes: never more than the cap per window
    const budget = createHideBudget();
    const hidden: number[] = [];
    for (let now = 0; now < 10 * 60 * 1000; now += 200) {
      if (budget.take(now)) hidden.push(now);
    }
    expect(hidden.length).toBe(HIDE_BUDGET_MAX * 2);
    for (const t of hidden) {
      const inWindow = hidden.filter(u => u >= t && u - t < HIDE_BUDGET_WINDOW_MS).length;
      expect(inWindow).toBeLessThanOrEqual(HIDE_BUDGET_MAX);
    }
  });
});
