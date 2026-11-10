// Recognising a site's own "this is AI-generated" label on a post.
//
// Sites show these as a short piece of interface text on the post: Meta's "AI info",
// TikTok's "Creator labeled as AI-generated", YouTube's "Altered or synthetic content".
// A piece of text counts only if it is exactly one of these, so a post that talks about
// AI-generated content in its own words is not mistaken for a labeled one.

const LABELS = new Set([
  'ai info',
  'made with ai',
  'imagined with ai',
  'ai-generated',
  'ai generated',
  'ai-generated content',
  'labeled as ai-generated',
  'creator labeled as ai-generated',
  'contains ai-generated media',
  'altered or synthetic content',
]);

export function isAiLabelText(text: string | null | undefined): boolean {
  if (!text) return false;
  const tidy = text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.:]$/, '');
  return tidy.length <= 40 && LABELS.has(tidy);
}
