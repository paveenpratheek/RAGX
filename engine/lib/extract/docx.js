/* .docx: unzip, then walk word/document.xml in order, keeping headings,
 * paragraphs, list items and tables as blocks.
 *
 * Headings come from the paragraph's style. Word names its built-in heading
 * styles "heading 1".."heading 9" whatever the styleId says (it is localised
 * in some versions), and a custom style can be a heading by carrying an
 * outline level, directly or through the style it is based on - so all three
 * are read from styles.xml.
 *
 * Text a reader of the printed page would not see is left out: deleted text
 * from tracked changes (w:delText), field instructions (w:instrText), and the
 * fallback copy Word writes of every text box (mc:Fallback), which would
 * otherwise put each text box in the document twice (t-495064c11e).
 */
import { readZip } from './zip.js';
import { tokens, attr } from './xml.js';
import { ExtractError } from './errors.js';

function headingLevels(stylesXml) {
  const styles = new Map(); // styleId -> { name, basedOn, outline }
  let cur = null;
  for (const t of tokens(stylesXml)) {
    if (t.type === 'open' && t.name === 'w:style') {
      cur = { id: attr(t.attrs, 'w:styleId'), name: '', basedOn: null, outline: null };
    } else if (t.type === 'close' && t.name === 'w:style') {
      if (cur && cur.id) styles.set(cur.id, cur);
      cur = null;
    } else if (cur && (t.type === 'self' || t.type === 'open')) {
      if (t.name === 'w:name') cur.name = attr(t.attrs, 'w:val') || '';
      else if (t.name === 'w:basedOn') cur.basedOn = attr(t.attrs, 'w:val');
      else if (t.name === 'w:outlineLvl') cur.outline = Number(attr(t.attrs, 'w:val'));
    }
  }
  const levels = new Map();
  const levelOf = (id, seen = new Set()) => {
    const s = styles.get(id);
    if (!s || seen.has(id)) return null;
    seen.add(id);
    const named = /^heading\s*([1-9])$/i.exec(s.name.trim());
    if (named) return Number(named[1]);
    if (/^title$/i.test(s.name.trim())) return 1;
    if (Number.isInteger(s.outline) && s.outline >= 0 && s.outline < 9) return s.outline + 1;
    return s.basedOn ? levelOf(s.basedOn, seen) : null;
  };
  for (const id of styles.keys()) {
    const l = levelOf(id);
    if (l) levels.set(id, l);
  }
  return levels;
}

export function extractDocx(buf) {
  const zip = readZip(buf);
  const docXml = zip.read('word/document.xml');
  if (!docXml) throw new ExtractError('corrupt', 'This is a ZIP file but not a Word document (no word/document.xml).');
  const stylesXml = zip.read('word/styles.xml');
  const levels = stylesXml ? headingLevels(stylesXml.toString('utf8')) : new Map();

  const blocks = [];
  const paras = [];   // stack: a text box puts a paragraph inside a paragraph
  const tables = [];  // stack: tables nest
  let inText = false;
  let skip = 0;       // depth inside a subtree to ignore

  const emit = (p) => {
    const text = p.parts.join('').replace(/\t/g, ' ').replace(/[  ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    if (!text) return;
    const table = tables[tables.length - 1];
    if (table && table.cell) { table.cell.push(text); return; }
    const level = p.outline ?? (p.style ? levels.get(p.style) : null);
    if (level) blocks.push({ kind: 'heading', level, text });
    else blocks.push({ kind: 'para', text: p.list ? '- ' + text : text });
  };

  for (const t of tokens(docXml.toString('utf8'))) {
    if (skip) {
      if (t.type === 'open') skip++;
      else if (t.type === 'close') skip--;
      continue;
    }
    const p = paras[paras.length - 1];
    if (t.type === 'text') {
      if (inText && p) p.parts.push(t.text);
      continue;
    }
    const open = t.type === 'open';
    const self = t.type === 'self';
    switch (t.name) {
      case 'mc:Fallback':
      case 'w:delText':
      case 'w:instrText':
        if (open) skip = 1;
        break;
      case 'w:p':
        if (open) paras.push({ parts: [], style: null, outline: null, list: false });
        else if (t.type === 'close') { const done = paras.pop(); if (done) emit(done); }
        break;
      case 'w:pStyle':
        if (p) p.style = attr(t.attrs, 'w:val');
        break;
      case 'w:outlineLvl':
        if (p) { const n = Number(attr(t.attrs, 'w:val')); if (n >= 0 && n < 9) p.outline = n + 1; }
        break;
      case 'w:numPr':
        if (p) p.list = true;
        break;
      case 'w:t':
        inText = open;
        break;
      case 'w:tab':
        if (p && self) p.parts.push('\t');
        break;
      case 'w:br':
      case 'w:cr':
        if (p && self) p.parts.push('\n');
        break;
      case 'w:tbl':
        if (open) tables.push({ rows: [], row: null, cell: null });
        else if (t.type === 'close') {
          const done = tables.pop();
          if (!done || !done.rows.length) break;
          const outer = tables[tables.length - 1];
          if (outer && outer.cell) outer.cell.push(done.rows.join(' / '));
          else blocks.push({ kind: 'table', rows: done.rows, text: done.rows.join('\n') });
        }
        break;
      case 'w:tr':
        if (tables.length) {
          const tb = tables[tables.length - 1];
          if (open) tb.row = [];
          else if (t.type === 'close' && tb.row) {
            if (tb.row.some((c) => c)) tb.rows.push(tb.row.join(' | '));
            tb.row = null;
          }
        }
        break;
      case 'w:tc':
        if (tables.length) {
          const tb = tables[tables.length - 1];
          if (open) tb.cell = [];
          else if (t.type === 'close' && tb.cell) {
            if (tb.row) tb.row.push(tb.cell.join(' '));
            tb.cell = null;
          }
        }
        break;
      default:
        break;
    }
  }
  return { blocks, pages: null };
}
