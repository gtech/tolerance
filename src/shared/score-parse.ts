// Reason the old fallback (first number anywhere in the reply) stored. Those scores
// are often wrong, so cached ones are ignored and re-scored.
export const LEGACY_FALLBACK_REASON = 'Extracted from non-JSON response';

// Last-resort score extraction when a model reply isn't valid JSON (truncated
// JSON, prose, etc). Only an explicitly labelled score counts: a bare number
// anywhere in the text ("1 person in the image") must not become the score.
export function extractScoreFromText(content: string): { score: number; reason: string } | null {
  const patterns = [
    /"score"\s*:\s*(\d+(?:\.\d+)?)/i,          // broken / truncated JSON
    /\bscore\b\s*(?:is|of|=|:)?\s*(\d+(?:\.\d+)?)/i, // "Score: 7", "score of 7"
    /\b(\d+(?:\.\d+)?)\s*\/\s*10\b/,           // "7/10"
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (!match) continue;
    const score = Math.round(parseFloat(match[1]));
    if (score < 1 || score > 10) continue;
    const reason = content.match(/"reason"\s*:\s*"([^"]*)/i)?.[1]?.trim();
    return { score, reason: reason || 'Score read from non-JSON response' };
  }
  return null;
}
