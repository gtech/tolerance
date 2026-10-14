import { describe, it, expect } from 'vitest';
import { extractScoreFromText } from '../src/shared/score-parse';

describe('extractScoreFromText', () => {
  it('ignores bare numbers in prose', () => {
    expect(extractScoreFromText('1. The image shows a man holding 3 cats')).toBeNull();
    expect(extractScoreFromText('This tweet has 2 images and a chart')).toBeNull();
  });

  it('reads truncated JSON, keeping the reason', () => {
    expect(extractScoreFromText('{"score": 7, "reason": "Outrage bait about pol')).toEqual({ score: 7, reason: 'Outrage bait about pol' });
  });

  it('reads labelled scores and N/10', () => {
    expect(extractScoreFromText('Score: 8 because it is rage bait')?.score).toBe(8);
    expect(extractScoreFromText('I would give this a 6/10')?.score).toBe(6);
  });

  it('rejects out-of-range scores', () => {
    expect(extractScoreFromText('score: 85')).toBeNull();
  });
});
