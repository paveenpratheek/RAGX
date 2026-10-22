/* One door for every supported format. Each reader returns
 *   { blocks: [{ kind: 'heading' | 'para' | 'code' | 'table', text, level?, page?, rows? }], pages }
 * in reading order; the chunker takes it from there.
 */
import { extractDocx } from './docx.js';
import { extractPdf } from './pdf.js';
import { extractMarkdown } from './markdown.js';
import { extractText, decodeText } from './text.js';
import { ExtractError } from './errors.js';

export { ExtractError };

const READERS = {
  '.pdf': (buf) => extractPdf(buf),
  '.docx': (buf) => extractDocx(buf),
  '.md': (buf) => extractMarkdown(decodeText(buf)),
  '.markdown': (buf) => extractMarkdown(decodeText(buf)),
  '.txt': (buf) => extractText(decodeText(buf)),
  '.text': (buf) => extractText(decodeText(buf)),
};

export const SUPPORTED = Object.keys(READERS);

export async function extract(buf, ext) {
  const read = READERS[String(ext).toLowerCase()];
  if (!read) {
    throw new ExtractError('unsupported', `${ext || 'This file type'} is not supported - use ${SUPPORTED.join(', ')}.`);
  }
  const out = await read(buf);
  if (!out.blocks.some((b) => b.text.trim())) throw new ExtractError('empty', 'The document has no text.');
  return out;
}
