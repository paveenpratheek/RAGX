/* Plain text: decode, then split into paragraphs at blank lines.
 *
 * Windows text files come in more than one encoding. A byte-order mark says
 * which when it is there; Notepad's "Unicode" (UTF-16 LE) is also written
 * without one by some tools, and shows as a zero byte after every ASCII
 * letter, so that is checked before falling back to UTF-8.
 */

export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const sample = buf.subarray(0, Math.min(buf.length, 2000) & ~1);
  let oddZeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) oddZeros++;
  if (sample.length >= 4 && oddZeros / (sample.length / 2) > 0.3) return buf.toString('utf16le');
  return buf.toString('utf8');
}

export function extractText(text) {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/[ \t]+\n/g, '\n').trim())
    .filter(Boolean)
    .map((p) => ({ kind: 'para', text: p }));
  return { blocks, pages: null };
}
