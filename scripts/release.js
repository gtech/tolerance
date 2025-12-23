#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import * as readline from 'readline';

const version = process.argv[2];

if (!version) {
  console.error('Usage: node scripts/release.js <version>');
  console.error('Example: node scripts/release.js 0.1.8');
  process.exit(1);
}

// Validate version format
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Error: Version must be in format X.Y.Z (e.g., 0.1.8)');
  process.exit(1);
}

const versionTag = `v${version}`;

// Helper to run commands
function run(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit', ...options });
  } catch (error) {
    if (!options.ignoreError) {
      console.error(`\nCommand failed: ${cmd}`);
      process.exit(1);
    }
  }
}

// Helper to get user input
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Helper to get multiline input
async function promptMultiline(question) {
  console.log(question);
  console.log('(Enter each note on a new line. Empty line to finish)\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const lines = [];

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (line === '') {
        rl.close();
        resolve(lines);
      } else {
        // Add "- " prefix if not present
        const formatted = line.startsWith('- ') ? line : `- ${line}`;
        lines.push(formatted);
      }
    });
  });
}

async function main() {
  console.log(`\n=== Releasing Tolerance ${versionTag} ===\n`);

  // Step 1: Get release notes
  const notes = await promptMultiline('Release notes:');
  if (notes.length === 0) {
    console.error('Error: At least one release note is required');
    process.exit(1);
  }
  const notesText = notes.join('\n');

  console.log('\n--- Release notes ---');
  console.log(notesText);
  console.log('---------------------\n');

  const confirm = await prompt('Proceed with release? (y/n): ');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Aborted.');
    process.exit(0);
  }

  // Step 2: Bump version in files
  console.log('\n=== Bumping version ===');
  const files = ['package.json', 'manifest.json', 'manifest.firefox.json'];

  for (const file of files) {
    const content = JSON.parse(readFileSync(file, 'utf8'));
    const oldVersion = content.version;
    content.version = version;
    writeFileSync(file, JSON.stringify(content, null, 2) + '\n');
    console.log(`${file}: ${oldVersion} -> ${version}`);
  }

  // Step 3: Git commit and tag
  console.log('\n=== Git commit and tag ===');
  run('git add -A');
  run(`git commit -m "${versionTag}"`);
  run(`git tag ${versionTag}`);

  // Step 4: Push to remote
  console.log('\n=== Pushing to remote ===');
  run('git push');
  run('git push --tags');

  // Step 5: Build
  console.log('\n=== Building ===');
  run('pnpm build:all');

  // Step 6: Create release zips
  console.log('\n=== Creating release zips ===');
  run('pnpm zip');

  // Step 7: Create source zip for Mozilla
  console.log('\n=== Creating source zip for Mozilla ===');
  run(`git archive --format=zip --prefix=tolerance-${versionTag}/ ${versionTag} -o tolerance-source-${versionTag}.zip`);

  // Step 8: Create GitHub release
  console.log('\n=== Creating GitHub release ===');
  const releaseCmd = `gh release create ${versionTag} tolerance-chrome.zip tolerance-firefox.zip tolerance-source-${versionTag}.zip --title "${versionTag}" --notes "${notesText.replace(/"/g, '\\"')}"`;
  run(releaseCmd);

  console.log(`\n=== Release ${versionTag} complete! ===`);
  console.log('\nArtifacts created:');
  console.log('  - tolerance-chrome.zip');
  console.log('  - tolerance-firefox.zip');
  console.log(`  - tolerance-source-${versionTag}.zip`);
  console.log(`\nGitHub release: https://github.com/gtech/tolerance/releases/tag/${versionTag}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
