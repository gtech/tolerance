import type { EngagementScore } from './types';

// The line of text on a blurred post's cover. For a scored post it is the score,
// then the model's gist of the post ("82: Joke that Mondays feel long."): the number
// says at a glance how far over the line the post is. `notFollowing` is set while
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
    // Only on a cover when unscored posts are set to blur (Settings.blurUnscored)
    text = `Couldn't score${why ? `: ${why}` : ''}`;
  } else {
    const gist = score.apiReason?.trim();
    text = gist ? `${rounded}: ${gist}` : `Score ${rounded}`;
  }
  if (score.whitelisted && !notFollowing) text += ' (trusted, blurred late in session)';
  return text;
}
