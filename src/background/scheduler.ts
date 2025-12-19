import { log } from '../shared/constants';
import { EngagementScore, SchedulerConfig } from '../shared/types';
import { getSettings, getCounterStrategies, getSessionMinutes, getCurrentPhase } from './storage';

// Map narrative confidence to numeric score for threshold comparison
const confidenceToScore: Record<string, number> = {
  low: 33,
  medium: 66,
  high: 100,
};

// Get effective high-engagement ratio based on progressive boredom
// Returns a ratio (0-1) that decreases as social media time increases today
export async function getEffectiveRatio(): Promise<number> {
  const settings = await getSettings();
  const config = settings.scheduler;

  // If progressive boredom is disabled, use base ratio
  if (!config.progressiveBoredomEnabled) {
    return config.highEngagementRatio;
  }

  // Get total social media time across all platforms today
  const sessionMinutes = await getSessionMinutes();
  const phase = getCurrentPhase(sessionMinutes, config.phaseThresholds);

  // Return ratio based on current phase
  switch (phase) {
    case 'minimal':
      return config.phaseRatios.minimal;
    case 'wind-down':
      return config.phaseRatios.windDown;
    case 'reduced':
      return config.phaseRatios.reduced;
    case 'normal':
    default:
      return config.phaseRatios.normal;
  }
}

// Fixed interval scheduler
// Transforms variable reward (Reddit's order) into predictable pattern
// Also applies narrative counter-strategies for suppression and boosting
export async function getScheduledOrder(
  postIds: string[],
  scores: Map<string, EngagementScore>
): Promise<{ orderedIds: string[]; hiddenIds: string[] }> {
  const settings = await getSettings();
  const config = settings.scheduler;

  if (!config.enabled) {
    return { orderedIds: postIds, hiddenIds: [] }; // Return original order if disabled
  }

  // Load counter-strategies for narrative suppression/boosting
  const strategies = await getCounterStrategies();
  const enabledStrategies = strategies.filter(s => s.enabled);

  // Separate posts by bucket, applying narrative suppression
  const high: string[] = [];
  const medium: string[] = [];
  const low: string[] = [];
  const boosted: string[] = []; // Posts matching surface keywords
  const suppressed: string[] = []; // Posts suppressed by narrative strategies

  for (const id of postIds) {
    const score = scores.get(id);
    if (!score) {
      medium.push(id); // Unknown -> treat as medium
      continue;
    }

    // Check for narrative suppression
    const narrativeDetection = score.factors?.narrative;
    let isSuppressed = false;

    if (narrativeDetection && enabledStrategies.length > 0) {
      const strategy = enabledStrategies.find(s => s.themeId === narrativeDetection.themeId);
      if (strategy) {
        const confidenceScore = confidenceToScore[narrativeDetection.confidence] || 0;
        if (confidenceScore >= strategy.suppressThreshold) {
          suppressed.push(id);
          isSuppressed = true;
          log.debug(`: Suppressed post ${id} (${narrativeDetection.themeId}, confidence: ${narrativeDetection.confidence})`);
        }
      }
    }

    if (isSuppressed) continue;

    // Check for boosting via surface keywords in title
    // This requires the post title, which we don't have here directly
    // We check keyword flags instead (they contain matched keywords)
    let isBoosted = false;
    if (enabledStrategies.length > 0 && score.factors?.keywordFlags) {
      for (const strategy of enabledStrategies) {
        if (strategy.surfaceKeywords.length > 0) {
          // Check if any surface keyword appears in the title
          // We'd need the title for this, but we can check if any keyword flag contains surface keywords
          const titleKeywords = score.factors.keywordFlags.join(' ').toLowerCase();
          for (const surfaceKw of strategy.surfaceKeywords) {
            if (titleKeywords.includes(surfaceKw.toLowerCase())) {
              boosted.push(id);
              isBoosted = true;
              log.debug(`: Boosted post ${id} (matched surface keyword: ${surfaceKw})`);
              break;
            }
          }
          if (isBoosted) break;
        }
      }
    }

    if (isBoosted) continue;

    switch (score.bucket) {
      case 'high':
        high.push(id);
        break;
      case 'medium':
        medium.push(id);
        break;
      case 'low':
        low.push(id);
        break;
    }
  }

  // Get effective ratio based on progressive boredom
  const effectiveRatio = await getEffectiveRatio();

  // Log phase info if ratio differs from base
  if (effectiveRatio !== config.highEngagementRatio) {
    const sessionMinutes = await getSessionMinutes();
    const phase = getCurrentPhase(sessionMinutes, config.phaseThresholds);
    log.debug(`: Progressive boredom active - ${Math.round(sessionMinutes)} min, phase: ${phase}, ratio: ${effectiveRatio}`);
  }

  // Debug: log bucket distribution
  log.debug(` Scheduler: Buckets - high: ${high.length}, medium: ${medium.length}, low: ${low.length}, boosted: ${boosted.length}, suppressed: ${suppressed.length}`);
  log.debug(` Scheduler: High posts: ${high.map(id => {
    const s = scores.get(id);
    return `${id.slice(0,6)}(${s?.apiScore ?? s?.heuristicScore})`;
  }).join(', ')}`);

  // Interleave according to fixed interval schedule with effective ratio
  // Boosted posts are mixed into the medium pool
  const mediumWithBoosted = [...boosted, ...medium];
  const { ordered, hidden } = interleave(high, mediumWithBoosted, low, config, effectiveRatio);

  // Debug: log result order with scores
  log.debug(` Scheduler: Result order (first 15): ${ordered.slice(0, 15).map(id => {
    const s = scores.get(id);
    return s?.apiScore ?? s?.heuristicScore ?? '?';
  }).join(', ')}`);

  // Add suppressed posts to hidden list
  const allHidden = [...hidden, ...suppressed];

  return { orderedIds: ordered, hiddenIds: allHidden };
}

