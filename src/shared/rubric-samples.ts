// Ten fixed posts from the scoring eval (scripts/eval/scoring-cases.json), from
// dense explainers to engagement bait. The dashboard scores them with the default
// rubric and an edited one, side by side, before the edited rubric is saved.
import type { ScorePlatform } from './scoring-spec';

export interface RubricSample {
  id: string;
  platform: ScorePlatform;
  source: string;  // Subreddit, handle (no @) or channel
  text: string;
  length?: string; // YouTube video length
}

export const RUBRIC_SAMPLES: RubricSample[] = [
  { id: "tw-technical", platform: "twitter", source: "dbengineer", text: "Long thread on why your Postgres query planner ignores your index. 1/ The planner estimates selectivity from pg_statistic. If your column has a skewed distribution and default_statistics_target is 100, the histogram buckets can hide the heavy hitters, so the planner thinks a seq scan is cheaper. Here's how to check: run EXPLAIN (ANALYZE, BUFFERS) and compare estimated rows vs actual rows at each node..." },
  { id: "rd-askhistorians", platform: "reddit", source: "AskHistorians", text: "How did medieval European merchants manage credit and debt across long distances before modern banking?" },
  { id: "yt-lecture", platform: "youtube", source: "MIT OpenCourseWare", text: "Lecture 14: Linear Programming Duality", length: "1:18:32" },
  { id: "rd-news", platform: "reddit", source: "worldnews", text: "EU agrees new rules requiring USB-C charging for laptops from 2026" },
  { id: "tw-lol", platform: "twitter", source: "quietdev", text: "lmaooo" },
  { id: "rd-cute", platform: "reddit", source: "aww", text: "My dog fell asleep holding his favourite toy and I can't handle it" },
  { id: "tw-relatable", platform: "twitter", source: "sadgirl", text: "me: i'm going to bed early tonight\nme at 3:47am: watching a documentary about the history of salt" },
  { id: "tw-hottake", platform: "twitter", source: "vcguy", text: "Hot take: if you're not working 80 hours a week in your 20s you're choosing to be mediocre. Sorry not sorry." },
  { id: "yt-clickbait", platform: "youtube", source: "TechReviewer", text: "DON'T Buy The iPhone 17 Until You Watch This!!" },
  { id: "tw-curiosity", platform: "twitter", source: "growthhacker", text: "I made $47,000 last month with one simple trick nobody talks about. Here's exactly how 🧵👇" },
];
