#!/usr/bin/env python3
"""
Analyze BumpyBrain engagement data to determine optimal thresholds.
Separates Twitter and Reddit data for platform-specific analysis.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

def load_data(filepath):
    with open(filepath) as f:
        return json.load(f)

def is_twitter_post(post):
    """Detect Twitter posts by subreddit format (@username) or post ID format."""
    subreddit = post.get('subreddit', '')
    post_id = post.get('postId', '')

    # Twitter: subreddit starts with @ or is empty with numeric ID
    if subreddit.startswith('@'):
        return True
    # Twitter post IDs are long numeric strings (18+ digits)
    if post_id.isdigit() and len(post_id) > 15:
        return True
    return False

def analyze_distribution(scores, label):
    """Analyze score distribution and suggest thresholds."""
    if not scores:
        print(f"\n{label}: No data")
        return

    scores = sorted(scores)
    n = len(scores)

    # Basic stats
    mean = sum(scores) / n
    median = scores[n // 2]
    min_val = min(scores)
    max_val = max(scores)

    # Percentiles
    def percentile(p):
        idx = int(n * p / 100)
        return scores[min(idx, n - 1)]

    p10 = percentile(10)
    p25 = percentile(25)
    p50 = percentile(50)
    p75 = percentile(75)
    p90 = percentile(90)
    p95 = percentile(95)

    # Distribution buckets (current thresholds: low < 40, medium 40-69, high >= 70)
    low = sum(1 for s in scores if s < 40)
    medium = sum(1 for s in scores if 40 <= s < 70)
    high = sum(1 for s in scores if s >= 70)

    print(f"\n{'='*60}")
    print(f"{label}")
    print(f"{'='*60}")
    print(f"Total posts: {n}")
    print(f"\nBasic Stats:")
    print(f"  Min: {min_val}, Max: {max_val}")
    print(f"  Mean: {mean:.1f}, Median: {median:.1f}")
    print(f"\nPercentiles:")
    print(f"  10th: {p10}")
    print(f"  25th: {p25}")
    print(f"  50th (median): {p50}")
    print(f"  75th: {p75}")
    print(f"  90th: {p90}")
    print(f"  95th: {p95}")
    print(f"\nCurrent Bucket Distribution (low<40, med 40-69, high>=70):")
    print(f"  Low:    {low:4d} ({100*low/n:.1f}%)")
    print(f"  Medium: {medium:4d} ({100*medium/n:.1f}%)")
    print(f"  High:   {high:4d} ({100*high/n:.1f}%)")

    # Histogram
    print(f"\nScore Histogram:")
    buckets = defaultdict(int)
    for s in scores:
        bucket = (s // 10) * 10
        buckets[bucket] += 1

    max_count = max(buckets.values()) if buckets else 1
    for bucket in range(0, 110, 10):
        count = buckets.get(bucket, 0)
        bar_len = int(40 * count / max_count) if max_count > 0 else 0
        bar = '█' * bar_len
        print(f"  {bucket:3d}-{bucket+9:3d}: {bar} {count}")

    # Suggested thresholds based on percentiles
    print(f"\nSuggested Thresholds (based on percentiles):")
    print(f"  For ~33% high engagement: threshold >= {p75} (75th percentile)")
    print(f"  For ~20% high engagement: threshold >= {p90} (80th percentile)")
    print(f"  For ~10% high engagement: threshold >= {p90} (90th percentile)")

    return {
        'n': n,
        'mean': mean,
        'median': median,
        'p75': p75,
        'p90': p90,
        'p95': p95,
    }

def analyze_by_source(calibration, label_prefix):
    """Analyze both heuristic and API scores."""
    heuristic_scores = [p['heuristicScore'] for p in calibration if 'heuristicScore' in p]
    api_scores = [p['apiScore'] for p in calibration if 'apiScore' in p and p['apiScore'] is not None]

    h_stats = analyze_distribution(heuristic_scores, f"{label_prefix} - Heuristic Scores")
    a_stats = analyze_distribution(api_scores, f"{label_prefix} - API Scores")

    # Compare heuristic vs API when both exist
    paired = [(p['heuristicScore'], p['apiScore'])
              for p in calibration
              if 'heuristicScore' in p and 'apiScore' in p and p['apiScore'] is not None]

    if paired:
        print(f"\n{'='*60}")
        print(f"{label_prefix} - Heuristic vs API Comparison")
        print(f"{'='*60}")
        print(f"Paired samples: {len(paired)}")

        diffs = [api - heur for heur, api in paired]
        mean_diff = sum(diffs) / len(diffs)

        over = sum(1 for d in diffs if d > 10)
        under = sum(1 for d in diffs if d < -10)
        close = len(diffs) - over - under

        print(f"Mean difference (API - Heuristic): {mean_diff:+.1f}")
        print(f"API scores higher by >10: {over} ({100*over/len(diffs):.1f}%)")
        print(f"API scores lower by >10:  {under} ({100*under/len(diffs):.1f}%)")
        print(f"Within ±10:               {close} ({100*close/len(diffs):.1f}%)")

    return h_stats, a_stats

def main():
    # Find the export file
    if len(sys.argv) > 1:
        filepath = sys.argv[1]
    else:
        # Look for most recent export in current directory
        exports = list(Path('.').glob('bumpybrain-export*.json'))
        if not exports:
            exports = list(Path('/home/claude/bumpybrain').glob('bumpybrain-export*.json'))
        if not exports:
            print("Usage: python analyze-engagement.py <export-file.json>")
            sys.exit(1)
        filepath = max(exports, key=lambda p: p.stat().st_mtime)
        print(f"Using: {filepath}")

    data = load_data(filepath)

    print(f"\nExport Date: {data.get('exportDate', 'unknown')}")
    print(f"Total Sessions: {len(data.get('sessions', []))}")
    print(f"Total Calibration Entries: {len(data.get('calibration', []))}")

    calibration = data.get('calibration', [])

    # Separate by platform
    twitter_cal = [p for p in calibration if is_twitter_post(p)]
    reddit_cal = [p for p in calibration if not is_twitter_post(p)]

    print(f"\nPlatform breakdown:")
    print(f"  Twitter: {len(twitter_cal)}")
    print(f"  Reddit:  {len(reddit_cal)}")

    # Analyze each platform
    if reddit_cal:
        analyze_by_source(reddit_cal, "REDDIT")

    if twitter_cal:
        analyze_by_source(twitter_cal, "TWITTER")

    # Also analyze session data for bucket distribution
    sessions = data.get('sessions', [])
    all_posts = []
    for session in sessions:
        all_posts.extend(session.get('posts', []))

    if all_posts:
        twitter_posts = [p for p in all_posts if is_twitter_post(p)]
        reddit_posts = [p for p in all_posts if not is_twitter_post(p)]

        print(f"\n{'='*60}")
        print("SESSION DATA - Bucket Distribution")
        print(f"{'='*60}")

        for label, posts in [("Reddit", reddit_posts), ("Twitter", twitter_posts)]:
            if not posts:
                continue
            buckets = defaultdict(int)
            for p in posts:
                buckets[p.get('bucket', 'unknown')] += 1
            total = len(posts)
            print(f"\n{label} ({total} impressions):")
            for bucket in ['low', 'medium', 'high', 'unknown']:
                if bucket in buckets:
                    print(f"  {bucket}: {buckets[bucket]} ({100*buckets[bucket]/total:.1f}%)")

if __name__ == '__main__':
    main()