// Interleave posts to create fixed interval pattern
// Instead of random high-dopamine posts, space them out predictably
// Returns { ordered: visible posts in order, hidden: posts to hide }
function interleave(
  high: string[],
  medium: string[],
  low: string[],
  config: SchedulerConfig,
  effectiveRatio: number
): { ordered: string[]; hidden: string[] } {
  const result: string[] = [];
  const hidden: string[] = [];
  const nonHigh = [...low, ...medium]; // Pool of non-high-engagement posts

  // If ratio is 0 (minimal phase), hide ALL high-engagement posts
  if (effectiveRatio === 0) {
    return { ordered: nonHigh, hidden: high };
  }

  // Calculate how often to show high-engagement posts based on effective ratio
  // ratio 0.33 means 1 in 3, so show high after every 2 non-high
  const targetGap = Math.max(
    config.cooldownPosts,
    Math.floor(1 / effectiveRatio) - 1
  );

  // Calculate max high posts allowed based on non-high count and ratio
  // If we have 10 non-high posts and ratio is 0.33 (1:3), we allow ~3 high posts
  const maxHighPosts = Math.floor(nonHigh.length * effectiveRatio / (1 - effectiveRatio));
  const allowedHighPosts = Math.min(high.length, Math.max(1, maxHighPosts));

  log.debug(` Scheduler: nonHigh=${nonHigh.length}, high=${high.length}, ratio=${effectiveRatio}, maxHigh=${maxHighPosts}, allowed=${allowedHighPosts}`);

  let highIndex = 0;
  let nonHighIndex = 0;
  let postsSinceLastHigh = 0;

  while (nonHighIndex < nonHigh.length) {
    // Check if it's time for a high-engagement post (and we haven't exceeded our allowance)
    const shouldShowHigh =
      highIndex < allowedHighPosts &&
      postsSinceLastHigh >= targetGap;

    if (shouldShowHigh) {
      result.push(high[highIndex]);
      highIndex++;
      postsSinceLastHigh = 0;
    } else {
      result.push(nonHigh[nonHighIndex]);
      nonHighIndex++;
      postsSinceLastHigh++;
    }
  }

  // If we still have room for high posts at the end (rare case)
  while (highIndex < allowedHighPosts && postsSinceLastHigh >= targetGap) {
    result.push(high[highIndex]);
    highIndex++;
    postsSinceLastHigh = 0;
  }

  // Any remaining high posts should be hidden
  while (highIndex < high.length) {
    hidden.push(high[highIndex]);
    highIndex++;
  }

  if (hidden.length > 0) {
    log.debug(` Scheduler: Hiding ${hidden.length} excess high-engagement posts`);
  }

  return { ordered: result, hidden };
}

// Helper to check if reordering would significantly change the feed
export function calculateReorderingImpact(
  originalOrder: string[],
  newOrder: string[],
  scores: Map<string, EngagementScore>
): {
  postsReordered: number;
  highEngagementMovedDown: number;
  averagePositionChange: number;
} {
  let postsReordered = 0;
  let highEngagementMovedDown = 0;
  let totalPositionChange = 0;

  const newPositions = new Map(newOrder.map((id, i) => [id, i]));

  for (let i = 0; i < originalOrder.length; i++) {
    const id = originalOrder[i];
    const newPos = newPositions.get(id);

    if (newPos !== undefined && newPos !== i) {
      postsReordered++;
      totalPositionChange += Math.abs(newPos - i);

      const score = scores.get(id);
      if (score?.bucket === 'high' && newPos > i) {
        highEngagementMovedDown++;
      }
    }
  }

  return {
    postsReordered,
    highEngagementMovedDown,
    averagePositionChange: postsReordered > 0 ? totalPositionChange / postsReordered : 0,
  };
}
