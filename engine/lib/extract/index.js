/* One door for every supported format. Each reader returns
 *   { blocks: [{ kind: 'heading' | 'para' | 'code' | 'table', text, level?, page?, rows? }], pages, figures?, links? }
 * links are images a Markdown file links on this machine, by heading path.
 * in reading order; the chunker takes the blocks from there, and figures are
 * described in figures.js.
 */
import { extractDocx } from './docx.js';
import { extractPdf } from './pdf.js';
import { extractMarkdown } from './markdown.js';
import { extractText, decodeText } from './text.js';
import { extractImage } from './image.js';
import { ExtractError } from './errors.js';

export { ExtractError };

const READERS = {
  '.pdf': (buf) => extractPdf(buf),
  '.docx': (buf) => extractDocx(buf),
  '.md': (buf) => extractMarkdown(decodeText(buf)),
  '.markdown': (buf) => extractMarkdown(decodeText(buf)),
  '.txt': (buf) => extractText(decodeText(buf)),
  '.text': (buf) => extractText(decodeText(buf)),
  '.png': extractImage,
  '.jpg': extractImage,
  '.jpeg': extractImage,
  '.webp': extractImage,
  '.gif': extractImage,
};

export const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

export const SUPPORTED = Object.keys(READERS);

export async function extract(buf, ext) {
  const read = READERS[String(ext).toLowerCase()];
  if (!read) {
    throw new ExtractError('unsupported', `${ext || 'This file type'} is not supported - use ${SUPPORTED.join(', ')}.`);
  }
  const out = await read(buf);
  out.figures = out.figures || [];
  out.links = out.links || [];
  // A document of figures alone - an image file, a scanned PDF - is kept for them.
  if (!out.blocks.some((b) => b.text.trim()) && !out.figures.length) throw new ExtractError('empty', 'The document has no text.');
  return out;
}
