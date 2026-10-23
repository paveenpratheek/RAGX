/* An image file added on its own is one figure and no text (t-d3dd407413).
 * It is kept whatever its size - the user chose it - and its file name is
 * the only words about it until search can describe it. */
import { ExtractError } from './errors.js';
import { toPng } from './figures.js';

export async function extractImage(buf) {
  const img = await toPng(buf);
  if (!img) throw new ExtractError('corrupt', 'The image could not be read.');
  return {
    blocks: [],
    pages: null,
    figures: [{ kind: 'image', page: null, box: null, caption: '', heading: '', anchor: '', png: img.png, width: img.width, height: img.height }],
  };
}
