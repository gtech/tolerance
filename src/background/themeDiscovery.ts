import { log } from '../shared/constants';
import { EmergingNarrative, NarrativeTheme } from '../shared/types';
import { getSettings, getNarrativeThemes, saveEmergingNarratives, getEmergingNarratives } from './storage';

// Track unclassified posts for batch analysis
let unclassifiedPosts: { title: string; postId: string; timestamp: number }[] = [];
const MAX_UNCLASSIFIED_POSTS = 200; // Keep last 200 for analysis

// Add an unclassified post for later analysis
export function trackUnclassifiedPost(postId: string, title: string): void {
  unclassifiedPosts.push({
    postId,
    title,
    timestamp: Date.now(),
  });

  // Keep only the most recent posts
  if (unclassifiedPosts.length > MAX_UNCLASSIFIED_POSTS) {
    unclassifiedPosts = unclassifiedPosts.slice(-MAX_UNCLASSIFIED_POSTS);
  }
}

// Get count of unclassified posts available for analysis
export function getUnclassifiedCount(): number {
  return unclassifiedPosts.length;
}

// Clear unclassified posts after analysis
export function clearUnclassifiedPosts(): void {
  unclassifiedPosts = [];
}

// LLM prompt for theme discovery
function buildDiscoveryPrompt(titles: string[], existingThemes: NarrativeTheme[]): string {
  const existingThemeNames = existingThemes.map(t => t.name).join(', ');

  return `You are analyzing post titles to identify emerging narrative patterns that might indicate manipulative content or psychological influence campaigns.

These posts did NOT match any known theme patterns. Your task is to find recurring themes or framings that appear 3+ times.

**Known themes to EXCLUDE (already tracked):**
${existingThemeNames}

**Posts to analyze:**
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

**Instructions:**
1. Look for recurring patterns, framings, or narratives that appear in 3+ posts
2. Focus on potentially harmful patterns: doom-mongering, manipulation, tribal division, conspiracy thinking, learned helplessness, ragebait
3. Identify the underlying psychological appeal (fear, anger, victimhood, etc.)
4. Ignore mundane topics (gaming discussions, tech questions, hobby posts)

**For each cluster found, provide:**
- A short name (2-4 words)
- A description of what makes this narrative potentially manipulative
- Which post numbers belong to this cluster
- Suggested keywords for detection

**Respond with JSON only:**
{
  "clusters": [
    {
      "name": "Example Theme",
      "description": "Description of the pattern and why it's concerning",
      "postNumbers": [1, 4, 7],
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}

If no meaningful clusters are found, return: {"clusters": []}

IMPORTANT: Output ONLY the JSON object, no explanation or reasoning.`;
}

interface DiscoveryResult {
  clusters: Array<{
    name: string;
    description: string;
    postNumbers: number[];
    keywords: string[];
  }>;
}

// Call OpenRouter API for theme discovery
async function callDiscoveryApi(prompt: string): Promise<DiscoveryResult | null> {
  const settings = await getSettings();

  if (!settings.openRouterApiKey) {
    log.debug(': No API key for theme discovery');
    return null;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'chrome-extension://tolerance',
        'X-Title': 'Tolerance Theme Discovery',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 2000,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(': Discovery API error:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    // Check content first, then reasoning field (some models put output there)
    let content = message?.content;

    // If content is empty, try to extract from reasoning
    if (!content && message?.reasoning) {
      log.debug(': Extracting from reasoning field');
      content = message.reasoning;
    }

    if (!content) {
      log.error(': No content in discovery response', JSON.stringify(data).slice(0, 500));
      return null;
    }

    log.debug(': Discovery response content:', content.slice(0, 200));

    // Try to parse JSON from response
    try {
      // With JSON mode, content should be valid JSON directly
      // But handle markdown code blocks and embedded JSON as fallback
      let jsonStr = content.trim();

      // Strip markdown code blocks if present
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }

      // Try to find JSON object if not starting with {
      if (!jsonStr.startsWith('{')) {
        const jsonObjMatch = jsonStr.match(/\{[\s\S]*"clusters"[\s\S]*\}/);
        if (jsonObjMatch) {
          jsonStr = jsonObjMatch[0];
        }
      }

      return JSON.parse(jsonStr) as DiscoveryResult;
    } catch (parseError) {
      log.error(': Failed to parse discovery response:', parseError, 'Content:', content.slice(0, 500));
      return null;
    }
  } catch (error) {
    log.error(': Discovery API call failed:', error);
    return null;
  }
}

