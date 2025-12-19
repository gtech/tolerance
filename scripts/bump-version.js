#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';

const version = process.argv[2];

if (!version) {
  console.error('Usage: node scripts/bump-version.js <version>');
  console.error('Example: node scripts/bump-version.js 0.1.1');
  process.exit(1);
}

// Validate version format
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Error: Version must be in format X.Y.Z (e.g., 0.1.1)');
  process.exit(1);
}

const files = ['package.json', 'manifest.json', 'manifest.firefox.json'];

for (const file of files) {
  const content = JSON.parse(readFileSync(file, 'utf8'));
  const oldVersion = content.version;
  content.version = version;
  writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
  console.log(`${file}: ${oldVersion} → ${version}`);
}

console.log(`\nVersion bumped to ${version}`);
console.log('\nNext steps:');
console.log(`  git add -A && git commit -m "v${version}"`);
console.log(`  git tag v${version}`);
console.log('  git push && git push --tags');
console.log('  pnpm build:all');
