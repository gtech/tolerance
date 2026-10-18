#!/usr/bin/env node
// Scoring eval: runs the test cases through the current scoring spec (and,
// with --legacy, the v1 "manipulation" prompt) and reports which scores land
// outside their expected range.
//
// Usage: node scripts/eval/run.mjs [--legacy] [--single] [--model <id>] [--runs N] [--batch N] [--cases <file>]
// Reads the OpenRouter key from OPENROUTER_API_KEY or test_key.env.

import { build } from 'esbuild';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const legacy = args.includes('--legacy');
const model = opt('--model', 'openai/gpt-oss-120b');
const runs = Number(opt('--runs', '1'));
const batchSize = Number(opt('--batch', '10'));
const single = args.includes('--single'); // one call per text post (Twitter did this before batching)
const cases = JSON.parse(readFileSync(opt('--cases', join(here, 'scoring-cases.json')), 'utf8'));

const keyFile = join(root, 'test_key.env');
const key = process.env.OPENROUTER_API_KEY
  || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim().replace(/^[A-Z_]+=/, '') : '');
if (!key) { console.error('No key: set OPENROUTER_API_KEY or create test_key.env'); process.exit(1); }

// Load the spec straight from the extension source
const bundled = await build({
  entryPoints: [join(root, 'src/shared/scoring-spec.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral',
});
const spec = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

// The v1 batch prompt, kept here only for comparison
function legacyPrompt(posts) {
  const list = posts.map((p, i) => {
    const social = p.platform !== 'reddit';
    return `[${i + 1}] ID: ${p.id}
${social ? 'Tweet' : 'Title'}: "${p.text}"
${social ? `Author: ${p.source}` : `Subreddit: r/${p.source}`}
${social ? 'Likes' : 'Upvotes'}: (not yet visible), Comments: 0`;
  }).join('\n\n');
  return `Analyze these social media posts for engagement manipulation tactics.

${list}

For EACH post, rate 1-10 how much it uses psychological manipulation:
- 1-3: Informative, neutral, or genuinely interesting content
- 4-6: Some engagement optimization (catchy title, emotional hook)
- 7-10: Heavy manipulation (outrage bait, curiosity gaps, tribal triggers)

Respond with ONLY a JSON array, one object per post in order:
[{"id": "<post_id>", "score": <1-10>, "reason": "<15 words max>"}, ...]`;
}

function toPost(c) {
  return {
    id: c.id, platform: c.platform, text: c.text, source: c.source, media: c.image ? 'image' : 'text',
    likes: c.platform === 'youtube' ? undefined : null, comments: c.platform === 'youtube' ? undefined : 0,
    length: c.length,
  };
}

// Images go as base64, as in the extension (content script fetches and resizes)
async function dataUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ToleranceEval/1.0' } });
  if (!res.ok) throw new Error(`image ${res.status}: ${url}`);
  const type = res.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

async function call(prompt, image) {
  // Same request shape as the extension's text calls (background/openrouter.ts)
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Title': 'Tolerance eval' },
    body: JSON.stringify({
      model, temperature: 0.3,
      messages: [{ role: 'user', content: image
        ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'low' } }]
        : prompt }],
      max_tokens: image ? 300 : 4000,
      ...(image ? {} : { response_format: { type: 'json_object' } }),
      ...(model === 'openai/gpt-oss-120b' ? { provider: { order: ['groq', 'cerebras'], allow_fallbacks: true } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  const block = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) content = block[1];
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = JSON.parse(content.match(/[[{][\s\S]*[\]}]/)[0]); }
  const items = Array.isArray(parsed) ? parsed : parsed.results || parsed.data || [parsed];
  return { items, usage: data.usage };
}

const scores = new Map(cases.map(c => [c.id, []]));
const reasons = new Map();
const dims = new Map();
const computed = new Map(cases.map(c => [c.id, []]));
let tokens = 0;
const latencies = [];
const imageLatencies = [];
const textCases = cases.filter(c => !c.image);
const imageCases = legacy ? [] : cases.filter(c => c.image);
function record(id, it) {
  if (typeof it.score !== 'number') return;
  scores.get(id).push(it.score);
  reasons.set(id, it.reason);
  const d = spec.parseDims(it);
  if (d) { dims.set(id, d); computed.get(id).push(spec.scoreFromDims(d)); }
}
for (let r = 0; r < runs; r++) {
  // Image posts: one call each, single-post prompt, as scoreImagePost does
  for (const c of imageCases) {
    try {
      const t0 = Date.now();
      const { items, usage } = await call(spec.buildSinglePrompt(toPost(c)), await dataUrl(c.image));
      imageLatencies.push(Date.now() - t0);
      tokens += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
      if (items[0]) record(c.id, items[0]);
    } catch (e) {
      console.error(`${c.id} failed: ${e.message}`);
    }
  }
  if (single && !legacy) {
    // Text posts one call each, single-post prompt, as scoreTextPost does
    await Promise.all(textCases.map(async c => {
      try {
        const t0 = Date.now();
        const { items, usage } = await call(spec.buildSinglePrompt(toPost(c)));
        latencies.push(Date.now() - t0);
        tokens += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
        if (items[0]) record(c.id, items[0]);
      } catch (e) {
        console.error(`${c.id} failed: ${e.message}`);
      }
    }));
    continue;
  }
  for (let i = 0; i < textCases.length; i += batchSize) {
    const batch = textCases.slice(i, i + batchSize);
    const posts = batch.map(toPost);
    // Small batches are padded with calibration posts, as in the extension
    const prompt = legacy ? legacyPrompt(posts) : spec.buildBatchPrompt(spec.withCalibration(posts));
    try {
      const t0 = Date.now();
      const { items, usage } = await call(prompt);
      latencies.push(Date.now() - t0);
      tokens += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
      items.forEach((it, j) => {
        if (spec.isCalibrationId(String(it.id ?? '').trim())) return;
        const id = scores.has(it.id) ? it.id : batch[j]?.id;
        if (id) record(id, it);
      });
    } catch (e) {
      console.error(`batch ${i / batchSize + 1} failed: ${e.message}`);
    }
  }
}

let inRange = 0, scored = 0, absErr = 0, cInRange = 0;
const fit = (v, [lo, hi]) => v >= lo - 0.5 && v <= hi + 0.5;
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\n${legacy ? 'LEGACY v1' : `spec v${spec.SCORING_SPEC_VERSION}`}  model=${model}  runs=${runs}\n`);
for (const c of legacy ? textCases : cases) {
  const s = scores.get(c.id);
  if (!s.length) { console.log(`  ??  ${c.id.padEnd(18)} no score`); continue; }
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const [lo, hi] = c.expect;
  const ok = mean >= lo - 0.5 && mean <= hi + 0.5;
  scored++; if (ok) inRange++;
  absErr += mean < lo ? lo - mean : mean > hi ? mean - hi : 0;
  const d = dims.get(c.id);
  const dimText = d ? ` h${d.hook} e${d.effort} p${d.pull} v${d.value}` : '';
  const comp = computed.get(c.id);
  const cOk = comp.length > 0 && fit(avg(comp), c.expect);
  if (cOk) cInRange++;
  const compText = comp.length ? `computed ${comp.join(',')} ${cOk ? 'ok' : 'XX'}` : '';
  console.log(`  ${ok ? 'ok' : 'XX'}  ${c.id.padEnd(18)} ${s.join(',').padEnd(8)} want ${lo}-${hi}${dimText.padEnd(17)} ${compText.padEnd(22)} ${reasons.get(c.id) ?? ''}`);
}
if (!legacy) console.log(`\nComputed from sub-ratings, in range: ${cInRange}/${scored}`);
console.log(`Model's own score, in range: ${inRange}/${scored}   mean distance outside range: ${(absErr / Math.max(1, scored)).toFixed(2)}   tokens: ${tokens}`);
latencies.sort((a, b) => a - b);
console.log(`Batch latency (${batchSize} posts): median ${latencies[Math.floor(latencies.length / 2)]}ms, max ${latencies[latencies.length - 1]}ms`);
if (imageLatencies.length) {
  imageLatencies.sort((a, b) => a - b);
  console.log(`Image latency: median ${imageLatencies[Math.floor(imageLatencies.length / 2)]}ms, max ${imageLatencies[imageLatencies.length - 1]}ms`);
}
