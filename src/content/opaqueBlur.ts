// Solid gray overlay. Set as inline !important: some platform stylesheets
// (Reddit, Instagram, Facebook) give the overlay background !important,
// which beats a plain inline style.
export function setOpaque(overlay: HTMLElement, on: boolean): void {
  if (on) overlay.style.setProperty('background', 'rgb(140, 140, 140)', 'important');
  else overlay.style.removeProperty('background');
}
