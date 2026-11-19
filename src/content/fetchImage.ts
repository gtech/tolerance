// Fetch an image from the page's side, shrink it to at most 512px and return it as a
// base64 data URL. The background asks for this (FETCH_IMAGE_BASE64) because a site's
// image server often refuses requests that don't come from the site's own pages.
export async function fetchImageAsBase64(url: string): Promise<string> {
  const MAX_SIZE = 512;

  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const img = await createImageBitmap(await response.blob());
  let { width, height } = img;
  if (width > MAX_SIZE || height > MAX_SIZE) {
    if (width > height) {
      height = Math.round((height / width) * MAX_SIZE);
      width = MAX_SIZE;
    } else {
      width = Math.round((width / height) * MAX_SIZE);
      height = MAX_SIZE;
    }
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(img, 0, 0, width, height);
  const resized = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(resized);
  });
}
