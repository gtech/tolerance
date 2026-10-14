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
// score is max(own, anchor). No-op if the anchor scored lower.
export function foldAnchorScore(
  score: EngagementScore,
  anchor: TweetAnchor,
  anchorScore: EngagementScore
): void {
  if (anchorScore.scoreFailed || score.scoreFailed) return;
  if (anchorScore.apiScore <= score.apiScore) return;

  score.anchor = {
    kind: anchor.kind,
    author: anchor.author,
    score: anchorScore.apiScore,
    reason: anchorScore.apiReason,
    ownScore: score.apiScore,
  };
  score.apiScore = anchorScore.apiScore;
  score.bucket = scoreToBucket(score.apiScore, 'twitter');
  const verb = anchor.kind === 'quote' ? 'Quotes' : 'Replies to';
  score.apiReason = `${verb} @${anchor.author}'s bait: ${anchorScore.apiReason ?? 'high engagement-bait score'}`;
}
