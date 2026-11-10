import { describe, it, expect } from 'vitest';
import { dhashFromPixels, hashDistance, isFlatHash, MATCH_DISTANCE, HASH_WIDTH, HASH_HEIGHT } from '../src/shared/image-hash';

// An image of any size from a brightness function over the unit square, as the RGBA
// bytes a canvas would give
function image(width: number, height: number, brightness: (u: number, v: number) => number, tint: [number, number, number] = [1, 1, 1]): number[] {
  const px: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(255, brightness((x + 0.5) / width, (y + 0.5) / height)));
      px.push(v * tint[0], v * tint[1], v * tint[2], 255);
    }
  }
  return px;
}
const hash = (w: number, h: number, f: (u: number, v: number) => number, tint?: [number, number, number]) => dhashFromPixels(image(w, h, f, tint), w, h)!;

// A smooth made-up picture: overlapping waves, different for each seed
const picture = (seed: number) => (u: number, v: number) =>
  128 + 60 * Math.sin(u * 7 + seed) * Math.cos(v * 5 - seed) + 50 * Math.sin((u + v) * 9 + seed * 3) + 30 * Math.cos(u * 13 - v * 3 + seed);

describe('dhashFromPixels', () => {
  it('gives 16 hex characters', () => {
    expect(hash(64, 48, picture(1))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reads brightness falling left to right as all ones, rising as all zeros', () => {
    expect(hash(90, 80, u => 240 - u * 200)).toBe('ffffffffffffffff');
    expect(hash(90, 80, u => u * 200)).toBe('0000000000000000');
  });

  it('gives the same picture at different sizes a matching hash', () => {
    const base = hash(360, 320, picture(4));
    // Half size lines up cell for cell; awkward sizes shift cell edges by a fraction of a pixel
    expect(hashDistance(base, hash(180, 160, picture(4)))).toBeLessThanOrEqual(1);
    for (const [w, h] of [[512, 455], [97, 86], [45, 40]]) {
      expect(hashDistance(base, hash(w, h, picture(4)))).toBeLessThanOrEqual(MATCH_DISTANCE);
    }
  });

  it('is unchanged by making the whole image brighter, dimmer or tinted', () => {
    const base = hash(90, 80, picture(7));
    expect(hash(90, 80, (u, v) => picture(7)(u, v) * 0.6)).toBe(base);
    expect(hash(90, 80, (u, v) => picture(7)(u, v) * 0.8 + 30)).toBe(base);
    expect(hash(90, 80, picture(7), [1, 0.9, 0.8])).toBe(base);
  });

  it('stays within the match distance under compression-like noise, and far outside it for another picture', () => {
    const base = hash(180, 160, picture(7));
    // Per-pixel noise, like compression artefacts: averaged away inside each cell
    const speckle = (u: number, v: number) => picture(7)(u, v) + (Math.sin(u * 9173 + v * 7919) * 25);
    expect(hashDistance(base, hash(180, 160, speckle))).toBeLessThanOrEqual(MATCH_DISTANCE);
    expect(hashDistance(base, hash(180, 160, picture(8)))).toBeGreaterThan(MATCH_DISTANCE * 2);
  });

  it('accepts an image already at 9x8, and nothing smaller or truncated', () => {
    expect(dhashFromPixels(image(HASH_WIDTH, HASH_HEIGHT, picture(2)), HASH_WIDTH, HASH_HEIGHT)).toMatch(/^[0-9a-f]{16}$/);
    expect(dhashFromPixels(image(8, 8, picture(2)), 8, 8)).toBeUndefined();
    expect(dhashFromPixels([1, 2, 3, 4], 90, 80)).toBeUndefined();
  });
});

describe('hashDistance', () => {
  it('counts differing bits', () => {
    expect(hashDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hashDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hashDistance('ffffffffffffffff', '0000000000000000')).toBe(64);
  });

  it('treats anything malformed as completely different', () => {
    expect(hashDistance('abc', '0000000000000000')).toBe(64);
    expect(hashDistance('zzzzzzzzzzzzzzzz', '0000000000000000')).toBe(64);
  });
});

describe('isFlatHash', () => {
  it('flags blank and one-directional images, not ordinary ones', () => {
    expect(isFlatHash('0000000000000000')).toBe(true);
    expect(isFlatHash('ffffffffffffffff')).toBe(true);
    expect(isFlatHash(hash(90, 80, () => 128))).toBe(true);
    expect(isFlatHash(hash(90, 80, picture(3)))).toBe(false);
  });
});
