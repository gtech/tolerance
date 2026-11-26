import type { EngagementScore } from './types';

// The line of text on a blurred post's cover. For a scored post it is the model's
// gist of the post and nothing else: the score is on the badge, and on the cover it
// only made the post look like something being rated. `notFollowing` is set while
// only-following mode is on, with the site's own wording ("Not following",
// "Not subscribed").
export function coverText(
  score: Pick<EngagementScore, 'apiScore' | 'apiReason' | 'scoreFailed' | 'whitelisted'>,
  notFollowing?: string | null
): string {
  if (notFollowing && !score.whitelisted) return notFollowing;
  const rounded = Math.round(score.apiScore);
  let text: string;
  if (score.scoreFailed) {
    const why = (score.apiReason ?? '').replace(/^Scoring failed: /, '');
    text = `Couldn't score, counted as ${rounded}${why ? `: ${why}` : ''}`;
  } else {
    text = score.apiReason?.trim() || `Score ${rounded}`;
  }
  if (score.whitelisted && !notFollowing) text += ' (trusted, blurred late in session)';
  return text;
}
