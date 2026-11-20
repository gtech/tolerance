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
// DeepSeek v4.1 Flash with thinking off replaced Qwen the same day, because Qwen felt
// slow in use: 52/53 in range, 10-post batches ~2.3s, images ~1.3s, on the cheapest
// provider ($0.02/$0.108 per million tokens). About fifty providers serve it at up to
// 15x that price, and OpenRouter's own choice landed on a $0.30/$1.20 one, so requests
// ask for the cheapest (CHEAPEST_PROVIDER_MODELS). The fastest providers answer a
// batch in ~0.35s, but at ~13x the cost (~$0.11 against ~$0.008 per 1000 posts).
export const DEFAULT_TEXT_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
// Llama 4 Scout's providers went unreliable (Oct 2026: Groq/Cerebras dropped it,
// the rest at 0-40% uptime); images now go to the same model as text
export const DEFAULT_IMAGE_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
export const DEFAULT_FULL_VIDEO_MODEL = 'google/gemini-2.5-flash-lite';
// Rewrites (Claude filter) and theme discovery
export const AUXILIARY_MODEL = 'openai/gpt-oss-120b';

// Every model this version asks for when nothing has been configured. Free keys can
// only call models on the server's allowlist (an OpenRouter guardrail), so each of
// these has to be on it BEFORE a release goes out: `pnpm check:models` compares this
// list with the live one, and the release script runs it first. A model added to the
// code has to be added here too, or the check can't see it.
export const FREE_KEY_MODELS: readonly string[] = [
  ...new Set([DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_FULL_VIDEO_MODEL, AUXILIARY_MODEL]),
];

// Models that think by default; scoring doesn't need it, so it's turned off
export const THINKING_OFF_MODELS = new Set([
  'deepseek/deepseek-v4.1-flash-1017',
  'qwen/qwen3.7-flash',
  'anthropic/claude-haiku-5.5',
  'openai/gpt-6-luna',
]);

// Models whose providers differ widely in price: OpenRouter is asked for the cheapest
export const CHEAPEST_PROVIDER_MODELS = new Set(['deepseek/deepseek-v4.1-flash-1017']);

// "Cheapest" to OpenRouter means the lowest input price. A day after the switch the
// lowest input price belonged to a provider charging $0.50 per million output tokens
// against $0.10 elsewhere, and a scoring call is about a third output, so it cost
// 2.4x as much. Providers above this output price are left out. If none is under it,
// OpenRouter answers 404 and the request is sent again without the cap.
export const MAX_OUTPUT_PRICE_PER_MILLION = 0.25;

// Providers running the model at 4-bit precision are never used (a decision made on
// 2026-11-20, for model welfare reasons). OpenRouter takes a list of the precisions
// that ARE acceptable, so this is everything from 8 bits up. Providers that don't say
// what they run ("unknown") are left out too: on that day about a dozen 8-bit
// providers sat under the fast route's price cap, so nothing is lost by it.
export const ALLOWED_QUANTIZATIONS: readonly string[] = ['int8', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32'];

export interface ProviderRouting {
  sort: 'price' | 'throughput';
  max_price?: { completion: number };
  quantizations: readonly string[];
}

export function providerRouting(model: string, capped = true): ProviderRouting | undefined {
  if (!CHEAPEST_PROVIDER_MODELS.has(model)) return undefined;
  return {
    sort: 'price',
    ...(capped ? { max_price: { completion: MAX_OUTPUT_PRICE_PER_MILLION } } : {}),
    quantizations: ALLOWED_QUANTIZATIONS,
  };
}

// The cheapest provider is sometimes a degraded one. On 2026-11-18 it was Ambient,
// which took 8.6s for an image call that another provider answered in 0.9s, and feeds
// sat behind the blur for up to 30s. A call on the cheapest route that takes longer
// than slowCallTimeoutMs is abandoned and sent again to the fastest provider, and the
// cheapest route is then left alone for FAST_ROUTE_HOLD_MS.
//
// The fast route has its own, looser output-price cap: the very fastest providers
// charge $2.40 per million output tokens, about ten times the cheap ones.
export const FAST_ROUTE_MAX_OUTPUT_PRICE_PER_MILLION = 0.6;
export const FAST_ROUTE_HOLD_MS = 10 * 60_000;

export function fastRouting(model: string): ProviderRouting | undefined {
  if (!CHEAPEST_PROVIDER_MODELS.has(model)) return undefined;
  return {
    sort: 'throughput',
    max_price: { completion: FAST_ROUTE_MAX_OUTPUT_PRICE_PER_MILLION },
    quantizations: ALLOWED_QUANTIZATIONS,
  };
}

// How long a call on the cheapest route may take before it counts as slow. A healthy
// provider answers an image call in ~1.3s and a 10-post batch in ~3s; a 40-video
// batch writes ~3,300 tokens, so the allowance grows with the number of posts.
export function slowCallTimeoutMs(isImageCall: boolean, postCount: number): number {
  return isImageCall ? 6_000 : 6_000 + 500 * Math.max(1, postCount);
}

// A 404 with a price cap means no provider under the cap: the same routing without it.
// The precision rule stays: a dearer provider is acceptable, a 4-bit one is not.
export function withoutPriceCap(routing: ProviderRouting): ProviderRouting {
  return { sort: routing.sort, quantizations: routing.quantizations };
}

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
