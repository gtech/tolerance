// Checks that an export (or a slice of one) is internally consistent: every record has
// the fields it should, values are in range, and the things that must agree do agree.
//
// The rules are the checks first done by hand on a real day of data in November 2026,
// written down so they run on every export from now on. The history is only worth
// analysing, alone or pooled with other people's, if it can be trusted, and a logging
// bug is much cheaper to catch the day it starts than months later.
//
// "error" means the record is wrong and something wrote it incorrectly. "warning" means
// it is unusual but can happen legitimately; the message says when.
//
// Findings name post and session ids only, never post text.

export type Severity = 'error' | 'warning';

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  count: number;
  examples: string[];   // up to 5 ids
}

export interface ExportReport {
  ok: boolean;          // no errors (warnings allowed)
  errors: number;       // records failing an error rule, summed over rules
  warnings: number;
  findings: Finding[];  // errors first, then by count
  counts: { sessions: number; posts: number; newFormatPosts: number; postContent: number; calibration: number };
}

const BUCKETS = new Set(['low', 'medium', 'high']);
const LOGGED_PLATFORMS = new Set(['reddit', 'twitter', 'youtube', 'instagram', 'facebook']);
const CONTENT_PLATFORMS = new Set(['reddit', 'twitter', 'youtube', 'instagram', 'facebook']);
const DIMS = ['hook', 'effort', 'pull', 'value'] as const;
const SPONSORED = '[Sponsored] ';
const AI_LABELED = '[Labeled AI-generated] ';
const MINUTE = 60_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const inRange = (v: unknown, lo: number, hi: number): boolean => num(v) && v >= lo && v <= hi;
const str = (v: unknown): v is string => typeof v === 'string';
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function checkExport(raw: unknown): ExportReport {
  const found = new Map<string, Finding>();
  const flag = (rule: string, severity: Severity, message: string, id: unknown): void => {
    let f = found.get(rule);
    if (!f) found.set(rule, f = { rule, severity, message, count: 0, examples: [] });
    f.count++;
    if (f.examples.length < 5) f.examples.push(String(id));
  };
  const counts = { sessions: 0, posts: 0, newFormatPosts: 0, postContent: 0, calibration: 0 };
  const done = (): ExportReport => {
    const findings = [...found.values()].sort((a, b) =>
      (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
    const total = (s: Severity) => findings.filter(f => f.severity === s).reduce((n, f) => n + f.count, 0);
    return { ok: total('error') === 0, errors: total('error'), warnings: total('warning'), findings, counts };
  };

  if (!isRec(raw) || !Array.isArray(raw.sessions)) {
    flag('export.shape', 'error', 'Not an export: there is no "sessions" list', 'export');
    return done();
  }
  const specNow = raw.scoringSpecVersion;
  if (specNow !== undefined && !(num(specNow) && specNow >= 1)) {
    flag('export.spec-version', 'error', 'scoringSpecVersion is not a positive number', 'export');
  }
  const exportedAt = str(raw.exportDate) ? Date.parse(raw.exportDate) : NaN;
  const tooLate = (t: unknown): boolean => num(t) && Number.isFinite(exportedAt) && t > exportedAt + 5 * MINUTE;
  const topics = new Set(list(raw.topics).filter(isRec).map(t => String(t.id)));

  // ---------- sessions and the posts logged in them ----------
  const sessionIds = new Set<string>();
  const scoreOf = new Map<string, { score: number; failed: boolean }>();   // latest logged score per post
  const byDay = new Map<number, { all50: boolean; ids: string[] }>();

  for (const s of raw.sessions) {
    counts.sessions++;
    if (!isRec(s) || !str(s.sessionId) || !num(s.startTime) || !Array.isArray(s.posts)) {
      flag('session.shape', 'error', 'Session is missing its id, start time or post list', isRec(s) ? s.sessionId : 'session');
      continue;
    }
    const sid = s.sessionId;
    if (sessionIds.has(sid)) flag('session.duplicate-id', 'error', 'Two sessions share an id', sid);
    sessionIds.add(sid);
    if (s.mode !== 'baseline' && s.mode !== 'active') flag('session.shape', 'error', 'Session is missing its id, start time or post list', sid);
    if (s.endTime !== undefined && !(num(s.endTime) && s.endTime >= s.startTime)) {
      flag('session.end-before-start', 'error', 'Session ends before it starts', sid);
    }
    if (tooLate(s.startTime)) flag('export.future', 'error', 'A record is dated after the export was made', sid);

    // The per-bucket totals are written in the same step as the posts, so they must match
    const tally: Record<string, number> = { high: 0, medium: 0, low: 0 };
    const seenAt = new Set<string>();

    for (const p of s.posts) {
      counts.posts++;
      if (!isRec(p) || !num(p.timestamp) || !str(p.postId) || !p.postId || !num(p.score) || !BUCKETS.has(p.bucket as string) ||
          !num(p.position) || !num(p.originalPosition) || !str(p.subreddit) || typeof p.wasReordered !== 'boolean') {
        flag('post.shape', 'error', 'Logged post is missing a basic field (time, id, score, bucket, position or source)', isRec(p) ? p.postId : sid);
        continue;
      }
      const id = p.postId;
      tally[p.bucket as string]++;
      if (!inRange(p.score, 0, 100)) flag('post.score-range', 'error', 'Score is outside 0 to 100', id);
      if (p.timestamp < s.startTime - MINUTE) flag('post.before-session', 'error', 'Post was logged before its session started', id);
      if (num(s.endTime) && p.timestamp > s.endTime + MINUTE) {
        flag('post.after-session-end', 'warning', 'Post is dated after its session ended (possible if the clock changed)', id);
      }
      if (tooLate(p.timestamp)) flag('export.future', 'error', 'A record is dated after the export was made', id);
      // A YouTube Short in a shelf names no channel on the page, so an empty source is right for it
      if (!p.subreddit && p.short !== true) flag('post.source-empty', 'warning', 'Post has no source (subreddit, account or channel); the scraper found none', id);
      if (p.short !== undefined && (p.short !== true || p.platform !== 'youtube')) flag('post.short', 'error', 'Only a YouTube post can be marked as a Short, and the mark is only ever true', id);

      const key = `${id}@${p.timestamp}`;
      if (seenAt.has(key)) flag('post.duplicate', 'warning', 'The same post was logged twice at the same instant in one session', id);
      seenAt.add(key);

      const failed = p.scoreFailed === true;
      if (p.scoreFailed !== undefined && typeof p.scoreFailed !== 'boolean') flag('post.failed-score', 'error', 'A failed score must be the placeholder 50 with no sub-scores', id);
      if (failed && (p.score !== 50 || p.dims !== undefined)) flag('post.failed-score', 'error', 'A failed score must be the placeholder 50 with no sub-scores', id);

      if (p.dims !== undefined) {
        const d = p.dims;
        if (!isRec(d) || !DIMS.every(k => Number.isInteger(d[k]) && inRange(d[k], 1, 10))) {
          flag('post.dims-range', 'error', 'Sub-scores must be four whole numbers from 1 to 10', id);
        }
      }
      if (p.modelScore !== undefined) {
        if (!inRange(p.modelScore, 0, 100)) flag('post.model-score', 'error', 'The model\'s own score is outside 0 to 100', id);
        else if (!p.narrativeThemeId) flag('post.model-score-untagged', 'warning', 'A separate model score is recorded but no topic is named as having changed it', id);
      }
      if (p.imageSeen !== undefined && typeof p.imageSeen !== 'boolean') flag('post.image-seen', 'error', 'imageSeen must be true or false', id);

      if (p.dwellMs !== undefined || p.maxContinuousDwellMs !== undefined || p.viewportEnters !== undefined) {
        if (!inRange(p.dwellMs, 0, Infinity) || !inRange(p.maxContinuousDwellMs, 0, Infinity) || !inRange(p.viewportEnters, 0, Infinity)) {
          flag('post.dwell', 'error', 'Time on screen has a missing or negative value', id);
        } else if ((p.maxContinuousDwellMs as number) > (p.dwellMs as number) + 1) {
          // The longest stretch is measured from when the post came into view; the total is
          // the sum of updates. A total below it means an update never reached the log.
          flag('post.dwell-lost', 'warning', 'Longest stretch on screen exceeds the total, so part of the time was never recorded (updates sent before the post was logged were dropped until November 2026; still possible across a session change or a background restart)', id);
        } else if ((p.dwellMs as number) > 30 * MINUTE) {
          flag('post.dwell-long', 'warning', 'Post was on screen for over 30 minutes (a tab left open, or the tracker failing to stop)', id);
        }
      }

      if (p.narrativeThemeId !== undefined && topics.size > 0 && !topics.has(String(p.narrativeThemeId))) {
        flag('post.topic-unknown', 'warning', 'Post names a topic that is not in the export\'s topic list (the topic was deleted since)', id);
      }

      // Fields logged since November 2026. A post has all of them or none.
      if (p.platform !== undefined) {
        counts.newFormatPosts++;
        if (!LOGGED_PLATFORMS.has(p.platform as string)) flag('post.platform', 'error', 'Platform is not one that logs posts', id);
        if (!inRange(p.blurThreshold, 0, 100) || typeof p.blurred !== 'boolean') {
          flag('post.threshold', 'error', 'Post is missing the blur threshold in force or whether it was blurred', id);
        } else if (p.blurred && p.score < (p.blurThreshold as number)) {
          flag('post.blur-below-threshold', 'warning', 'Post was blurred although its score is under the threshold (expected only in subscriptions-only mode)', id);
        }
        const hasSpec = num(p.specVersion) && p.specVersion >= 1;
        if (!hasSpec && !failed) flag('post.spec', 'warning', 'Post has neither a scoring spec version nor a failed-score flag, so its score can\'t be placed', id);
        if (hasSpec && num(specNow) && specNow >= 1 && (p.specVersion as number) > specNow) flag('post.spec-ahead', 'error', 'Post claims a newer scoring spec than the extension that exported it', id);
        if (hasSpec && !failed && p.dims === undefined) flag('post.dims-missing', 'warning', 'Scored post has no sub-scores (the model left them out)', id);
        if (p.platform === 'twitter' && p.subreddit && !p.subreddit.startsWith('@')) flag('post.source-format', 'error', 'A Twitter post\'s source should be an @handle', id);
      } else if (p.blurThreshold !== undefined || p.blurred !== undefined) {
        flag('post.threshold', 'error', 'Post is missing the blur threshold in force or whether it was blurred', id);
      }

      scoreOf.set(id, { score: p.score, failed });
      const day = Math.floor(p.timestamp / 86_400_000);
      const d = byDay.get(day) ?? { all50: true, ids: [] };
      if (p.score !== 50) d.all50 = false;
      d.ids.push(id);
      byDay.set(day, d);
    }

    const dist = s.engagementDistribution;
    if (!isRec(dist) || dist.high !== tally.high || dist.medium !== tally.medium || dist.low !== tally.low) {
      flag('session.distribution', 'error', 'Session\'s low/medium/high totals do not match its posts', sid);
    }

    let lastMinute = -Infinity;
    for (const b of list(s.scroll)) {
      if (!isRec(b) || !Number.isInteger(b.minute) || !inRange(b.scrolledPx, 0, Infinity) ||
          !inRange(b.maxVelocityPxS, 0, Infinity) || !inRange(b.scrollActiveMs, 0, Infinity)) {
        flag('session.scroll', 'error', 'Scroll record has a missing or negative value', sid);
        continue;
      }
      if ((b.scrollActiveMs as number) > MINUTE + 1000) flag('session.scroll', 'error', 'Scroll record has a missing or negative value', sid);
      if ((b.minute as number) <= lastMinute) flag('session.scroll-order', 'error', 'Scroll minutes are out of order or repeated within a session', sid);
      lastMinute = b.minute as number;
    }
  }

  for (const d of byDay.values()) {
    if (d.all50 && d.ids.length >= 5) {
      for (const id of d.ids) flag('post.flat-day', 'warning', 'Every post that day is logged as 50: from before real scores were stored (17 Feb 2026), or a day when all scoring failed', id);
    }
  }

  // ---------- stored post text ----------
  const contentIds = new Set<string>();
  for (const c of list(raw.postContent)) {
    counts.postContent++;
    if (!isRec(c) || !str(c.postId) || !c.postId || !CONTENT_PLATFORMS.has(c.platform as string) || !num(c.timestamp) || !str(c.text)) {
      flag('content.shape', 'error', 'Stored post is missing its id, platform, time or text', isRec(c) ? c.postId : 'content');
      continue;
    }
    const id = c.postId;
    if (contentIds.has(id)) flag('content.duplicate', 'error', 'A post is stored twice (the store is keyed by post id)', id);
    contentIds.add(id);
    if (tooLate(c.timestamp)) flag('export.future', 'error', 'A record is dated after the export was made', id);
    if (c.imageHash !== undefined && !(str(c.imageHash) && /^[0-9a-f]{16}$/.test(c.imageHash))) {
      flag('content.image-hash', 'error', 'Image fingerprint is not 16 hex characters', id);
    }
    if (c.imageDescription !== undefined && !(str(c.imageDescription) && c.imageDescription.trim() && c.imageDescription.length <= 300)) {
      flag('content.image-description', 'error', 'Image description is empty or over 300 characters', id);
    }
    if (c.imageSeen !== undefined && typeof c.imageSeen !== 'boolean') flag('content.image-seen', 'error', 'imageSeen must be true or false', id);
    if (c.imageSeen === false && (c.imageDescription !== undefined || c.imageHash !== undefined)) {
      flag('content.image-unseen', 'error', 'Post has an image description or fingerprint although the model did not see its image', id);
    }
    if (c.imageSeen === true && (c.imageHash === undefined || c.imageDescription === undefined)) {
      flag('content.image-incomplete', 'warning', 'The model saw the image but the post lacks a description or fingerprint (stored before those existed, or the model left the description out)', id);
    }
    for (const k of ['imageUrl', 'thumbnailUrl'] as const) {
      if (str(c[k]) && (c[k] as string).startsWith('data:')) flag('content.data-url', 'warning', 'An image is stored inline with the post, which bloats the database; only its link should be kept', id);
    }

    // A post the site marked as sponsored or AI-generated is given the top score in code
    const text = (str(c.title) && c.title ? c.title : c.text) as string;
    const logged = scoreOf.get(id);
    if (logged && !logged.failed && logged.score < 100) {
      const rest = text.startsWith(AI_LABELED) ? text.slice(AI_LABELED.length) : text;
      if (rest.startsWith(SPONSORED)) flag('label.sponsored-low', 'warning', 'A post the site marked as sponsored was logged under 100 (expected only before November 2026, or with the ads setting off)', id);
      else if (text.startsWith(AI_LABELED)) flag('label.ai-low', 'warning', 'A post the site labeled AI-generated was logged under 100 (expected only with that setting off)', id);
    }
  }

  // ---------- calibration log ----------
  const calibrationIds = new Set<string>();
  for (const c of list(raw.calibration)) {
    counts.calibration++;
    if (!isRec(c) || !str(c.postId) || !c.postId || !num(c.timestamp) || !num(c.apiScore)) {
      flag('calibration.shape', 'error', 'Calibration entry is missing its id, time or score', isRec(c) ? c.postId : 'calibration');
      continue;
    }
    if (calibrationIds.has(c.postId)) flag('calibration.duplicate', 'error', 'A post appears twice in the calibration log', c.postId);
    calibrationIds.add(c.postId);
    if (!inRange(c.apiScore, 0, 100)) flag('calibration.score-range', 'error', 'Calibration score is outside 0 to 100', c.postId);
    for (const k of ['imageUrl', 'thumbnailUrl'] as const) {
      if (str(c[k]) && (c[k] as string).startsWith('data:')) flag('calibration.data-url', 'error', 'Calibration entry holds an inline image; these are stripped before saving', c.postId);
    }
  }

  // ---------- minutes per day ----------
  if (raw.minutesByDay !== undefined) {
    if (!isRec(raw.minutesByDay)) flag('minutes.shape', 'error', 'Minutes per day must be dated YYYY-MM-DD with a value from 0 to 1440', 'minutesByDay');
    else for (const [day, minutes] of Object.entries(raw.minutesByDay)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !inRange(minutes, 0, 1440)) {
        flag('minutes.shape', 'error', 'Minutes per day must be dated YYYY-MM-DD with a value from 0 to 1440', day);
      }
    }
  }

  return done();
}

// A plain-text summary for the command line
export function formatReport(report: ExportReport): string {
  const c = report.counts;
  const lines = [
    `${c.sessions} sessions, ${c.posts} logged posts (${c.newFormatPosts} with the newer fields), ${c.postContent} stored texts, ${c.calibration} calibration entries.`,
    report.findings.length === 0 ? 'No problems found.'
      : `${report.errors} error${report.errors === 1 ? '' : 's'}, ${report.warnings} warning${report.warnings === 1 ? '' : 's'}.`,
  ];
  for (const f of report.findings) {
    lines.push(`  ${f.severity.toUpperCase().padEnd(7)} ${f.rule}  x${f.count}`);
    lines.push(`          ${f.message}`);
    lines.push(`          e.g. ${f.examples.join(', ')}`);
  }
  return lines.join('\n');
}
