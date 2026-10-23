/* Figures in a PDF: charts, diagrams and pictures, each cropped from its
 * rendered page (t-d3dd407413, t-923bd86d2b).
 *
 * A chart exported from a chart tool is not a picture in the file but shapes
 * drawn on the page, so figures are found from where the page draws: every
 * shape and image is placed on the page through the drawing transforms, and
 * marks that touch become one group. Measured on the 23-page GitX report,
 * this found all 6 captioned figures and none of its tables, callout boxes
 * or code blocks (t-893723082e), once:
 * - clips (a path ended with endPath) and white fills - page backgrounds -
 *   are not marks;
 * - labels beside a drawing (axis names, titles, legends) join it, but no
 *   line of a caption does, even one that comes in several pieces;
 * - a drawing may touch its caption - lifelines and axes run down to it;
 * - drawings side by side above one caption are one figure (its panels).
 * A group is a figure when a "Figure N" caption sits just below it, when it
 * holds a picture, or when it is mostly drawing (text covers under 12%);
 * tables and callouts are mostly text. A page that is one picture with
 * hardly any text - a scan - is a figure as a whole.
 *
 * Known limit: a body-text line just above a figure can join its crop.
 */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { CAPTION, canvasPng, isFigureSize } from './figures.js';

const SCALE = 2;    // render at 2x, so a figure's labels stay legible
const PAD = 12;     // pixels of margin around a crop
const MIN_AREA = 0.03;
const MOSTLY_DRAWING = 0.12;

const ID = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function boxOf(m, x0, y0, x1, y1) {
  const pts = [apply(m, x0, y0), apply(m, x1, y0), apply(m, x0, y1), apply(m, x1, y1)];
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
export const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const near = (a, b, gap) => a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const white = (c) => /^#f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(String(c));

const STROKES = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILLS = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const IMAGES = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

/* Every visible shape and image on a page, in page space (points, y up). */
export async function marksOf(page) {
  const ops = await page.getOperatorList();
  const stack = [];
  let m = ID;
  let fill = '#000000';
  let stroke = '#000000';
  const shapes = [];
  const images = [];
  ops.fnArray.forEach((f, i) => {
    const a = ops.argsArray[i];
    if (f === OPS.save) stack.push([m, fill, stroke]);
    else if (f === OPS.restore) [m, fill, stroke] = stack.pop() || [ID, fill, stroke];
    else if (f === OPS.transform) m = mul(m, a);
    else if (f === OPS.paintFormXObjectBegin) { stack.push([m, fill, stroke]); if (a[0]) m = mul(m, a[0]); }
    else if (f === OPS.paintFormXObjectEnd) [m, fill, stroke] = stack.pop() || [m, fill, stroke];
    else if (f === OPS.setFillRGBColor) fill = a[0];
    else if (f === OPS.setStrokeRGBColor) stroke = a[0];
    else if (f === OPS.constructPath) {
      const mm = a[a.length - 1];
      const op = a[0];
      // A clip draws nothing; a white fill is a background, not a mark.
      const visible = (STROKES.has(op) && !white(stroke)) || (FILLS.has(op) && !white(fill));
      if (visible && mm && mm.length === 4 && Number.isFinite(mm[0])) shapes.push(boxOf(m, mm[0], mm[1], mm[2], mm[3]));
    } else if (IMAGES.has(f)) images.push(boxOf(m, 0, 0, 1, 1));
  });
  return { shapes, images };
}

function textsOf(content) {
  return content.items.filter((t) => t.str.trim()).map((t) => ({
    str: t.str,
    box: [t.transform[4], t.transform[5], t.transform[4] + t.width, t.transform[5] + (t.height || Math.abs(t.transform[3]))],
  }));
}

/* Each caption's lines: its first line, the lines that run on below it, and
 * every piece of text on those lines. */
function captionLines(texts) {
  const firsts = texts.filter((t) => CAPTION.test(t.str));
  const all = new Set();
  const byCaption = new Map();
  const below = [...texts].sort((x, y) => y.box[3] - x.box[3]);
  for (const c of firsts) {
    const lines = [c];
    let last = c;
    for (const t of below) {
      const h = last.box[3] - last.box[1];
      if (t.box[3] < last.box[1] && last.box[1] - t.box[3] < h * 0.9 && t.box[0] < c.box[0] + 40) { lines.push(t); last = t; }
    }
    const ys = lines.map((l) => l.box[1]);
    const pieces = texts.filter((t) => ys.some((y) => Math.abs(t.box[1] - y) < 2))
      .sort((a, b) => b.box[1] - a.box[1] || a.box[0] - b.box[0]);
    pieces.forEach((p) => all.add(p));
    byCaption.set(c, pieces.map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim());
  }
  return { firsts, all, byCaption };
}

/* The figures on one page, as boxes in page space with their captions. */
export function figuresOnPage({ view, shapes, images, texts }) {
  const pageArea = (view[2] - view[0]) * (view[3] - view[1]);
  // A scan: one picture over most of the page and hardly any text.
  if (texts.length < 3 && images.some((b) => area(b) > pageArea * 0.5)) {
    return [{ kind: 'page', box: [...view], caption: '', anchor: '' }];
  }
  const marks = [...shapes.filter((b) => area(b) < pageArea * 0.85), ...images.filter((b) => area(b) > pageArea * 0.005)];
  let groups = marks.map((b) => [...b]);
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (near(groups[i], groups[j], 6)) { groups[i] = union(groups[i], groups[j]); groups.splice(j, 1); changed = true; break outer; }
      }
    }
  }
  const caps = captionLines(texts);
  const cand = [];
  for (let g of groups) {
    if (area(g) < pageArea * MIN_AREA) continue;
    for (const t of texts) if (!caps.all.has(t) && near(t.box, g, 14)) g = union(g, t.box);
    cand.push({ box: g, caption: null });
  }
  // Each caption takes the nearest drawing above it, and the drawings beside that one.
  for (const c of caps.firsts) {
    const fits = (d) => !d.caption && d.box[1] >= c.box[1] - 4 && d.box[0] < c.box[2] && c.box[0] < d.box[2];
    const above = cand.filter((d) => fits(d) && d.box[3] > c.box[3] && d.box[1] - c.box[3] < 60);
    if (!above.length) continue;
    const first = above.sort((a, b) => a.box[1] - b.box[1])[0];
    for (const d of cand) if (!d.caption && d.box[1] >= c.box[1] - 4 && d.box[1] < first.box[3] && first.box[1] < d.box[3]) d.caption = c;
  }
  const merged = [];
  for (const d of cand) {
    const same = d.caption && merged.find((x) => x.caption === d.caption);
    if (same) same.box = union(same.box, d.box); else merged.push({ ...d });
  }
  const out = [];
  for (const d of merged) {
    const g = d.box;
    const inside = texts.filter((t) => t.box[0] >= g[0] - 2 && t.box[2] <= g[2] + 2 && t.box[1] >= g[1] - 2 && t.box[3] <= g[3] + 2);
    const cover = inside.reduce((s, t) => s + area(t.box), 0) / area(g);
    const hasImage = images.some((b) => area(b) > pageArea * 0.005 && near(b, g, 0));
    if (!d.caption && !hasImage && cover >= MOSTLY_DRAWING) continue;
    const drawn = shapes.some((b) => near(b, g, 0) && area(b) < pageArea * 0.85);
    const caption = d.caption ? caps.byCaption.get(d.caption) : '';
    // Without a caption, the nearest line of text above it says where it belongs.
    const before = texts.filter((t) => t.box[1] > g[3] && !caps.all.has(t)).sort((a, b) => a.box[1] - b.box[1])[0];
    out.push({ kind: hasImage && !drawn ? 'picture' : 'drawing', box: g, caption, anchor: caption || (before ? before.str : '') });
  }
  return out.sort((a, b) => b.box[3] - a.box[3]);
}

