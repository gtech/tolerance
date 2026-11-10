// A fingerprint of what an image looks like, so the same picture posted by different
// accounts can be recognised later without keeping the picture.
//
// It is a "difference hash": the image is reduced to a 9x8 grid of average brightness
// and, along each row, each cell is compared with its right-hand neighbour (brighter or
// not). That gives 64 bits, written as 16 hex characters. Resizing, recompressing or
// mildly recolouring an image changes few of them; a different image changes about half.
// Cropping, mirroring or adding a border does change it: this recognises re-uploads, not
// edits. See MATCH_DISTANCE for how close counts as the same.
//
// Each grid cell is the average of every pixel inside it. Letting the canvas shrink the
// image to 9x8 directly samples only a few pixels per cell, and the same picture at two
// sizes then came out up to 22 bits apart (measured on real images).

export const HASH_WIDTH = 9;
export const HASH_HEIGHT = 8;

function hashFromGrey(grey: ArrayLike<number>): string {
  let hex = '';
  for (let row = 0; row < HASH_HEIGHT; row++) {
    let byte = 0;
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      byte = (byte << 1) | (grey[row * HASH_WIDTH + col] > grey[row * HASH_WIDTH + col + 1] ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// From the RGBA pixels of an image of any size (at least 9x8)
export function dhashFromPixels(pixels: ArrayLike<number>, width: number, height: number): string | undefined {
  if (width < HASH_WIDTH || height < HASH_HEIGHT || pixels.length < width * height * 4) return undefined;
  const sum = new Array<number>(HASH_WIDTH * HASH_HEIGHT).fill(0);
  const count = new Array<number>(HASH_WIDTH * HASH_HEIGHT).fill(0);
  for (let y = 0; y < height; y++) {
    const row = Math.min(HASH_HEIGHT - 1, Math.floor(y * HASH_HEIGHT / height));
    for (let x = 0; x < width; x++) {
      const cell = row * HASH_WIDTH + Math.min(HASH_WIDTH - 1, Math.floor(x * HASH_WIDTH / width));
      const i = (y * width + x) * 4;
      sum[cell] += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      count[cell]++;
    }
  }
  return hashFromGrey(sum.map((s, i) => s / count[i]));
}

// At or under this many differing bits, treat two hashes as the same picture. Measured in
// a browser on 12 real images: a copy resized to 512px or 900px and recompressed differed
// by 0-4 bits, and a harsh 200px low-quality copy by up to 9; different images differed by
// at least 13, and the closest of those were screenshots of the same page layout.
export const MATCH_DISTANCE = 8;

// How many of the 64 bits differ
export function hashDistance(a: string, b: string): number {
  const valid = /^[0-9a-f]{16}$/i;
  if (!valid.test(a) || !valid.test(b)) return 64;
  let bits = 0;
  for (let i = 0; i < 16; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { bits += x & 1; x >>= 1; }
  }
  return bits;
}

// A blank or nearly flat image hashes to almost all zeros (or ones), and so matches
// every other flat image. Such a hash says nothing and shouldn't be used for matching.
export function isFlatHash(hash: string): boolean {
  const set = hashDistance(hash, '0000000000000000');
  return set < 6 || set > 58;
}
