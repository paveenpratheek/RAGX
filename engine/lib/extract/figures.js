/* What every reader shares about figures - charts, diagrams and pictures.
 *
 * A reader returns its figures beside its text blocks:
 *   { kind: 'drawing' | 'picture' | 'page' | 'image', page?, box?, caption,
 *     heading, anchor, png, width, height }
 * png is the figure as its own image, cropped to it (t-923bd86d2b); caption
 * is its "Figure N ..." line when it has one; anchor is text beside it in
 * the document, which search uses to bring a figure along with the passage
 * that explains it.
 *
 * Images are decoded and drawn with @napi-rs/canvas, the canvas pdf.js itself
 * installs for rendering pages, so no second image library comes in.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';

// "Figure 3", "Fig. 3" and "Fig 3" (Word papers often drop the full stop).
export const CAPTION = /^\s*(figure|fig\.?|chart|diagram|graph|exhibit)\s*\d+/i;

/* Pictures smaller than this on either side are equations, icons and
 * bullets saved as images, not figures (t-f1ec50cb5c). */
export const MIN_SIDE = 150;

/* Long sides beyond this are scaled down: embeddinggemma-2 shrinks every
 * image to a fixed size anyway, and the page shows figures at panel width. */
export const MAX_SIDE = 1600;

export const isFigureSize = (width, height) => width >= MIN_SIDE && height >= MIN_SIDE;

/* A canvas as a PNG no larger than MAX_SIDE on its long side. */
export function canvasPng(canvas) {
  const scale = Math.min(1, MAX_SIDE / Math.max(canvas.width, canvas.height));
  if (scale === 1) return { png: canvas.toBuffer('image/png'), width: canvas.width, height: canvas.height };
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const small = createCanvas(width, height);
  small.getContext('2d').drawImage(canvas, 0, 0, width, height);
  return { png: small.toBuffer('image/png'), width, height };
}

/* Any picture a document holds (PNG, JPEG, GIF, WebP, BMP) as a PNG on a
 * white ground - a transparent chart embeds as black on black otherwise.
 * null when it cannot be decoded: Word's EMF and WMF vector pictures are
 * left out rather than failing the document. */
export async function toPng(buf) {
  let img;
  try { img = await loadImage(buf); } catch (_) { return null; }
  if (!img.width || !img.height) return null;
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return { ...canvasPng(c), sourceWidth: img.width, sourceHeight: img.height };
}
