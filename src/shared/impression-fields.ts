import type { EngagementScore, PostImpression } from './types';

// The parts of a logged impression that come from the post's score. The cached score
// itself is deleted after a day, so anything worth analysing later has to be copied
// onto the impression here.
export function impressionScoreFields(
  score: EngagementScore | undefined
): Pick<PostImpression, 'score' | 'bucket' | 'narrativeThemeId' | 'specVersion' | 'dims' | 'scoreFailed' | 'modelScore' | 'imageSeen'> {
  const failed = !score || !!score.scoreFailed;
  return {
    // A post that could not be scored has no score. (Before 28 Nov 2026 it was logged
    // as a placeholder 50, told apart only by scoreFailed.)
    score: failed ? null : score.apiScore,
    bucket: score?.bucket ?? 'medium',
    narrativeThemeId: score?.factors?.narrative?.themeId,
    specVersion: score?.specVersion,
    dims: failed ? undefined : score.dims,
    scoreFailed: failed ? true : undefined,
    modelScore: score?.modelScore,
    imageSeen: score?.imageSeen,
  };
}
