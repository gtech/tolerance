// The solid cover over a blurred post takes the colour of whatever the post sits on
// (the page on Twitter and YouTube, the white card on LinkedIn and Facebook), so a
// covered post reads as a quiet gap rather than a gray box asking to be opened. The
// text on it is a muted version of the page's own text colour.
//
// The colours live in two properties on <html>, read by every site's cover and by the
// gate shown before scoring. Until a post has been measured they fall back to the
// browser's own page colours.

export const COVER_BACKGROUND = 'var(--tolerance-cover, Canvas)';
export const COVER_INK = 'var(--tolerance-cover-ink, color-mix(in srgb, CanvasText 55%, Canvas))';

const REMEASURE_MS = 1000;
let measuredAt = 0;
let lastPost: Element | null = null;
let watching = false;

function parse(color: string): [number, number, number, number] | null {
  const m = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

// The first solid background colour at or above the element
function backgroundBehind(start: Element | null): [number, number, number] | null {
  for (let node = start; node; node = node.parentElement) {
    const rgba = parse(getComputedStyle(node).backgroundColor);
    if (rgba && rgba[3] > 0.9) return [rgba[0], rgba[1], rgba[2]];
  }
  return null;
}

// With no solid colour anywhere behind the post (YouTube's light theme), the properties
// are cleared and the browser's page colours stand in.
function apply(rgb: [number, number, number] | null): void {
  const root = document.documentElement.style;
  if (!rgb) {
    root.removeProperty('--tolerance-cover');
    root.removeProperty('--tolerance-cover-ink');
    return;
  }
  const [r, g, b] = rgb;
  const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  root.setProperty('--tolerance-cover', `rgb(${r}, ${g}, ${b})`);
  root.setProperty('--tolerance-cover-ink', dark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(0, 0, 0, 0.55)');
}

// Called with each post that gets a cover. Measures at most once a second: every post
// in a feed sits on the same colour, so one reading serves them all.
export function matchCoverTo(post: Element | null): void {
  const now = Date.now();
  if (!post || now - measuredAt < REMEASURE_MS) return;
  measuredAt = now;
  lastPost = post;
  apply(backgroundBehind(post));
}

// A first reading from the page itself, and a fresh one whenever the site or the
// system switches between light and dark.
export function watchPageColours(): void {
  if (watching) return;
  watching = true;

  const fromPage = () => {
    if (measuredAt === 0) apply(backgroundBehind(document.body));
  };
  // Read again from the last covered post, which may sit on a card of another colour
  // than the page; the page itself if that post has since left it
  const themeChanged = () => {
    measuredAt = 0;
    apply(backgroundBehind(lastPost?.isConnected ? lastPost : document.body));
  };

  const watchTheme = () => {
    fromPage();
    // Sites keep their theme in a class, attribute or inline style on <html> or <body>.
    // Our own properties are written to <html>'s style, so that one is left out.
    const observer = new MutationObserver(themeChanged);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'dark', 'data-theme', 'data-color-mode'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  };
  if (document.body) watchTheme();
  else document.addEventListener('DOMContentLoaded', watchTheme, { once: true });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);
}

// The look of a solid cover's text. Each site styles its own label as a dark pill, which
// the see-through blur still needs to stay readable; `root` limits this to solid covers.
export function quietCoverCss(root: string): string {
  const label = `${root} .tolerance-blur-overlay > .tolerance-blur-label`;
  return `
    ${label} {
      background: none !important;
      box-shadow: none !important;
      border-radius: 0 !important;
      padding: 0 !important;
      color: ${COVER_INK} !important;
      font-size: 14px !important;
      font-weight: 400 !important;
      line-height: 1.45 !important;
      max-width: min(80%, 44ch) !important;
      text-align: center !important;
      text-wrap: balance;
    }
    /* A small arrow under the text: the way on is down */
    ${root} :not(.tolerance-pending) > .tolerance-blur-overlay > .tolerance-blur-label::after {
      content: '';
      display: block;
      width: 7px;
      height: 7px;
      margin: 10px auto 0;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      opacity: 0.6;
    }
    /* "Hover to reveal" only shows once the pointer is on the cover */
    ${root} .tolerance-blur-overlay::after {
      color: ${COVER_INK} !important;
      text-shadow: none !important;
      font-size: 12px !important;
      font-weight: 400 !important;
      opacity: 0;
      transition: opacity 0.2s ease;
    }
    ${root} .tolerance-blur-overlay:hover::after {
      opacity: 1;
    }
  `;
}
