// The scoring spec: what we ask the model to measure, shared by every scoring
// prompt. Versioned so each stored score records the spec that produced it, and
// scores from an older spec are re-scored rather than mixed with new ones.
//
// v1 asked "how manipulative is this?", which let honest quick hits (a clever
// joke, a cute dog) score low. v2 measures cheap payoff: how hard a post grabs
// attention for how little reading or thinking it asks, and how little it leaves.

// v3: same rubric, but small batches carry calibration posts and Twitter text is
// batched; v2 Twitter text scores (one call each) drifted to 6-7.
// v4: filler is scroll fuel. "No hook at all" no longer lands in 1-3: a throwaway
// reply, in-joke or mundane update costs a glance, leaves nothing and keeps you
// scrolling. Only posts that ask for real attention and repay it score low.
// v5: YouTube titles come with the video's length and are batched 10 at a time;
// whole-page batches flattened lectures and clips alike to 4-6.
export const SCORING_SPEC_VERSION = 5;

export type ScorePlatform = 'reddit' | 'twitter' | 'youtube' | 'instagram' | 'facebook';
export type ScoreMedia = 'text' | 'image' | 'gallery' | 'video' | 'reel';

// Sub-ratings, each 1-10. Stored alongside the score for later analysis.
export interface ScoreDims {
  hook: number;    // Strength of the immediate jolt
  effort: number;  // Reading/context/reasoning needed to get anything (10 = a lot)
  pull: number;    // How much it invites a reaction (like, reply, quote, share)
  value: number;   // What's left after the hit
}

export const RUBRIC = `Measure CHEAP PAYOFF: how hard the post grabs attention for how little reading or thinking it asks, and how little it leaves behind. Feeds are built from quick hits: a laugh, a jolt of outrage, a cute animal, a hot take, a "so true". That is what you are measuring, whether or not the post is honest, kind or clever. The point is to catch what keeps people scrolling.

Rate each from 1 to 10:
- hook: strength of the immediate jolt (humour, outrage, cuteness, lust, envy, fear, awe, novelty, drama about people, "my side is right")
- effort: reading, context or reasoning needed to get anything from it (1 = one glance, 10 = sustained careful reading or thought)
- pull: how much it invites a reaction: like, reply, quote, share, "this is so me", pile-on. Reusable meme formats count.
- value: what remains after the hit. Would a thoughtful person be glad tomorrow that they read it? (useful information, real insight, craft worth slowing down for)

score (1-10), overall cheap payoff. A strong hook for little effort is the core signal; pull raises it; only lasting value lowers it.
- 1-3: asks for real attention and repays it (dense explainers, careful arguments, plain useful information)
- 4-6: a mild hook with real substance, or a weak quick hit
- 7-8: a quick hit: a good joke, a cute animal, a relatable meme, a hot take, a striking image, celebrity or creator drama
- 9-10: built to grab: outrage bait, curiosity gaps ("you won't believe"), engagement farming, tribal pile-ons, shock

Cleverness, humour and wholesomeness do NOT lower the score: a brilliant one-line joke is still a quick hit.
Filler is scroll fuel: a throwaway reply, an in-joke you don't get, "lol", a vague one-liner, a mundane personal update. It costs a glance and leaves nothing, so it keeps the scroll going: 6-7 even with a weak hook. A weak hook never lowers the score; only lasting value does.
When a video's length is given, it is part of the effort: an hour-long lecture, talk or course session asks sustained attention (1-3 even on a hot topic); a two-minute clip asks almost none.
Judge as a regular reader of this feed who follows its topics: in-jokes, jargon and memes from their world land instantly (low effort). Double meanings and innuendo are jokes.

Reference points:
- A thread explaining step by step how database indexes work, with diagrams → 2
- A 2,000-word personal essay on grief → 3
- A news headline stating a policy change plainly → 4
- A reply to a friend: "lmao same, see you there" → 6
- "Repainted the spare room this weekend, going with sage green" → 6
- A photo of a puppy asleep in a teacup → 7
- A relatable "me at 3am" meme → 7
- "BREAKING: what this senator just said should END his career 🧵👇" → 9`;

