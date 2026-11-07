import type { Settings } from '../shared/types';

// The gate shown before scoring follows the Opaque Blur setting. Settings aren't known
// at first paint, so it starts opaque (the default) and this class turns that off.
export function syncGateOpacity(settings: Partial<Settings> | null | undefined): void {
  document.documentElement.classList.toggle('tolerance-gate-translucent', settings?.twitter?.opaqueBlur === false);
}

// Solid gray cover over gated items, the same gray as the blur overlay (opaqueBlur.ts)
// so the hand-off to it doesn't show. `scope` is the html class that switches the gate
// on, if any. `shift` moves it up to line up with overlays that sit offset on a platform.
export function opaqueGateCss(
  scope: string,
  selectors: string[],
  { relative = true, shift = 0, zIndex = 100 }: { relative?: boolean; shift?: number; zIndex?: number } = {}
): string {
  const root = `html${scope ? `.${scope}` : ''}:not(.tolerance-gate-translucent)`;
  const covers = selectors.map(sel => `${root} ${sel}::after`).join(',\n');
  // The cover needs the item as its containing block. contain: layout does that without
  // changing position, for items laid out by position (X's virtualized timeline cells).
  const container = `${selectors.map(sel => `${root} ${sel}`).join(',\n')} { ${relative ? 'position: relative' : 'contain: layout'}; }`;
  return `${container}
  ${covers} {
    content: '';
    position: absolute;
    top: ${-shift}px;
    left: 0;
    right: 0;
    bottom: ${shift}px;
    background: rgb(140, 140, 140);
    z-index: ${zIndex};
  }`;
}
