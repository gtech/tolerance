import type { EngagementScore, PostImpression } from './types';

// The parts of a logged impression that come from the post's score. The cached score
// itself is deleted after a day, so anything worth analysing later has to be copied
// onto the impression here.
export function impressionScoreFields(
  score: EngagementScore | undefined
): Pick<PostImpression, 'score' | 'bucket' | 'narrativeThemeId' | 'specVersion' | 'dims' | 'scoreFailed' | 'imageSeen'> {
  return {
    score: score?.apiScore ?? 50,
    bucket: score?.bucket ?? 'medium',
    narrativeThemeId: score?.factors?.narrative?.themeId,
    specVersion: score?.specVersion,
    dims: score?.dims,
    // Without this a failed score looks the same as a real 50
    scoreFailed: !score || score.scoreFailed ? true : undefined,
    imageSeen: score?.imageSeen,
  };
}
