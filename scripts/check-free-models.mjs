#!/usr/bin/env node
// Release check: every model this version asks for by default must be on the live
// allowlist for free keys, or free users' scoring fails the moment they update.
//
// Free keys are restricted to a list of models by the Tolerance server (an OpenRouter
// guardrail). This asks the server what OpenRouter is enforcing right now and compares
// it with FREE_KEY_MODELS in src/shared/provider-models.ts.
//
// Usage: node scripts/check-free-models.mjs   (or: pnpm check:models)
// Exits 0 when every model is allowed, 1 otherwise, including when the list can't
// be read: a release should not go out unchecked.

import { build } from 'esbuild';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST_URL = process.env.TOLERANCE_API
  ? `${process.env.TOLERANCE_API}/api/free/allowed-models`
  : 'https://api.tolerance.lol/api/free/allowed-models';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

function fail(message) {
  console.error(`\nModel check FAILED: ${message}\n`);
  process.exit(1);
}

async function getJson(url, what) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    fail(`could not reach ${what} (${url}): ${error.message}`);
  }
  if (!response.ok) fail(`${what} answered ${response.status} (${url})`);
  return response.json();
}

// The list straight from the extension source
const bundled = await build({
  entryPoints: [join(root, 'src/shared/provider-models.ts')],
  bundle: true, format: 'esm', write: false, platform: 'neutral',
});
const { FREE_KEY_MODELS } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

const [{ models: allowed }, { data: catalogue }] = await Promise.all([
  getJson(ALLOWLIST_URL, 'the Tolerance server'),
  getJson(MODELS_URL, 'OpenRouter'),
]);
if (!Array.isArray(allowed) || allowed.length === 0) fail('the server returned no allowlist');

// OpenRouter stores the allowlist under each model's dated name, so
// deepseek/deepseek-v4.1-flash-1017 is listed as deepseek/deepseek-v4.1-flash-20261017
const datedName = new Map(catalogue.map(model => [model.id, model.canonical_slug]));
const allowedSet = new Set(allowed);

const missing = [];
for (const model of FREE_KEY_MODELS) {
  const dated = datedName.get(model);
  if (!dated) {
    console.log(`  XX  ${model}  (OpenRouter does not list this model)`);
    missing.push(model);
  } else if (allowedSet.has(model) || allowedSet.has(dated)) {
    console.log(`  ok  ${model}`);
  } else {
    console.log(`  XX  ${model}  (not on the free-key allowlist)`);
    missing.push(model);
  }
}

if (missing.length > 0) {
  fail(`free keys cannot call ${missing.join(', ')}.\n`
    + 'Add it to FREE_KEY_ALLOWED_MODELS in api/src/guardrail.ts, deploy and restart the API, then run this again.');
}
console.log('\nEvery default model is allowed for free keys.');
