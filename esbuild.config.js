import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { dirname, join } from 'path';

const isWatch = process.argv.includes('--watch');
const isFirefox = process.argv.includes('--firefox');

const commonOptions = {
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch,
  target: isFirefox ? 'firefox109' : 'chrome120',
  format: 'esm',
};

// Ensure dist directories exist
const dirs = ['dist', 'dist/popup', 'dist/dashboard', 'dist/assets', 'dist/icons'];
dirs.forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
});

// Copy static files
const manifestFile = isFirefox ? 'manifest.firefox.json' : 'manifest.json';
const staticFiles = [
  [manifestFile, 'dist/manifest.json'],
  ['src/popup/popup.html', 'dist/popup/popup.html'],
  ['src/dashboard/index.html', 'dist/dashboard/index.html'],
];

function copyStatic() {
  staticFiles.forEach(([src, dest]) => {
    if (existsSync(src)) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    }
  });

  // Copy icons folder
  const iconsDir = 'icons';
  if (existsSync(iconsDir)) {
    const iconFiles = readdirSync(iconsDir);
    iconFiles.forEach(file => {
      if (file.endsWith('.png')) {
        copyFileSync(join(iconsDir, file), join('dist/icons', file));
      }
    });
  }
}

// Build configs for each entry point
const builds = [
  {
    ...commonOptions,
    entryPoints: ['src/content/index.ts'],
    outfile: 'dist/content.js',
    format: 'iife', // Content scripts need IIFE
  },
  {
    ...commonOptions,
    entryPoints: ['src/content/twitter/index.ts'],
    outfile: 'dist/twitter.js',
    format: 'iife', // Content scripts need IIFE (Twitter/X feed processing)
  },
  {
    ...commonOptions,
    entryPoints: ['src/content/tracker.ts'],
    outfile: 'dist/tracker.js',
    format: 'iife', // Content scripts need IIFE (lightweight heartbeat for other social media sites)
  },
  {
    ...commonOptions,
    entryPoints: ['src/content/youtube/index.ts'],
    outfile: 'dist/youtube.js',
    format: 'iife', // Content scripts need IIFE (YouTube feed processing)
  },
  {
    ...commonOptions,
    entryPoints: ['src/content/instagram/index.ts'],
    outfile: 'dist/instagram.js',
    format: 'iife', // Content scripts need IIFE (Instagram feed processing)
  },
  {
    ...commonOptions,
    entryPoints: ['src/background/index.ts'],
    outfile: 'dist/background.js',
    format: isFirefox ? 'iife' : 'esm', // Firefox background scripts need IIFE
  },
  {
    ...commonOptions,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup/popup.js',
  },
  {
    ...commonOptions,
    entryPoints: ['src/dashboard/dashboard.ts'],
    outfile: 'dist/dashboard/dashboard.js',
  },
];

async function build() {
  copyStatic();

  if (isWatch) {
    const contexts = await Promise.all(
      builds.map(config => esbuild.context(config))
    );

    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(builds.map(config => esbuild.build(config)));
    console.log('Build complete');
  }
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