const MEDIA_NOTES: Record<ScoreMedia, string> = {
  text: '',
  image: 'The image is part of the payoff: a striking, cute, funny, sexy or provocative image is a quick hit even with no text.',
  gallery: 'The image descriptions are part of the payoff: striking, cute, funny or provocative images are quick hits.',
  video: 'You see only a thumbnail or title. Judge what the video promises: a thumbnail or title built to stop the scroll (shocked faces, arrows, cuteness, drama) is a strong hook. A long tutorial or lecture asks for effort.',
  reel: 'Short-form video: quick cuts, "wait for it", trending audio, loops and reactions are hooks. A reel that patiently teaches something asks for more effort.',
};

export interface ScoringPost {
  id?: string;
  platform: ScorePlatform;
  text: string;             // Title, tweet, caption or post text
  source: string;           // Subreddit (no r/), @handle, channel or page name
  likes?: number | null;    // Upvotes/likes; null = not yet visible; undefined = omit
  comments?: number;
  bodyText?: string;        // Reddit self-text / extra post text
  media?: ScoreMedia;
  imageDescriptions?: string;
  length?: string;          // Video length ("1:12:05"), "Short" or "live stream"
}

export interface ScoringTheme {
  name: string;
  description: string;
}

const LABELS: Record<ScorePlatform, { name: string; content: string; source: (s: string) => string; likes?: string }> = {
  reddit: { name: 'Reddit', content: 'Title', source: s => `Subreddit: r/${s.replace(/^r\//, '')}`, likes: 'Upvotes' },
  twitter: { name: 'Twitter', content: 'Tweet', source: s => `Author: ${s}`, likes: 'Likes' },
  youtube: { name: 'YouTube', content: 'Video title', source: s => `Channel: ${s}` },
  instagram: { name: 'Instagram', content: 'Caption', source: s => `Author: ${s}`, likes: 'Likes' },
  facebook: { name: 'Facebook', content: 'Post', source: s => `Author: ${s}`, likes: 'Likes' },
};

const MEDIA_LABELS: Record<ScoreMedia, string> = {
  text: 'text',
  image: 'with image',
  gallery: 'image gallery',
  video: 'video, thumbnail only',
  reel: 'short video',
};

export function platformName(platform: ScorePlatform): string {
  return LABELS[platform].name;
}

function describePost(post: ScoringPost): string {
  const l = LABELS[post.platform];
  const media = post.media ?? 'text';
  const lines: string[] = [`Platform: ${l.name}${media !== 'text' ? ` (${MEDIA_LABELS[media]})` : ''}`];
  const text = post.text.trim();
  lines.push(text ? `${l.content}: "${text}"` : `(No ${l.content.toLowerCase()})`);
  if (post.bodyText?.trim()) lines.push(`Post text: "${post.bodyText.trim()}"`);
  lines.push(l.source(post.source));
  if (post.length) lines.push(`Length: ${post.length}`);
  if (l.likes && post.likes !== undefined) {
    const likes = post.likes === null ? '(not yet visible)' : String(post.likes);
    lines.push(`${l.likes}: ${likes}${post.comments !== undefined ? `, Comments: ${post.comments}` : ''}`);
  }
  if (post.imageDescriptions?.trim()) lines.push(`Image descriptions: ${post.imageDescriptions.trim()}`);
  return lines.join('\n');
}

function mediaNotes(posts: ScoringPost[]): string {
  const kinds = [...new Set(posts.map(p => p.media ?? 'text'))];
  const notes = kinds.map(k => MEDIA_NOTES[k]).filter(Boolean);
  return notes.length ? `\n\n${notes.join('\n')}` : '';
}

function themeSection(themes: ScoringTheme[], batch: boolean): string {
  if (themes.length === 0) return '';
  return `

Also check whether ${batch ? 'each' : 'this'} post matches any of these narrative themes:
${themes.map((t, i) => `${i + 1}. "${t.name}": ${t.description}`).join('\n')}
Include "narratives" with the matching theme numbers, or [] if none match.`;
}

function fields(themes: ScoringTheme[]): string {
  return `"hook": <1-10>, "effort": <1-10>, "pull": <1-10>, "value": <1-10>, "score": <1-10>, "reason": "<15 words max: what grabs attention and what, if anything, it gives back>"${themes.length ? ', "narratives": [<theme numbers>]' : ''}`;
}

