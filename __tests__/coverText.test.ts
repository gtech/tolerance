import { describe, it, expect } from 'vitest';
import { coverText } from '../src/shared/cover-text';

describe('coverText', () => {
  it('shows the gist alone, without the score', () => {
    expect(coverText({ apiScore: 82, apiReason: 'Joke that Mondays feel long.' })).toBe('Joke that Mondays feel long.');
  });

  it('falls back to the score when the model gave no gist', () => {
    expect(coverText({ apiScore: 81.6 })).toBe('Score 82');
    expect(coverText({ apiScore: 70, apiReason: '  ' })).toBe('Score 70');
  });

  it('says so when the post could not be scored', () => {
    expect(coverText({ apiScore: 50, scoreFailed: true, apiReason: 'Scoring failed: key limit reached' }))
      .toBe("Couldn't score, counted as 50: key limit reached");
    expect(coverText({ apiScore: 50, scoreFailed: true })).toBe("Couldn't score, counted as 50");
  });

  it('uses the site wording in only-following mode, except for trusted sources', () => {
    expect(coverText({ apiScore: 20, apiReason: 'A plain update.' }, 'Not following')).toBe('Not following');
    expect(coverText({ apiScore: 80, apiReason: 'A meme.', whitelisted: true }, 'Not following')).toBe('A meme.');
  });

  it('notes a trusted source blurred late in a session', () => {
    expect(coverText({ apiScore: 80, apiReason: 'A meme.', whitelisted: true }))
      .toBe('A meme. (trusted, blurred late in session)');
  });
});
