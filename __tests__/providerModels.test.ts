import { describe, it, expect } from 'vitest';
import { CHEAPEST_PROVIDER_MODELS, DEFAULT_IMAGE_MODEL, DEFAULT_TEXT_MODEL, THINKING_OFF_MODELS, providerRouting, scoringModels } from '../src/shared/provider-models';

describe('scoring models', () => {
  it('uses the defaults when nothing is set', () => {
    const models = scoringModels({ type: 'openrouter' });
    expect(models.textModel).toBe(DEFAULT_TEXT_MODEL);
    expect(models.imageModel).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('turns thinking off for the default model', () => {
    expect(THINKING_OFF_MODELS.has(DEFAULT_TEXT_MODEL)).toBe(true);
    expect(THINKING_OFF_MODELS.has(DEFAULT_IMAGE_MODEL)).toBe(true);
  });

  it('asks for the cheapest provider of the default model', () => {
    expect(CHEAPEST_PROVIDER_MODELS.has(DEFAULT_TEXT_MODEL)).toBe(true);
    expect(CHEAPEST_PROVIDER_MODELS.has(DEFAULT_IMAGE_MODEL)).toBe(true);
  });

  it('caps the output price for the default model, and can drop the cap', () => {
    expect(providerRouting(DEFAULT_TEXT_MODEL)).toEqual({ sort: 'price', max_price: { completion: 0.25 } });
    expect(providerRouting(DEFAULT_TEXT_MODEL, false)).toEqual({ sort: 'price' });
    expect(providerRouting('anthropic/claude-haiku-5.5')).toBeUndefined();
  });

  it('uses the OpenRouter model for text and images', () => {
    const models = scoringModels({ type: 'openrouter', openRouterModel: ' google/gemini-2.5-flash ' });
    expect(models.textModel).toBe('google/gemini-2.5-flash');
    expect(models.imageModel).toBe('google/gemini-2.5-flash');
  });

  it('goes back to the default when the OpenRouter field is emptied, ignoring old custom names', () => {
    const models = scoringModels({ type: 'openrouter', openRouterModel: '', textModel: 'llama3.2', imageModel: 'llava' });
    expect(models.textModel).toBe(DEFAULT_TEXT_MODEL);
    expect(models.imageModel).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('keeps settings from before the field existed working as they did', () => {
    const models = scoringModels({ type: 'openrouter', textModel: 'openai/gpt-oss-120b' });
    expect(models.textModel).toBe('openai/gpt-oss-120b');
    expect(models.imageModel).toBe(DEFAULT_IMAGE_MODEL);
  });

  it('leaves a custom endpoint on its own model names', () => {
    const models = scoringModels({ type: 'openai-compatible', openRouterModel: 'qwen/qwen3.7-flash', textModel: 'llama3.2', imageModel: 'llava' });
    expect(models.textModel).toBe('llama3.2');
    expect(models.imageModel).toBe('llava');
  });
});
