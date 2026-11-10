#!/usr/bin/env node
// Check an export (or a slice) for internal consistency.
//
//   pnpm check-export path/to/tolerance-export.json
//
// Prints what it found and exits 1 if there are errors. The file is read locally and
// nothing is sent anywhere. The rules live in src/shared/export-check.ts.

import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) {
  console.error('usage: pnpm check-export <export.json>');
  process.exit(2);
}

const bundled = await build({
  entryPoints: [join(here, '../src/shared/export-check.ts')],
  bundle: true, format: 'esm', write: false, logLevel: 'silent',
});
const { checkExport, formatReport } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  process.exit(2);
}
const report = checkExport(raw);
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
