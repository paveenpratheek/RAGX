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
 *
 * Pictures come out as figures, each with the caption beside it and the
 * heading it sits under (t-d3dd407413); ones smaller than 150 pixels on
 * either side are equations and icons, not figures (t-f1ec50cb5c), and EMF
 * or WMF pictures, which nothing here can draw, are left out. A native Word
 * chart holds its data, not a picture: it becomes a "Chart:" line and a
 * table of its series where it stands, so its numbers can be found and
 * cited exactly (t-406a8da372).
 */
import { readZip } from './zip.js';
import { tokens, attr } from './xml.js';
import { ExtractError } from './errors.js';
import { CAPTION, isFigureSize, toPng } from './figures.js';

/* Relationship id -> part name, for word/document.xml. */
function relations(zip) {
  const xml = zip.read('word/_rels/document.xml.rels');
  const out = new Map();
  if (!xml) return out;
  for (const t of tokens(xml.toString('utf8'))) {
    if ((t.type === 'self' || t.type === 'open') && t.name === 'Relationship') {
      const target = attr(t.attrs, 'Target');
      if (target && attr(t.attrs, 'TargetMode') !== 'External') {
        out.set(attr(t.attrs, 'Id'), target.startsWith('/') ? target.slice(1) : 'word/' + target.replace(/^\.\//, ''));
      }
    }
  }
  return out;
}

const CHART_KINDS = {
  'c:barChart': 'bar chart', 'c:bar3DChart': 'bar chart', 'c:lineChart': 'line chart', 'c:line3DChart': 'line chart',
  'c:pieChart': 'pie chart', 'c:pie3DChart': 'pie chart', 'c:doughnutChart': 'doughnut chart', 'c:areaChart': 'area chart',
  'c:scatterChart': 'scatter chart', 'c:radarChart': 'radar chart', 'c:bubbleChart': 'bubble chart',
};

/* A chart part's title, kind and series as text blocks: a "Chart:" line and
 * a table with a column per series. Values are the numbers Word cached when
 * the chart was last drawn - what the chart shows. */
export function chartBlocks(xml) {
  let kind = null;
  const title = [];
  let inTitle = 0;
  const series = [];
  let ser = null;
  let part = null; // 'tx' | 'cat' | 'val' inside a series
  let pt = null;
  let inV = false;
  for (const t of tokens(xml)) {
    if (t.type === 'text') {
      if (ser && part && inV) {
        if (part === 'tx') ser.name += t.text;
        else if (pt !== null) ser[part][pt] = (ser[part][pt] || '') + t.text;
      } else if (inTitle && !ser) title.push(t.text);
      continue;
    }
    const open = t.type === 'open';
    const close = t.type === 'close';
    if (CHART_KINDS[t.name]) { if (open && !kind) kind = CHART_KINDS[t.name]; }
    else if (t.name === 'c:title' && !ser) inTitle += open ? 1 : close ? -1 : 0;
    else if (t.name === 'c:ser') {
      if (open) ser = { name: '', cat: [], val: [] };
      else if (close && ser) { series.push(ser); ser = null; }
    } else if (ser && ['c:tx', 'c:cat', 'c:xVal', 'c:val', 'c:yVal'].includes(t.name)) {
      const which = t.name === 'c:tx' ? 'tx' : t.name === 'c:cat' || t.name === 'c:xVal' ? 'cat' : 'val';
      if (open) part = which; else if (close) part = null;
    } else if (t.name === 'c:pt') { if (open) pt = Number(attr(t.attrs, 'idx')); else if (close) pt = null; }
    else if (t.name === 'c:v') inV = open;
  }
  if (!series.length) return [];
  const line = `Chart: ${title.join('').trim() || 'untitled'}${kind ? ` (${kind})` : ''}`;
  const count = Math.max(...series.map((x) => Math.max(x.cat.length, x.val.length)));
  const cats = Array.from({ length: count }, (_, i) => series.map((x) => x.cat[i]).find((c) => c != null) ?? String(i + 1));
  const rows = [['Category', ...series.map((x, i) => x.name.trim() || `Series ${i + 1}`)].join(' | ')];
  for (let i = 0; i < count; i++) rows.push([cats[i], ...series.map((x) => x.val[i] ?? '')].join(' | '));
  return [{ kind: 'para', text: line }, { kind: 'table', rows, text: rows.join('\n') }];
}

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

export async function extractDocx(buf) {
  const zip = readZip(buf);
  const docXml = zip.read('word/document.xml');
  if (!docXml) throw new ExtractError('corrupt', 'This is a ZIP file but not a Word document (no word/document.xml).');
  const stylesXml = zip.read('word/styles.xml');
  const levels = stylesXml ? headingLevels(stylesXml.toString('utf8')) : new Map();
  const rels = relations(zip);
  const pictures = []; // { part, alt, at: how many blocks came before it, own: its paragraph has text }

  const blocks = [];
  const paras = [];   // stack: a text box puts a paragraph inside a paragraph
  const tables = [];  // stack: tables nest
  let inText = false;
  let skip = 0;       // depth inside a subtree to ignore

  const emit = (p) => {
    const text = p.parts.join('').replace(/\t/g, ' ').replace(/[  ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    const table = tables[tables.length - 1];
    const inCell = Boolean(table && table.cell);
    if (text) {
      if (inCell) table.cell.push(text);
      else {
        const level = p.outline ?? (p.style ? levels.get(p.style) : null);
        if (level) blocks.push({ kind: 'heading', level, text });
        else blocks.push({ kind: 'para', text: p.list ? '- ' + text : text, ...(/caption/i.test(p.style || '') ? { caption: true } : {}) });
      }
    }
    for (const pic of p.pics) pictures.push({ ...pic, at: blocks.length, own: Boolean(text) && !inCell });
    for (const rid of p.charts) {
      const part = rels.get(rid);
      const xml = part && zip.read(part);
      if (xml) blocks.push(...chartBlocks(xml.toString('utf8')));
    }
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
        if (open) paras.push({ parts: [], style: null, outline: null, list: false, pics: [], charts: [], alt: '' });
        else if (t.type === 'close') { const done = paras.pop(); if (done) emit(done); }
        break;
      case 'w:pStyle':
        if (p) p.style = attr(t.attrs, 'w:val');
        break;
      case 'wp:docPr':
        if (p) p.alt = attr(t.attrs, 'descr') || attr(t.attrs, 'title') || '';
        break;
      case 'a:blip': {
        const part = rels.get(attr(t.attrs, 'r:embed'));
        if (p && part) p.pics.push({ part, alt: p.alt });
        break;
      }
      case 'c:chart': {
        const rid = attr(t.attrs, 'r:id');
        if (p && rid) p.charts.push(rid);
        break;
      }
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
  return { blocks, pages: null, figures: await pictureFigures(zip, pictures, blocks) };
}

/* Each picture decoded, with its caption: a "Figure N" or Caption-styled
 * paragraph right after it, else its own paragraph's text, else the one
 * before it - and a caption belongs to one picture only, so a picture with
 * none never takes the caption under the picture before it (t-d066c2071f). */
async function pictureFigures(zip, pictures, blocks) {
  const taken = new Set();
  const isCaption = (b) => Boolean(b && b.kind === 'para' && (b.caption || CAPTION.test(b.text)));
  const captionLike = (b) => isCaption(b) && !taken.has(b);
  const out = [];
  for (const pic of pictures) {
    const data = zip.read(pic.part);
    if (!data) continue;
    const img = await toPng(data);
    if (!img || !isFigureSize(img.sourceWidth, img.sourceHeight)) continue;
    const own = pic.own ? blocks[pic.at - 1] : null;
    const cap = [blocks[pic.at], own, blocks[pic.at - (pic.own ? 2 : 1)]].find(captionLike);
    if (cap) taken.add(cap);
    let heading = '';
    for (let i = 0; i < pic.at; i++) if (blocks[i].kind === 'heading') heading = blocks[i].text;
    // Another picture's caption says nothing about this one.
    const before = blocks.slice(0, pic.at).reverse().find((b) => b.kind === 'para' && !isCaption(b));
    const caption = cap ? cap.text : '';
    out.push({
      kind: 'picture', page: null, box: null, caption, heading,
      anchor: caption || pic.alt || (before ? before.text.slice(0, 200) : ''),
      png: img.png, width: img.width, height: img.height,
    });
  }
  return out;
}
