# Tolerance

**Make social media boring again.**

A browser extension that scores content by how hard it's trying to manipulate you, then makes the feed progressively uninteresting until you'd rather do literally anything else.

[Website](https://tolerance.lol) · [Download](https://github.com/gtech/tolerance/releases)

## How it works

1. **Every post gets scored.** AI analyzes each piece of content for manipulation signals: outrage bait, curiosity gaps, tribal triggers, engagement farming.

2. **The feed gets boring over time.** For the first 15 minutes, you browse normally. Then Tolerance starts blurring the most manipulative content. The longer you scroll, the more gets blurred.

3. **You leave because you're bored, not blocked.** Blocking creates craving. Boredom creates freedom. You reclaim your feed and close the tab on your own terms.

## Supported platforms

- Reddit (old.reddit.com is better)
- Twitter/X
- YouTube
- Instagram

## Installation

### From release

Download the latest `.zip` for your browser from [Releases](https://github.com/gtech/tolerance/releases).

**Chrome:**
1. Unzip `tolerance-chrome.zip`
2. Go to `chrome://extensions`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the unzipped folder

**Firefox:**
1. Unzip `tolerance-firefox.zip`
2. Go to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `manifest.json` from the unzipped folder

### Build from source

```bash
git clone https://github.com/gtech/tolerance.git
cd tolerance
pnpm install
pnpm build          # Chrome
pnpm build:firefox  # Firefox
pnpm build:all      # Both (outputs to dist-chrome/ and dist-firefox/)
```

Load the `dist/` folder as an unpacked extension.

## Setup

Tolerance uses AI to score content. You need an API key from [OpenRouter](https://openrouter.ai/) (or any other OpenAI compatible endpoint).

1. Create an account at [openrouter.ai](https://openrouter.ai/)
2. Go to Keys → Create Key
3. Add credits ($5 is plenty to start)
4. Paste the key in the Tolerance dashboard

**Cost:** ~$1-2/month typical usage.

## Features

### Manipulation Scoring
Every post gets a 0-100 score. High score = trying hard to hook you. Scores appear as badges.

### Progressive Boredom

| Time | What happens |
|------|--------------|
| 0-15 min | Normal browsing |
| 15-45 min | High-manipulation content blurred |
| 45-75 min | More aggressive blurring |
| 75+ min | Almost everything blurred |

Resets daily at midnight.

### Quality Mode
One toggle. Instantly blurs everything above score 20. Only genuine content remains.

### Hover to Reveal
Blurred content reveals after hovering for 3 seconds. Friction, not blocking.

### Adaptive Calibration
Daily feedback ("too restricted / balanced / too easy") adjusts thresholds automatically.

## Privacy

- **No tracking.** No analytics, no telemetry.
- **No accounts.** Everything stored locally.
- **Open source.** Read the code.

Post titles and content are sent to OpenRouter for scoring. Nothing else leaves your browser.

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build once (Chrome)
pnpm build:firefox  # Build for Firefox
pnpm dev        # Watch mode
```

## Source Code Submission (for Mozilla Add-ons reviewers)

This extension is built using esbuild which bundles and minifies the source code.

### Build environment

- **OS:** Any (Linux, macOS, Windows)
- **Node.js:** v18 or later
- **Package manager:** pnpm (install via `npm install -g pnpm`)

### Build instructions

```bash
pnpm install
pnpm build:firefox
```

The built extension will be in `dist/`. Compare this output against the submitted `.zip` file.

### Dependencies

All dependencies are listed in `package.json` and locked in `pnpm-lock.yaml`:

- `idb` - IndexedDB wrapper (runtime)
- `esbuild` - Bundler (dev)
- `typescript` - Type checking (dev)
- `@anthropic-ai/sdk` - Types only, not bundled (dev)
- `@types/chrome` - TypeScript definitions (dev)

No obfuscation is used. Minification is applied only in production builds for smaller file size.

### Project structure

```
src/
├── background/     # Service worker (scoring, storage, API)
│   ├── scorer.ts   # Hybrid heuristic + API scoring
│   ├── scheduler.ts # Progressive boredom logic
│   └── storage.ts  # IndexedDB persistence
├── content/        # Reddit content script
│   ├── twitter/    # Twitter/X
│   └── youtube/    # YouTube
├── popup/          # Extension popup
├── dashboard/      # Settings dashboard
└── shared/         # Types and constants
```

## Tips

**YouTube:** For best results, disable video previews:
Settings → Playback and performance → uncheck "Video previews"


ETH: 0x000047da31d416b657a1c415467cdd57bc4ed9a7
Ko-fi: https://ko-fi.com/tolerance

## License

AGPL-3.0
