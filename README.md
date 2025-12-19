# Tolerance

**Make social media boring again.**

A browser extension that scores content by how hard it's trying to manipulate you, then makes the feed progressively boring until you'd rather do literally anything else.

[Website](https://tolerance.lol) · [Download](https://github.com/gtech/tolerance/releases)

## How it works

1. **Every post gets scored** — AI analyzes each piece of content for manipulation signals: outrage bait, curiosity gaps, tribal triggers, engagement farming.

2. **The feed gets boring over time** — For the first 15 minutes, you browse normally. Then Tolerance starts blurring the most manipulative content. The longer you scroll, the more gets blurred.

3. **You leave because you're bored, not blocked** — Blocking creates craving. Boredom creates freedom. You close the tab because there's nothing interesting left.

## Supported platforms

- Reddit (old.reddit.com)
- Twitter/X
- YouTube

## Installation

### From release

1. Download the latest `.zip` from [Releases](https://github.com/gtech/tolerance/releases)
2. Unzip the file
3. Open Chrome → `chrome://extensions`
4. Enable "Developer mode" (top right)
5. Click "Load unpacked" and select the unzipped folder

### Build from source

```bash
git clone https://github.com/gtech/tolerance.git
cd tolerance
pnpm install
pnpm build
```

Load `dist/` as an unpacked extension.

## Setup

Tolerance uses AI to score content. You need an API key from [OpenRouter](https://openrouter.ai/).

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

- **No tracking** — No analytics, no telemetry
- **No accounts** — Everything stored locally
- **Open source** — Read the code

Post titles are sent to OpenRouter for scoring. Nothing else leaves your browser.

## Development

```bash
pnpm install    # Install dependencies
pnpm build      # Build once
pnpm dev        # Watch mode
```

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

## License

AGPL-3.0
