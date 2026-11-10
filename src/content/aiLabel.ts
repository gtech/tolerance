import { isAiLabelText } from '../shared/ai-label';
import { AI_LABEL_PREFIX } from '../shared/scoring-spec';

// Whether the site has put its own AI-generated label on this post. It looks for a
// standalone piece of text (or an accessibility label) that is exactly a known label,
// wherever in the post it sits, so it doesn't depend on each site's markup.
export function hasAiLabel(post: Element): boolean {
  for (const el of post.querySelectorAll('[aria-label]')) {
    if (isAiLabelText(el.getAttribute('aria-label'))) return true;
  }
  const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isAiLabelText(node.nodeValue)) return true;
  }
  return false;
}

// The post's text with the label marker in front when the site labeled it, so the
// scoring model can't miss it
export function withAiLabel(post: Element, text: string): string {
  return hasAiLabel(post) ? `${AI_LABEL_PREFIX}${text}` : text;
}