// Main discovery function - analyzes unclassified posts
export async function discoverEmergingNarratives(): Promise<EmergingNarrative[]> {
  const settings = await getSettings();

  // Check if discovery is enabled
  if (!settings.narrativeDetection?.discoveryEnabled) {
    log.debug(': Theme discovery is disabled');
    return [];
  }

  // Check if we have enough posts
  const threshold = settings.narrativeDetection?.discoveryThreshold ?? 50;
  if (unclassifiedPosts.length < threshold) {
    log.debug(`: Not enough unclassified posts (${unclassifiedPosts.length}/${threshold})`);
    return [];
  }

  log.debug(`: Running theme discovery on ${unclassifiedPosts.length} posts`);

  // Get existing themes to exclude
  const existingThemes = await getNarrativeThemes();

  // Take a sample of posts for analysis (max 50 per batch)
  const sampleSize = Math.min(50, unclassifiedPosts.length);
  const sample = unclassifiedPosts.slice(-sampleSize);
  const titles = sample.map(p => p.title);

  // Build prompt and call API
  const prompt = buildDiscoveryPrompt(titles, existingThemes);
  const result = await callDiscoveryApi(prompt);

  if (!result || result.clusters.length === 0) {
    log.debug(': No emerging narratives discovered');
    // Clear posts even if nothing found to avoid re-analysis
    clearUnclassifiedPosts();
    return [];
  }

  // Convert API results to EmergingNarrative objects
  const existingEmerging = await getEmergingNarratives();
  const newNarratives: EmergingNarrative[] = [];

  for (const cluster of result.clusters) {
    // Check if this cluster is similar to an existing emerging narrative
    const existingMatch = existingEmerging.find(
      e => e.suggestedName.toLowerCase() === cluster.name.toLowerCase()
    );

    if (existingMatch) {
      // Update existing with new sample titles
      existingMatch.postCount += cluster.postNumbers.length;
      existingMatch.sampleTitles = [
        ...new Set([
          ...existingMatch.sampleTitles,
          ...cluster.postNumbers.map(n => titles[n - 1]).filter(Boolean),
        ]),
      ].slice(0, 10);
    } else {
      // Create new emerging narrative
      const narrative: EmergingNarrative = {
        id: `emerging_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        suggestedName: cluster.name,
        description: cluster.description,
        sampleTitles: cluster.postNumbers.map(n => titles[n - 1]).filter(Boolean).slice(0, 10),
        firstSeen: Date.now(),
        postCount: cluster.postNumbers.length,
        status: 'pending',
      };
      newNarratives.push(narrative);
    }
  }

  // Save all emerging narratives (existing + new)
  const allEmerging = [...existingEmerging, ...newNarratives];
  await saveEmergingNarratives(allEmerging);

  // Clear analyzed posts
  clearUnclassifiedPosts();

  log.debug(`: Discovered ${newNarratives.length} new emerging narratives`);
  return newNarratives;
}

// Confirm an emerging narrative and convert it to an active theme
export async function confirmEmergingNarrative(
  narrativeId: string,
  customName?: string
): Promise<NarrativeTheme | null> {
  const emerging = await getEmergingNarratives();
  const narrative = emerging.find(e => e.id === narrativeId);

  if (!narrative) {
    log.error(': Emerging narrative not found:', narrativeId);
    return null;
  }

  // Create new theme from emerging narrative
  const newTheme: NarrativeTheme = {
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: customName || narrative.suggestedName,
    description: narrative.description,
    keywords: extractKeywordsFromTitles(narrative.sampleTitles),
    isSystemTheme: false,
    active: true,
    discoveredAt: narrative.firstSeen,
    exampleTitles: narrative.sampleTitles,
  };

  // Update narrative status
  narrative.status = 'confirmed';
  await saveEmergingNarratives(emerging);

  // Save and return the new theme (caller should add to theme list)
  return newTheme;
}

// Dismiss an emerging narrative
export async function dismissEmergingNarrative(narrativeId: string): Promise<void> {
  const emerging = await getEmergingNarratives();
  const narrative = emerging.find(e => e.id === narrativeId);

  if (narrative) {
    narrative.status = 'dismissed';
    await saveEmergingNarratives(emerging);
  }
}

// Extract keywords from sample titles
function extractKeywordsFromTitles(titles: string[]): string[] {
  // Simple keyword extraction - find common phrases/words
  const wordFreq = new Map<string, number>();

  for (const title of titles) {
    const words = title.toLowerCase().split(/\s+/);

    // Count individual words (excluding very common ones)
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
      'would', 'could', 'should', 'may', 'might', 'must', 'shall',
      'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further',
      'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
      'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
      'because', 'until', 'while', 'although', 'though', 'this',
      'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
      'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it',
      'its', 'they', 'them', 'their', 'what', 'which', 'who',
      'whom', 'whose', 'about', 'get', 'got', 'like', 'know',
      'think', 'make', 'see', 'look', 'want', 'give', 'use',
    ]);

    for (const word of words) {
      const cleaned = word.replace(/[^a-z]/g, '');
      if (cleaned.length > 3 && !stopWords.has(cleaned)) {
        wordFreq.set(cleaned, (wordFreq.get(cleaned) || 0) + 1);
      }
    }

    // Also look for 2-word phrases
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`.replace(/[^a-z\s]/g, '');
      if (phrase.length > 5) {
        wordFreq.set(phrase, (wordFreq.get(phrase) || 0) + 1);
      }
    }
  }

  // Return words/phrases that appear in at least 2 titles
  const keywords = Array.from(wordFreq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);

  return keywords;
}
