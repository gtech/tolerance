#!/usr/bin/env node

/**
 * Calibration Data Analysis Script
 *
 * Analyzes exported Tolerance data to compare heuristic vs API scores.
 *
 * Usage:
 *   node scripts/analyze-calibration.js <export-file.json> [--cutoff <date>]
 *
 * Examples:
 *   node scripts/analyze-calibration.js tolerance-export-2025-01-15.json
 *   node scripts/analyze-calibration.js export.json --cutoff 2025-01-10
 *   node scripts/analyze-calibration.js export.json --cutoff "2025-01-10T12:00:00"
 */

import fs from 'fs';

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node scripts/analyze-calibration.js <export-file.json> [--cutoff <date>]');
    console.error('');
    console.error('Options:');
    console.error('  --cutoff <date>  Only analyze data after this date (ISO format or YYYY-MM-DD)');
    process.exit(1);
  }

  const file = args[0];
  let cutoff = null;

  const cutoffIdx = args.indexOf('--cutoff');
  if (cutoffIdx !== -1 && args[cutoffIdx + 1]) {
    cutoff = new Date(args[cutoffIdx + 1]);
    if (isNaN(cutoff.getTime())) {
      console.error(`Invalid date format: ${args[cutoffIdx + 1]}`);
      process.exit(1);
    }
  }

  return { file, cutoff };
}

// Calculate basic statistics
function calcStats(values) {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, stdDev: 0, min: 0, max: 0, p25: 0, p75: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;

  const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);

  const percentile = (p) => {
    const idx = (p / 100) * (n - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - idx) + sorted[upper] * (idx - lower);
  };

  return {
    count: n,
    mean,
    median: percentile(50),
    stdDev,
    min: sorted[0],
    max: sorted[n - 1],
    p25: percentile(25),
    p75: percentile(75),
  };
}

// Calculate Pearson correlation coefficient
function correlation(x, y) {
  if (x.length !== y.length || x.length < 2) return 0;

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}

// Linear regression (returns slope and intercept)
function linearRegression(x, y) {
  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // Calculate R²
  const yMean = sumY / n;
  const ssTotal = y.reduce((acc, yi) => acc + Math.pow(yi - yMean, 2), 0);
  const ssResidual = y.reduce((acc, yi, i) => acc + Math.pow(yi - (slope * x[i] + intercept), 2), 0);
  const r2 = 1 - ssResidual / ssTotal;

  return { slope, intercept, r2 };
}