export function buildSinglePrompt(post: ScoringPost, themes: ScoringTheme[] = []): string {
  return `Rate this social media post.

${describePost(post)}

${RUBRIC}${mediaNotes([post])}${themeSection(themes, false)}

Respond with ONLY valid JSON: {${fields(themes)}}`;
}

export function buildBatchPrompt(posts: ScoringPost[], themes: ScoringTheme[] = []): string {
  const list = posts.map((p, i) => `[${i + 1}] ID: ${p.id}\n${describePost(p)}`).join('\n\n');
  return `Rate each of these social media posts.

${list}

${RUBRIC}${mediaNotes(posts)}${themeSection(themes, true)}

Respond with ONLY valid JSON, one object per post in order, every object with all of these fields: {"results": [{"id": "<post ID>", ${fields(themes)}}, ...]}`;
}

// Scored alone, a post loses its sense of scale: Gemini 2.5 Flash Lite rated a dense
// technical explainer 6-7 on its own but 2-3 alongside other posts. Small batches are
// padded with these two fixed posts, one at each end of the scale, as a reference;
// their results are discarded.
export const MIN_BATCH_FOR_CONTEXT = 3;
const CALIBRATION_PREFIX = 'calibration-';
const CALIBRATION_TEXTS = [
  { text: 'How TCP congestion control actually works, from slow start to BBR, with the equations and a worked example for each phase. Long thread, 1/14', source: 'netstack_notes' },
  { text: "They want you to forget what happened yesterday. I won't let them. Share before this gets taken down 😡👇", source: 'truth_daily_now' },
];

export function isCalibrationId(id: string | undefined): boolean {
  return !!id && id.startsWith(CALIBRATION_PREFIX);
}

export function withCalibration(posts: ScoringPost[]): ScoringPost[] {
  if (posts.length === 0 || posts.length >= MIN_BATCH_FOR_CONTEXT) return posts;
  const platform = posts[0].platform;
  return [...posts, ...CALIBRATION_TEXTS.map((c, i) => ({
    id: `${CALIBRATION_PREFIX}${i + 1}`,
    platform,
    text: c.text,
    source: platform === 'twitter' || platform === 'instagram' ? `@${c.source}` : c.source,
  }))];
}

const clampRating = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : undefined;

// Sub-ratings from a parsed response object; undefined unless all four are present
export function parseDims(obj: unknown): ScoreDims | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const hook = clampRating(o.hook), effort = clampRating(o.effort);
  const pull = clampRating(o.pull), value = clampRating(o.value);
  if (hook === undefined || effort === undefined || pull === undefined || value === undefined) return undefined;
  return { hook, effort, pull, value };
}

// A score computed from the sub-ratings with fixed weights. Production uses the
// model's own score (with Gemini 2.5 Flash Lite it fitted the eval better, 40/40
// vs 37/40), and falls back to this when the model leaves the score out, which
// Gemini sometimes does for a whole batch. Fitted on the eval with gpt-oss-120b
// sub-ratings: hook and value carry nearly all the signal; effort adds little
// once value is known.
export const SCORE_WEIGHTS = { base: 5, hook: 0.5, effort: 0, pull: 0, value: -0.75 };

export function scoreFromDims(d: ScoreDims, w = SCORE_WEIGHTS): number {
  const raw = w.base + w.hook * (d.hook - 5) + w.effort * (d.effort - 5) + w.pull * (d.pull - 5) + w.value * (d.value - 5);
  return Math.min(10, Math.max(1, Math.round(raw)));
}

// The 1-10 score from a parsed response item: the model's own score, else one
// computed from its sub-ratings. Undefined when neither is usable, so the post is
// left unscored (and re-scored) rather than given a made-up number. (A missing
// score used to become NaN, which reached the page as 0.)
export function readScore(item: unknown): number | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const raw = (item as Record<string, unknown>).score;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(n)) return Math.min(10, Math.max(1, n));
  const dims = parseDims(item);
  return dims ? scoreFromDims(dims) : undefined;
}
