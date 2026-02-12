- Code cleanup and refactor

- test suite with playwright:

```
""Browser extension testing - it's actually more tractable than you'd think:
Playwright has first-class extension support now. You can load your unpacked extension and run real E2E tests:
jsconst context = await chromium.launchPersistentContext('', {
  headless: false, // extensions require headed mode
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});
Then you can navigate to Twitter/Reddit, check that your content scripts injected, verify blur behavior, etc.
For Tolerance specifically, you could:

Mock the OpenRouter API responses
Load a test page with known "manipulative" vs "benign" content
Assert that scoring works and blurring triggers at the right thresholds

Not full coverage, but catches regressions in the core flow. Worth an afternoon to set up—future you will thank present you when a refactor breaks something subtle.""

```

- Fix the database, it's a mess. score and apiscore probably need to be scrapped.

- Remove superfluous keywords in constants.ts

# Upcoming Features

## Prompt to create arbitrary cognitive filters

## Tiktok

## Facebook

## Custom filters
- Defined by the types of content you choose to see.

## Dialectical Countering
- Inject counter content
- e.g. homeless child star: homelessness trends from official databases, and counter-meme showing improvements and interventions

## Intent Matching

## Community-archive integration
- Optional send posts to db

## Adaptation tracking. Log what types of content the platform is serving over time. Show the user: "This week Twitter tried: outrage bait (blocked), engagement farming (blocked), celebrity content (blocked). It's running out of moves."

## manipulation taxonomy tracking. Not just scoring individual posts, but tracking what categories of manipulation the algorithm is currently trying on you. Over time you'd see patterns:

"Twitter is currently probing you with: outrage (blocked) → celebrity (testing) → nostalgia (queued)"

--- 

- surface and let users edit the default prompt

- remove "Ratio: 20% high-engagement posts"

- Figure out how to get the 3 second blur and the ability to change the threshholds across.

- Bring the exclusion list higher

- Remove "posts seen today" dash on the popup

- Have the api key zone better visible in the popup and dashboard when it's free tier.

- Consider changing images to auto or high for more scoring accuracy

- Right now different sites consider having different distributions and have to be treated differently.

- slider for quality mode