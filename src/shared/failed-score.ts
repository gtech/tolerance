// What a failed score's "?" badge says. A score can fail because the key hit a limit
// (allowance used up, key rejected) or because one request went wrong (the model's
// provider was busy, the reply was unreadable). Only the first is the user's to fix.

export interface FailedScoreNotice {
  text: string;
  opensAccount: boolean; // clicking the badge opens the account page
}

export function describeFailedScore(ownKey: boolean, keyProblem: boolean, reason?: string): FailedScoreNotice {
  if (keyProblem) {
    return ownKey
      ? { text: 'Your API key was refused. Check its spend limit and credits in the dashboard.', opensAccount: false }
      : { text: 'Free tier exhausted. Click to upgrade to Pro, or use your own API key.', opensAccount: true };
  }
  const detail = (reason ?? '').replace(/^Scoring failed:\s*/, '').trim();
  return {
    text: `This post could not be scored${detail ? ` (${detail})` : ''}. One request failed; your key and allowance are fine.`,
    opensAccount: false,
  };
}
