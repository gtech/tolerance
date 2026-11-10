// Reading the small pieces of text on a YouTube video card. Kept free of the DOM so the
// rules can be tested: YouTube changes its markup and wording often, and when a rule
// stops matching nothing breaks visibly, the scorer just quietly loses the signal.
//
// As captured in November 2026, a card's metadata reads "36K" and "2d ago" on screen,
// with the long form in an accessibility label: "36 thousand views", "2 days ago".

const UNITS: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

// "1.2M views", "123K views", "1,234 views", "36 thousand views"; 0 when there is none
export function parseViewCount(text: string): number {
  const match = text.match(/([\d,.]+)\s*(thousand|million|billion|[KMB])?\s*views?/i);
  if (!match) return 0;
  const num = parseFloat(match[1].replace(/,/g, ''));
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * (UNITS[(match[2] || '').toLowerCase()] ?? 1));
}

// "2 days ago", "3 months ago", "Streamed 2 hours ago"
export function parseUploadDate(text: string): string | undefined {
  const match = text.match(/(\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i);
  if (match) return match[1];
  return text.match(/Streamed\s+(\d+\s+\w+\s+ago)/i)?.[1];
}

// A card can carry several badges ("12:34", "LIVE", "Sponsored", "New"). The length is
// the one that reads as a time.
export function pickDuration(badgeTexts: string[]): string | undefined {
  return badgeTexts.map(t => t.trim()).find(t => /^\d+(:\d{2})+$/.test(t));
}

// Whether a piece of card metadata is a view count, a date or a live count, as opposed
// to a channel name. Sidebar cards show the channel as plain text in the same style as
// those, so this is how the two are told apart.
export function isCountOrDate(text: string): boolean {
  const t = text.trim();
  return !t || /\bviews?\b|\bwatching\b|\bago\b|\bstreamed\b|\bpremier/i.test(t) || /^[\d.,]+\s*[KMB]?$/i.test(t);
}