/* Render a page at SCALE and cut each figure out of it. */
async function crop(page, figures) {
  const vp = page.getViewport({ scale: SCALE });
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, canvas: c, viewport: vp }).promise;
  const out = [];
  for (const f of figures) {
    const [x0, y0] = vp.convertToViewportPoint(f.box[0], f.box[3]);
    const [x1, y1] = vp.convertToViewportPoint(f.box[2], f.box[1]);
    const left = Math.max(0, Math.floor(Math.min(x0, x1) - PAD));
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - PAD));
    const w = Math.min(c.width - left, Math.ceil(Math.abs(x1 - x0) + PAD * 2));
    const h = Math.min(c.height - top, Math.ceil(Math.abs(y1 - y0) + PAD * 2));
    if (!isFigureSize(w, h)) continue;
    const piece = createCanvas(w, h);
    piece.getContext('2d').drawImage(c, left, top, w, h, 0, 0, w, h);
    out.push({ ...f, ...canvasPng(piece) });
  }
  return out;
}

/* Every figure in an open pdf.js document, in reading order. headingAt(page)
 * names the heading a figure on that page sits under. */
export async function pdfFigures(doc, headingAt = () => '') {
  const out = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const { shapes, images } = await marksOf(page);
    if (!shapes.length && !images.length) { page.cleanup(); continue; }
    const texts = textsOf(await page.getTextContent());
    const found = figuresOnPage({ view: page.view, shapes, images, texts });
    if (found.length) {
      for (const f of await crop(page, found)) {
        out.push({ ...f, page: n, box: f.box.map((v) => Math.round(v * 10) / 10), heading: headingAt(n) });
      }
    }
    page.cleanup();
  }
  return out;
}