// Get bucket for a score
function getBucket(score) {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

// Create ASCII histogram
function histogram(values, bins = 10, width = 40) {
  if (values.length === 0) return ['No data'];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const binSize = range / bins;

  const counts = new Array(bins).fill(0);
  for (const v of values) {
    const bin = Math.min(Math.floor((v - min) / binSize), bins - 1);
    counts[bin]++;
  }

  const maxCount = Math.max(...counts);
  const lines = [];

  for (let i = 0; i < bins; i++) {
    const binStart = min + i * binSize;
    const binEnd = binStart + binSize;
    const barLength = Math.round((counts[i] / maxCount) * width);
    const bar = '█'.repeat(barLength) + '░'.repeat(width - barLength);
    lines.push(`  ${binStart.toFixed(0).padStart(3)}-${binEnd.toFixed(0).padStart(3)} │${bar}│ ${counts[i]}`);
  }

  return lines;
}

// Main analysis
function main() {
  const { file, cutoff } = parseArgs();

  // Read and parse file
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
  }

  const rawData = fs.readFileSync(file, 'utf-8');
  const data = JSON.parse(rawData);

  console.log('═'.repeat(70));
  console.log('  Tolerance Calibration Analysis');
  console.log('═'.repeat(70));
  console.log(`  Export date: ${data.exportDate}`);
  console.log(`  Total calibration entries: ${data.calibration.length}`);

  // Apply cutoff filter
  let entries = data.calibration;
  if (cutoff) {
    const cutoffTs = cutoff.getTime();
    entries = entries.filter(e => e.timestamp >= cutoffTs);
    console.log(`  Cutoff date: ${cutoff.toISOString()}`);
    console.log(`  Entries after cutoff: ${entries.length}`);
  }

  if (entries.length === 0) {
    console.log('\n  No data to analyze after applying filters.');
    process.exit(0);
  }

  // Date range of data
  const timestamps = entries.map(e => e.timestamp);
  const minDate = new Date(Math.min(...timestamps));
  const maxDate = new Date(Math.max(...timestamps));
  console.log(`  Data range: ${minDate.toISOString().split('T')[0]} to ${maxDate.toISOString().split('T')[0]}`);
  console.log('═'.repeat(70));

  // Extract scores
  const heuristic = entries.map(e => e.heuristicScore);
  const api = entries.map(e => e.apiScore);
  const deltas = entries.map(e => e.heuristicScore - e.apiScore);
  const absDeltas = deltas.map(Math.abs);

  // Overall statistics
  const heuristicStats = calcStats(heuristic);
  const apiStats = calcStats(api);
  const deltaStats = calcStats(deltas);
  const absDeltaStats = calcStats(absDeltas);
  const corr = correlation(heuristic, api);
  const regression = linearRegression(heuristic, api);

  console.log('\n  OVERALL STATISTICS');
  console.log('─'.repeat(70));
  console.log(`  Sample size: ${entries.length}`);
  console.log('');
  console.log('                      Heuristic          API');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Mean              ${heuristicStats.mean.toFixed(2).padStart(10)}   ${apiStats.mean.toFixed(2).padStart(10)}`);
  console.log(`  Median            ${heuristicStats.median.toFixed(2).padStart(10)}   ${apiStats.median.toFixed(2).padStart(10)}`);
  console.log(`  Std Dev           ${heuristicStats.stdDev.toFixed(2).padStart(10)}   ${apiStats.stdDev.toFixed(2).padStart(10)}`);
  console.log(`  Min               ${heuristicStats.min.toFixed(0).padStart(10)}   ${apiStats.min.toFixed(0).padStart(10)}`);
  console.log(`  Max               ${heuristicStats.max.toFixed(0).padStart(10)}   ${apiStats.max.toFixed(0).padStart(10)}`);
  console.log(`  25th percentile   ${heuristicStats.p25.toFixed(2).padStart(10)}   ${apiStats.p25.toFixed(2).padStart(10)}`);
  console.log(`  75th percentile   ${heuristicStats.p75.toFixed(2).padStart(10)}   ${apiStats.p75.toFixed(2).padStart(10)}`);

  console.log('\n  BIAS & CORRELATION');
  console.log('─'.repeat(70));
  console.log(`  Mean delta (heuristic - API): ${deltaStats.mean >= 0 ? '+' : ''}${deltaStats.mean.toFixed(2)}`);
  console.log(`  Median delta:                 ${deltaStats.median >= 0 ? '+' : ''}${deltaStats.median.toFixed(2)}`);
  console.log(`  Mean absolute delta:          ${absDeltaStats.mean.toFixed(2)}`);
  console.log(`  Correlation (r):              ${corr.toFixed(4)}`);
  console.log(`  R²:                           ${(corr * corr).toFixed(4)}`);
  console.log('');
  console.log(`  Linear regression: API = ${regression.slope.toFixed(4)} × Heuristic + ${regression.intercept.toFixed(2)}`);
  console.log(`  Regression R²:     ${regression.r2.toFixed(4)}`);

  // Recommendation
  console.log('\n  CALIBRATION RECOMMENDATION');
  console.log('─'.repeat(70));
  const bias = -deltaStats.mean; // Positive if heuristic is lower than API
  if (Math.abs(bias) < 2) {
    console.log('  ✓ Scores are well-calibrated (bias < 2 points)');
  } else if (Math.abs(regression.slope - 1) < 0.1 && Math.abs(bias) < 10) {
    console.log(`  → Simple offset recommended: Add ${bias >= 0 ? '+' : ''}${bias.toFixed(1)} to heuristic`);
    console.log(`    (Linear relationship is close to 1:1, so flat offset works)`);
  } else {
    console.log(`  → Linear scaling recommended:`);
    console.log(`    adjusted = heuristic × ${regression.slope.toFixed(3)} + ${regression.intercept.toFixed(1)}`);
    console.log(`    (Relationship is not 1:1, simple offset won't work well)`);
  }

  // Analysis by score range
  console.log('\n  ANALYSIS BY SCORE RANGE');
  console.log('─'.repeat(70));

  const ranges = [
    { name: 'Low (0-39)', filter: (s) => s < 40 },
    { name: 'Medium (40-69)', filter: (s) => s >= 40 && s < 70 },
    { name: 'High (70-100)', filter: (s) => s >= 70 },
  ];

  console.log('  Range           N      Avg H    Avg API    Delta    Corr');
  console.log('  ─────────────────────────────────────────────────────────');

  for (const range of ranges) {
    const rangeEntries = entries.filter(e => range.filter(e.heuristicScore));
    if (rangeEntries.length < 3) {
      console.log(`  ${range.name.padEnd(15)} ${String(rangeEntries.length).padStart(4)}      (insufficient data)`);
      continue;
    }

    const h = rangeEntries.map(e => e.heuristicScore);
    const a = rangeEntries.map(e => e.apiScore);
    const avgH = h.reduce((s, v) => s + v, 0) / h.length;
    const avgA = a.reduce((s, v) => s + v, 0) / a.length;
    const delta = avgH - avgA;
    const rangeCorr = correlation(h, a);

    console.log(`  ${range.name.padEnd(15)} ${String(rangeEntries.length).padStart(4)}    ${avgH.toFixed(1).padStart(6)}    ${avgA.toFixed(1).padStart(6)}   ${(delta >= 0 ? '+' : '') + delta.toFixed(1).padStart(5)}   ${rangeCorr.toFixed(2).padStart(5)}`);
  }

  // Bucket agreement analysis
  console.log('\n  BUCKET CLASSIFICATION AGREEMENT');
  console.log('─'.repeat(70));

  let agree = 0;
  let heuristicHigherBucket = 0;
  let apiHigherBucket = 0;

  const bucketOrder = { low: 0, medium: 1, high: 2 };

  for (const e of entries) {
    const hBucket = getBucket(e.heuristicScore);
    const aBucket = getBucket(e.apiScore);

    if (hBucket === aBucket) {
      agree++;
    } else if (bucketOrder[hBucket] > bucketOrder[aBucket]) {
      heuristicHigherBucket++;
    } else {
      apiHigherBucket++;
    }
  }

  console.log(`  Same bucket:              ${agree} (${(100 * agree / entries.length).toFixed(1)}%)`);
  console.log(`  Heuristic rates higher:   ${heuristicHigherBucket} (${(100 * heuristicHigherBucket / entries.length).toFixed(1)}%)`);
  console.log(`  API rates higher:         ${apiHigherBucket} (${(100 * apiHigherBucket / entries.length).toFixed(1)}%)`);

  // Delta distribution histogram
  console.log('\n  DELTA DISTRIBUTION (Heuristic - API)');
  console.log('─'.repeat(70));
  for (const line of histogram(deltas, 10, 35)) {
    console.log(line);
  }

  // Outliers
  console.log('\n  OUTLIERS (|delta| > 30)');
  console.log('─'.repeat(70));
  const outliers = entries
    .filter(e => Math.abs(e.heuristicScore - e.apiScore) > 30)
    .sort((a, b) => Math.abs(b.heuristicScore - b.apiScore) - Math.abs(a.heuristicScore - a.apiScore))
    .slice(0, 10);

  if (outliers.length === 0) {
    console.log('  No significant outliers found.');
  } else {
    console.log(`  ${outliers.length} outliers found (showing up to 10):`);
    console.log('  Post ID          Heuristic   API   Delta   Link');
    console.log('  ─────────────────────────────────────────────────');
    for (const o of outliers) {
      const delta = o.heuristicScore - o.apiScore;
      const link = o.permalink ? `reddit.com${o.permalink.slice(0, 30)}...` : 'N/A';
      console.log(`  ${o.postId.slice(0, 14).padEnd(14)}   ${o.heuristicScore.toFixed(0).padStart(6)}   ${o.apiScore.toFixed(0).padStart(4)}   ${(delta >= 0 ? '+' : '') + delta.toFixed(0).padStart(4)}   ${link}`);
    }
  }

  // Time series analysis (is the bias consistent over time?)
  console.log('\n  BIAS OVER TIME');
  console.log('─'.repeat(70));

  // Group by day
  const byDay = new Map();
  for (const e of entries) {
    const day = new Date(e.timestamp).toISOString().split('T')[0];
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const days = [...byDay.keys()].sort();
  if (days.length >= 2) {
    console.log('  Date          N      Avg Delta');
    console.log('  ─────────────────────────────────');
    for (const day of days.slice(-14)) { // Last 14 days
      const dayEntries = byDay.get(day);
      const avgDelta = dayEntries.reduce((s, e) => s + (e.heuristicScore - e.apiScore), 0) / dayEntries.length;
      const bar = avgDelta >= 0
        ? ' '.repeat(20) + '│' + '█'.repeat(Math.min(20, Math.round(avgDelta)))
        : ' '.repeat(20 - Math.min(20, Math.round(-avgDelta))) + '█'.repeat(Math.min(20, Math.round(-avgDelta))) + '│';
      console.log(`  ${day}  ${String(dayEntries.length).padStart(4)}  ${(avgDelta >= 0 ? '+' : '') + avgDelta.toFixed(1).padStart(6)} ${bar}`);
    }
  } else {
    console.log('  Not enough days of data for time series analysis.');
  }

  console.log('\n' + '═'.repeat(70));
}

main();
