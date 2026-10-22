/* PDF: pdfjs gives positioned runs of text; lines, paragraphs and headings
 * are rebuilt from where those runs sit on the page.
 *
 * A PDF has no paragraphs, only glyphs at coordinates, so:
 * - runs at the same height (within half a font size) are one line, read
 *   left to right, with a space wherever the gap between runs is wider than
 *   a sliver of the font size;
 * - a gap between lines clearly wider than the page's usual line spacing
 *   starts a new paragraph;
 * - a short line set clearly larger than the body text is a heading, the
 *   larger sizes the higher levels; consecutive heading lines of one size are
 *   one heading, and large type running to three lines is a lead, not a
 *   heading;
 * - letter-spaced capitals are read as words, not single letters;
 * - a word hyphenated across a line break is joined back up.
 * Bare page numbers are dropped (t-721e55838f). Two-column layouts are read
 * across the columns - a known limit of reading by position (t-009ea77321).
 *
 * pdfjs-dist is the one library here (t-884a03a60e): a PDF's fonts, encodings
 * and compressed object streams are each a project of their own.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { ExtractError } from './errors.js';

const PAGE_NUMBER = /^\s*(?:page\s*)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$/i;

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function linesOf(items) {
  const runs = items
    .filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      size: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10,
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const r of runs) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - r.y) <= Math.max(line.size, r.size) * 0.5) line.runs.push(r);
    else lines.push({ y: r.y, size: r.size, runs: [r] });
    const l = lines[lines.length - 1];
    l.size = Math.max(l.size, r.size);
  }
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    let text = '';
    let end = null;
    for (const r of l.runs) {
      const gap = end === null ? 0 : r.x - end;
      if (end !== null && gap > r.size * 0.15 && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      /* Letter-spaced capitals can come from pdfjs as one run per word with a
       * space between every glyph ("D E S I G N") and the words as separate
       * runs; such a run loses its spaces. A whole letter-spaced line can also
       * come as ONE run with single spaces throughout, where the word breaks
       * are simply not in the text - collapsing that gives "PROJECTGITX", so
       * a run is only collapsed when it is short enough to be one word
       * (t-2bb35a8b73). */
      const glyphs = /^(?:\S ){2,}\S$/.test(r.str) ? r.str.replace(/ /g, '') : null;
      text += glyphs && glyphs.length <= 15 ? glyphs : r.str;
      end = r.x + r.w;
    }
    l.text = text.replace(/\s+/g, ' ').trim();
  }
  return lines.filter((l) => l.text && !PAGE_NUMBER.test(l.text));
}

function joinLines(a, b) {
  if (/[a-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return a + ' ' + b;
}

export async function extractPdf(buf) {
  let doc;
  // pdfjs 6 releases a document through the task that loaded it.
  const task = getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy();
    if (e && e.name === 'PasswordException') throw new ExtractError('encrypted', 'The PDF is password-protected.');
    throw new ExtractError('corrupt', `The PDF could not be opened: ${e && e.message}`);
  }

  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(linesOf(content.items));
      page.cleanup();
    }

    const all = pages.flat();
    if (all.reduce((s, l) => s + l.text.length, 0) < 10) {
      throw new ExtractError('scanned', 'The PDF has no text layer - it looks scanned, and OCR is not supported.');
    }

    // Body size: the size most of the text is set in, weighted by length.
    const weighted = [];
    for (const l of all) for (let i = 0; i < Math.min(l.text.length, 200); i += 10) weighted.push(Math.round(l.size * 10) / 10);
    const body = median(weighted);
    const headingSizes = [...new Set(all
      .filter((l) => l.size >= body * 1.2 && l.text.length <= 150)
      .map((l) => Math.round(l.size)))].sort((a, b) => b - a);
    const levelOf = (l) => {
      if (l.size < body * 1.2 || l.text.length > 150) return 0;
      return Math.min(headingSizes.indexOf(Math.round(l.size)) + 1, 3);
    };

    const blocks = [];
    pages.forEach((lines, i) => {
      const page = i + 1;
      // The usual line spacing, measured between body lines only: the space
      // around a heading is wider and would make every paragraph gap look normal.
      const spacing = median(lines.slice(1)
        .filter((l, j) => !levelOf(l) && !levelOf(lines[j]))
        .map((l) => lines[lines.indexOf(l) - 1].y - l.y)
        .filter((g) => g > 0)) || body * 1.2;
      let para = null;
      let heading = null; // the heading being built, while its lines continue
      const endHeading = () => {
        if (!heading) return;
        /* Large type that runs to three lines or a long sentence is a lead or
         * a subtitle, not a heading - it reads as text. */
        if (heading.lines >= 3 || heading.text.length > 150) blocks.push({ kind: 'para', text: heading.text, page });
        else blocks.push({ kind: 'heading', level: heading.level, text: heading.text, page });
        heading = null;
      };
      lines.forEach((l, j) => {
        const level = levelOf(l);
        if (level) {
          if (para) { blocks.push(para); para = null; }
          // A title set over two lines is one heading.
          const gap = j > 0 ? lines[j - 1].y - l.y : 0;
          if (heading && heading.level === level && gap <= l.size * 1.6) {
            heading.text = joinLines(heading.text, l.text);
            heading.lines++;
          } else {
            endHeading();
            heading = { level, text: l.text, lines: 1 };
          }
          return;
        }
        endHeading();
        const gap = j > 0 ? lines[j - 1].y - l.y : 0;
        if (para && gap > spacing * 1.4) { blocks.push(para); para = null; }
        if (para) para.text = joinLines(para.text, l.text);
        else para = { kind: 'para', text: l.text, page };
      });
      endHeading();
      if (para) blocks.push(para);
    });
    return { blocks, pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
