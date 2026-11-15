// Which model scores posts, given the provider settings.
import type { ApiProviderConfig } from './types';

// Default models for OpenRouter
// Gemini 2.5 Flash Lite replaced gpt-oss-120b (Oct 2026): on the scoring eval
// (scripts/eval) it scored 40/40 in range vs 32-36, got jokes gpt-oss missed, and
// answered a 10-post batch in ~2s vs ~4s at about the same cost.
// Gemini 2.5 Flash replaced Flash Lite (Oct 2026, spec v6): 50/52 in range vs 47/52.
// Flash Lite scored filler (throwaway one-liners, mundane updates) 2-3 whatever the
// rubric said, and teaser openings of cut-off long posts 7-8; Flash gets 5-6 for
// both. About 5x the cost, batches ~3.8s vs ~2s.
// Claude Haiku 5.5 with thinking off replaced Flash the same day: 52/53 in range,
// 10-post batches ~3.6s, ~$0.06 per 1000 posts vs ~$0.24, no malformed replies.
// With thinking on it takes ~8s a batch for no gain.
// Qwen 3.7 Flash with thinking off replaced Haiku (2026-11-15, spec v10): 51/53 in
// range, the same as Haiku on the same day, at $0.03/$0.13 per million tokens against
// $0.10/$0.50. Slower: 10-post batches ~6.9s vs ~3.6s, images ~4.0s vs ~2.6s. With
// thinking on it spends the whole token budget thinking and returns nothing.
export const DEFAULT_TEXT_MODEL = 'qwen/qwen3.7-flash';
// Llama 4 Scout's providers went unreliable (Oct 2026: Groq/Cerebras dropped it,
// the rest at 0-40% uptime); images now go to the same model as text
export const DEFAULT_IMAGE_MODEL = 'qwen/qwen3.7-flash';
export const DEFAULT_FULL_VIDEO_MODEL = 'google/gemini-2.5-flash-lite';

// Models that think by default; scoring doesn't need it, so it's turned off
export const THINKING_OFF_MODELS = new Set(['qwen/qwen3.7-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-luna']);

export interface ScoringModels {
  textModel: string;
  imageModel: string;
  videoModel: string;
}

const named = (value: string | undefined): string => (value ?? '').trim();

export function scoringModels(provider: ApiProviderConfig): ScoringModels {
  // OpenRouter has one model field, used for text and images alike. Until it has been
  // saved once, settings from before the field existed keep working as they did
  // (the custom-endpoint model names were sent to OpenRouter too).
  if (provider.type !== 'openai-compatible' && provider.openRouterModel !== undefined) {
    const chosen = named(provider.openRouterModel);
    return {
      textModel: chosen || DEFAULT_TEXT_MODEL,
      imageModel: chosen || DEFAULT_IMAGE_MODEL,
      videoModel: chosen || DEFAULT_FULL_VIDEO_MODEL,
    };
  }
  return {
    textModel: named(provider.textModel) || DEFAULT_TEXT_MODEL,
    imageModel: named(provider.imageModel) || DEFAULT_IMAGE_MODEL,
    videoModel: named(provider.imageModel) || DEFAULT_FULL_VIDEO_MODEL,
  };
}
