# Tolerance

**Feeds are toxic. Build Tolerance.**

A browser extension that scores content by how hard it's trying to manipulate you, then makes the feed progressively higher quality so you spend precisely the amount of time you wish to.

[Website](https://tolerance.lol) · [Chrome](https://chromewebstore.google.com/detail/pmnbipkkofbjeblbmhffdgaddaofgeag) · [Firefox](https://addons.mozilla.org/en-US/firefox/addon/tolerancelol/) · [Releases](https://github.com/gtech/tolerance/releases)

## How it works

1. **Every post gets scored.** AI analyzes each piece of content for manipulation signals: outrage bait, curiosity gaps, tribal triggers, engagement farming.

2. **The feed gets boring over time.** For the first 15 minutes, you browse normally. Then Tolerance starts blurring the most manipulative content. The longer you scroll, the more gets blurred.

3. **You leave because you're bored, not blocked.** Blocking creates craving. Boredom creates freedom. You reclaim your feed and close the tab on your own terms.

## Supported platforms

- Reddit (old.reddit.com is better)
- Twitter/X
- YouTube
- Instagram
- Facebook (Chrome only; on Firefox, Tolerance only tracks time there)
- TikTok (time tracking only)

## Installation

### From the stores (easiest)

- **Chrome:** [Chrome Web Store](https://chromewebstore.google.com/detail/pmnbipkkofbjeblbmhffdgaddaofgeag)
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tolerancelol/)

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

`pnpm build` and `pnpm build:firefox` output to `dist/`; load that folder as an unpacked extension.

## Setup

Tolerance uses AI to score content. In the dashboard, choose one of:

- **Free Tier.** Try it without setup, with limited daily usage. Tolerance issues you an OpenRouter key; scoring calls still go straight to OpenRouter.
- **Your own key.** Get one from [tolerance.lol/account.html](https://tolerance.lol/account.html) or directly from [OpenRouter](https://openrouter.ai/) (Keys → Create Key, then add credits; $5 is plenty to start), and paste it into the dashboard.
- **A custom endpoint.** Any OpenAI-compatible chat completions URL, including a local one such as Ollama (`http://localhost:11434/v1/chat/completions`).

Posts are scored by `google/gemini-2.5-flash` (text, images and video thumbnails; Instagram reels use `google/gemini-2.5-flash-lite`). With a custom endpoint, you choose the text and vision models yourself.

**Cost:** ~$1-2/month typical usage.

## Features

### Cheap-Payoff Scoring
Every post gets a 0-100 score for how hard it grabs attention for how little reading or thinking it asks, and how little it leaves behind. Outrage bait scores high, but so do a clever one-liner, a cute dog or a relatable meme; a dense explainer scores low. Scores appear as badges; hover over a badge to see the reason.

The scoring rubric lives in one place (`src/shared/scoring-spec.ts`) and is versioned: when it changes, older cached scores are re-scored. `pnpm eval:scoring` runs a set of test posts through it and reports which land outside their expected range (needs an OpenRouter key in `OPENROUTER_API_KEY` or `test_key.env`).

- **Video counts as at least 40.** Autoplaying video is a hook in itself, so video posts score at least 40.
- **Blur until scored.** New posts stay blurred until their score arrives (up to 15 seconds by default), so you never glimpse bait before it's judged. A gate at page load stops the feed flashing before Tolerance starts.
- **Failed scores count as 50.** If the API fails, the post is treated as a 50 and the error shows on hover.
- **Threads and replies (Twitter).** A reply under a bait post is folded with it, and a thread continuing a bait post inherits its score. Search results are left unfiltered.
- **Debug a post.** Right-click a tweet and choose "Tolerance: debug this post" to see its score, the reason, and why it was or wasn't blurred.

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
Daily feedback ("too restricted / balanced / too easy") adjusts thresholds automatically. The dashboard shows what's being blurred right now, including any adjustment from feedback, and lets you reset the adjustment.

### Grounding Breaks
After a stretch of continuous scrolling (20 minutes by default), Tolerance offers a short grounding exercise: a few slow breaths, 5-4-3-2-1, or feet on the floor. It's always optional, and a 5-minute break resets the clock.

### Narrative Awareness
Tolerance tracks recurring narratives in your feed: themes you define, plus emerging ones it discovers each day for you to confirm or dismiss. The dashboard shows today's exposure to each. A counter-strategy (thesis, antithesis, synthesis) for a narrative can raise or lower the scores of posts that match it.

### Hide Facebook Reels
On by default. Removes the Reels tray and posts that link to reels from your Facebook feed.

### Claude Filter (optional, off by default)
On claude.ai, rewrites Claude's responses through a second model to strip excessive praise and add gentle break reminders. Only what you see changes.

## Privacy

- **No tracking.** No analytics, no telemetry.
- **No accounts.** Everything stored locally.
- **Open source.** Read the code.

Post text, titles, and images or video thumbnails are sent to OpenRouter (or your custom endpoint) for scoring. If you use the Free Tier, tolerance.lol only issues your key and checks your plan. It never sees what you browse. Nothing else leaves your browser.

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build once (Chrome)
pnpm build:firefox  # Build for Firefox
pnpm dev        # Watch mode
pnpm test       # Run tests (vitest)
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
- `vitest` - Tests (dev)
- `@anthropic-ai/sdk` - Types only, not bundled (dev)
- `@types/chrome` - TypeScript definitions (dev)

No obfuscation is used. Minification is applied only in production builds for smaller file size.

### Project structure

```
src/
├── background/         # Service worker (scoring, storage, API)
│   ├── scorer.ts       # Scoring pipeline and caching
│   ├── openrouter.ts   # LLM calls (text, image, video)
│   ├── scheduler.ts    # Progressive boredom logic
│   ├── storage.ts      # IndexedDB persistence
│   ├── themeDiscovery.ts # Emerging narrative discovery
│   ├── grounding.ts    # Grounding break timing
│   ├── provisioning.ts # Free tier key provisioning
│   └── rewriter.ts     # Claude filter rewrites
├── content/            # Reddit content script, plus shared attention/grounding UI
│   ├── twitter/        # Twitter/X (early.ts = page-load gate, debug.ts = debug report)
│   ├── youtube/        # YouTube
│   ├── facebook/       # Facebook
│   ├── instagram/      # Instagram
│   ├── claude-filter/  # claude.ai response filter
│   └── tracker.ts      # Time tracking for TikTok (and Facebook on Firefox)
├── popup/              # Extension popup
├── dashboard/          # Settings dashboard
└── shared/             # Types, constants and shared utilities
```

## Tips

**YouTube:** For best results, disable video previews:
Settings → Playback and performance → uncheck "Video previews"


ETH: 0x000047da31d416b657a1c415467cdd57bc4ed9a7
Ko-fi: https://ko-fi.com/tolerance

## License

AGPL-3.0
