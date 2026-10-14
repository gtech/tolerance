import { EngagementScore, TweetAnchor } from './types';
import { scoreToBucket } from './constants';

// Cache key for an anchor's score. Thread parents use their status ID (so the
// parent's own cached score is reused); quotes have no ID in the DOM, so they're
// keyed by author + text.
export function anchorCacheId(anchor: TweetAnchor): string {
  if (anchor.id) return anchor.id;
  const key = `${anchor.author.toLowerCase()}\n${anchor.text}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return `anchor:${anchor.author.toLowerCase()}:${(h >>> 0).toString(36)}`;
}

// A post is as much of a pull as the post it's responding to: the effective
// score is max(own, anchor). Re-folding is safe: a previously folded score is
// recomputed from the post's own score, so a later (higher or lower) anchor
// score replaces the old one. Returns whether the score changed.
export function foldAnchorScore(
  score: EngagementScore,
  anchor: TweetAnchor,
  anchorScore: EngagementScore
): boolean {
  if (anchorScore.scoreFailed || score.scoreFailed) return false;
  const ownScore = score.anchor?.ownScore ?? score.apiScore;
  const ownReason = score.anchor ? score.anchor.ownReason : score.apiReason;

  if (anchorScore.apiScore <= ownScore) {
    if (!score.anchor) return false;
    // Anchor no longer outscores the post: back to its own score
    score.apiScore = ownScore;
    score.apiReason = ownReason;
    score.bucket = scoreToBucket(ownScore, 'twitter');
    delete score.anchor;
    return true;
  }

  if (score.anchor && score.anchor.score === anchorScore.apiScore && score.anchor.author === anchor.author) {
    return false;
  }

  score.anchor = {
    kind: anchor.kind,
    author: anchor.author,
    score: anchorScore.apiScore,
    reason: anchorScore.apiReason,
    ownScore,
    ownReason,
  };
  score.apiScore = anchorScore.apiScore;
  score.bucket = scoreToBucket(score.apiScore, 'twitter');
  const verb = anchor.kind === 'quote' ? 'Quotes' : 'Replies to';
  score.apiReason = `${verb} @${anchor.author}'s bait: ${anchorScore.apiReason ?? 'high engagement-bait score'}`;
  return true;
}
