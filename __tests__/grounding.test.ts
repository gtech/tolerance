import { describe, it, expect } from 'vitest';
import { advanceGrounding, GroundingState } from '../src/shared/grounding-utils';

const MIN = 60_000;

// Simulate heartbeats every 30s for `minutes`, returning the minutes at which a prompt fired
function scroll(state: GroundingState, start: number, minutes: number, interval = 20, canPrompt = () => true) {
  const prompts: number[] = [];
  let s = state;
  for (let t = 0.5; t <= minutes; t += 0.5) {
    const r = advanceGrounding(s, start + t * MIN, interval, canPrompt());
    s = r.state;
    if (r.prompt) prompts.push(t);
  }
  return { state: s, prompts };
}

describe('advanceGrounding', () => {
  it('prompts every interval of continuous scrolling', () => {
    const { prompts } = scroll({ sittingMinutes: 0, lastHeartbeat: 0 }, 0, 61);
    expect(prompts).toEqual([20, 40, 60]);
  });

  it('starts a fresh sitting after a 5+ minute break', () => {
    const first = scroll({ sittingMinutes: 0, lastHeartbeat: 0 }, 0, 15);
    expect(first.prompts).toEqual([]);
    // Come back 10 minutes later: the earlier 15 minutes no longer count
    const second = scroll(first.state, 25 * MIN, 15);
    expect(second.prompts).toEqual([]);
    expect(second.state.sittingMinutes).toBeCloseTo(14.5);
  });

  it('a short pause (2-5 min) neither counts nor resets', () => {
    const r = advanceGrounding({ sittingMinutes: 10, lastHeartbeat: 0 }, 3 * MIN, 20, true);
    expect(r.state.sittingMinutes).toBe(10);
  });

  it('defers the prompt while the page cannot show it, then fires once', () => {
    const blocked = scroll({ sittingMinutes: 0, lastHeartbeat: 0 }, 0, 25, 20, () => false);
    expect(blocked.prompts).toEqual([]);
    const r = advanceGrounding(blocked.state, 25.5 * MIN, 20, true);
    expect(r.prompt).toBe(true);
    expect(r.state.sittingMinutes).toBe(0);
  });

  it('first heartbeat ever does not count the time since epoch', () => {
    const r = advanceGrounding({ sittingMinutes: 0, lastHeartbeat: 0 }, Date.now(), 20, true);
    expect(r.prompt).toBe(false);
    expect(r.state.sittingMinutes).toBe(0);
  });
});
