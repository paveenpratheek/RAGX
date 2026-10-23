/* Figures: charts, diagrams and pictures found in PDF, Word and image files,
 * each cropped to its own PNG with its caption (t-d3dd407413). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { extract, ExtractError } from '../engine/lib/extract/index.js';
import { figuresOnPage } from '../engine/lib/extract/pdf-figures.js';
import { CAPTION, isFigureSize } from '../engine/lib/extract/figures.js';
import { Engine } from '../engine/lib/engine.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';
import { makeDocx, makePdf, w, chartXml, draw, barChartPage, READER } from './fixtures.js';

function png(width, height, colour = '#3a7bd5') {
  const c = createCanvas(width, height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = colour;
  ctx.fillRect(10, 10, width - 20, height - 20);
  return c.toBuffer('image/png');
}
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

test('captions are "Figure N", "Fig. N" and "Fig N"; a figure is at least 150 pixels on each side', () => {
  for (const s of ['Figure 6 - Every reader arm', 'Fig. 4 Radiation pattern', 'Fig 1 Antenna design', 'Chart 2: revenue']) assert.match(s, CAPTION);
  for (const s of ['Figures show that', 'In figure 3 we see', 'Fig leaves']) assert.doesNotMatch(s, CAPTION);
  assert.equal(isFigureSize(150, 150), true);
  assert.equal(isFigureSize(400, 50), false, 'an equation saved as an image (t-f1ec50cb5c)');
});

test('a PDF chart drawn with shapes is cropped from its page with its caption; prose pages have no figures', async () => {
  const pdf = makePdf([
    [{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 }), { text: 'The costs above are explained in prose below the chart.', y: 440 }],
    [draw.background(), { text: 'A page of prose only, nothing drawn on it.', y: 700 }],
  ]);
  const out = await extract(pdf, '.pdf');
  assert.equal(out.figureError, null);
  assert.equal(out.figures.length, 1);
  const [f] = out.figures;
  assert.deepEqual([f.kind, f.page, f.caption, f.heading], ['drawing', 1, 'Figure 1 - Costs by region in 2024.', 'Costs']);
  assert.equal(f.anchor, f.caption);
  assert.deepEqual(pngSize(f.png), [f.width, f.height]);
  // The crop holds the chart and its labels, not the caption or the prose under it.
  const [x0, y0, x1, y1] = f.box;
  assert.ok(x0 <= 112 && x1 >= 390 && y1 >= 690, `labels, bars and title inside: ${f.box}`);
  assert.ok(y0 > 515 + 8, `caption at 515 and prose at 440 below the crop: ${f.box}`);
});

test('a drawing with no caption is still a figure when it is mostly drawing, and says what text comes before it', async () => {
  const out = await extract(makePdf([[{ text: 'Regional costs are shown here.', y: 740 }, ...barChartPage({ caption: '', top: 700 })]]), '.pdf');
  assert.equal(out.figures.length, 1);
  assert.equal(out.figures[0].caption, '');
  assert.equal(out.figures[0].anchor, 'Regional costs are shown here.');
});

test('a scanned page - one picture, no text - is a figure as a whole page', async () => {
  const out = await extract(makePdf([[draw.scan()]]), '.pdf');
  assert.deepEqual(out.figures.map((f) => [f.kind, f.page]), [['page', 1]]);
  assert.equal(out.blocks.length, 0, 'the document is kept for its figure alone');
});

/* The geometry alone, in PDF points: tables and callouts are mostly text;
 * panels above one caption are one figure; a caption's own lines never
 * become a drawing's labels (t-893723082e). */
test('panels above one caption merge, a caption runs on over several lines, and a box of text is no figure', () => {
  const view = [0, 0, 612, 792];
  const t = (str, x, y, wd = 200, h = 9) => ({ str, box: [x, y, x + wd, y + h] });
  const panels = figuresOnPage({
    view,
    shapes: [[72, 500, 290, 700], [320, 500, 540, 700]],
    images: [],
    texts: [t('Figure 6 - Every reader arm measured on the', 72, 480, 400), t('five questions; Haiku arms cost cents.', 72, 468, 300), t('$5.03', 330, 690, 30)],
  });
  assert.equal(panels.length, 1);
  assert.equal(panels[0].caption, 'Figure 6 - Every reader arm measured on the five questions; Haiku arms cost cents.');
  assert.ok(panels[0].box[0] <= 72 && panels[0].box[2] >= 540 && panels[0].box[1] >= 490, `both panels, no caption line: ${panels[0].box}`);

  const callout = figuresOnPage({
    view,
    shapes: [[72, 500, 540, 600]],
    images: [],
    texts: Array.from({ length: 8 }, (_, i) => t('The catch: Haiku barely calls GitX, the hooks carry most of it.', 80, 590 - i * 11, 440)),
  });
  assert.equal(callout.length, 0, 'a filled box full of text is a callout, not a figure');
});

test('Word pictures come out with their captions, a caption belongs to one picture, and equations and EMF are left out', async () => {
  const docx = makeDocx([
    w.p('Antenna design', 'Heading1'),
    w.p('The element is fed at its edge.'),
    w.picture('rId1', { alt: 'patch antenna' }),
    w.p('Fig 1 Antenna design and dimensions'),
    w.picture('rId2'),
    w.p('More prose after an uncaptioned picture.'),
    w.picture('rId3'),
    w.picture('rId4'),
  ], {
    parts: {
      rId1: { name: 'media/image1.png', data: png(400, 300) },
      rId2: { name: 'media/image2.png', data: png(300, 200) },
      rId3: { name: 'media/image3.png', data: png(400, 50) },
      rId4: { name: 'media/image4.emf', data: Buffer.from('not a picture anything here can draw') },
    },
  });
  const out = await extract(docx, '.docx');
  assert.deepEqual(out.figures.map((f) => [f.kind, f.caption, f.heading]), [
    ['picture', 'Fig 1 Antenna design and dimensions', 'Antenna design'],
    ['picture', '', 'Antenna design'],
  ], 'the second picture does not take the first one\'s caption; the equation and the EMF are skipped');
  assert.equal(out.figures[1].anchor, 'The element is fed at its edge.', "with no caption, the paragraph before it - not another picture's caption");
  assert.deepEqual(pngSize(out.figures[0].png), [400, 300]);
});

test('a native Word chart becomes its data as text, where it stands (t-406a8da372)', async () => {
  const docx = makeDocx([
    w.p('Revenue', 'Heading1'),
    w.chart('rId7'),
    w.p('Asia grew fastest.'),
  ], { parts: { rId7: { name: 'charts/chart1.xml', data: chartXml({ title: 'Revenue by region', series: [['2023', [['Asia', 42], ['Europe', 31]]], ['2024', [['Asia', 50], ['Europe', 33]]]] }) } } });
  const out = await extract(docx, '.docx');
  assert.deepEqual(out.blocks.map((b) => b.text), [
    'Revenue',
    'Chart: Revenue by region (bar chart)',
    'Category | 2023 | 2024\nAsia | 42 | 50\nEurope | 31 | 33',
    'Asia grew fastest.',
  ]);
  assert.equal(out.blocks[2].kind, 'table');
  assert.equal(out.figures.length, 0);
});

test('an image file is one figure and no text; one that cannot be decoded is refused', async () => {
  const out = await extract(png(800, 600), '.png');
  assert.equal(out.blocks.length, 0);
  assert.deepEqual(out.figures.map((f) => [f.kind, f.width, f.height]), [['image', 800, 600]]);
  const big = await extract(png(3200, 1000), '.png');
  assert.deepEqual([big.figures[0].width, big.figures[0].height], [1600, 500], 'scaled to 1600 on its long side');
  await assert.rejects(extract(Buffer.from('not an image'), '.jpg'), (e) => e instanceof ExtractError && e.code === 'corrupt');
});

test('the engine keeps figures as files with their rows, replaces them on re-index and removes them with the document', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-figures-'));
  const o = fakeOllama();
  const e = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: o.fetch, retries: 0 }), readerOptions: READER });
  t.after(() => { e.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name, data) => { const f = path.join(root, name); fs.writeFileSync(f, data); return f; };

  const img = await e.ingest(file('diagram.png', png(640, 480)));
  // An image has no text of its own; its one chunk is its reading (t-7febde7b9f).
  assert.deepEqual([img.status, img.doc.status, img.doc.chunks, img.figures, img.read], ['added', 'ready', 1, 1, 1]);
  assert.equal(e.store.chunk(e.store.docChunkIds(img.doc.id)[0]).origin, 'read');
  const pdf = await e.ingest(file('costs.pdf', makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]])));
  assert.equal(pdf.figures, 1);
  const [fig] = e.store.docFigures(pdf.doc.id);
  assert.equal(fig.file, `figures/${pdf.doc.id}/1.png`);
  assert.ok(fs.existsSync(e.figurePath(fig)));
  assert.deepEqual(e.store.figure(fig.id).box, fig.box);
  assert.equal(e.store.figure(fig.id).doc_name, 'costs.pdf');
  assert.deepEqual(e.list().map((d) => [d.name, d.figures]), [['diagram.png', 1], ['costs.pdf', 1]]);
  assert.equal(e.store.totals().figures, 2);
  // A library holding an image alone still searches its text.
  assert.ok((await e.search('costs by region')).passages.length >= 1);

  await e.reindex(pdf.doc.id);
  const again = e.store.docFigures(pdf.doc.id);
  assert.equal(again.length, 1, 'rows are replaced, not added to');
  assert.equal(fs.readdirSync(e.figuresDir(pdf.doc.id)).length, 1);
  assert.ok(fs.existsSync(e.figurePath(again[0])));

  e.remove(pdf.doc.id);
  assert.equal(fs.existsSync(e.figuresDir(pdf.doc.id)), false);
  assert.equal(e.store.figure(again[0].id), null);
});

test('figures are embedded after the text when the model can see images, and wait for one when it cannot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-figvec-'));
  const o = fakeOllama({ vision: ['embeddinggemma-2:440m'] });
  const e = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: o.fetch, retries: 0 }), readerOptions: READER });
  t.after(() => { e.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name, data) => { const f = path.join(root, name); fs.writeFileSync(f, data); return f; };
  const phases = [];

  // A model that embeds text only: the figure is kept, without a vector.
  await e.setModel({ model: 'other' });
  const pdf = await e.ingest(file('costs.pdf', makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]])));
  assert.deepEqual([pdf.status, pdf.figures, e.store.totals().figure_vectors, o.images || 0], ['added', 1, 0, 0]);

  // Back on embeddinggemma-2, re-embedding gives the figure its vector, after the text, timed apart.
  await e.setModel({ model: 'embeddinggemma-2:440m' });
  const [r] = await e.reembed({ onProgress: (p) => p.phase === 'embedding' && phases.push(`${p.done}/${p.total}`) });
  assert.equal(r.status, 'reembedded', r.error);
  assert.equal(e.store.totals().figure_vectors, 1);
  assert.equal(o.images, 1);
  const own = e.store.docChunkIds(r.doc.id).map((id) => e.store.chunk(id)).filter((c) => !c.origin).length;
  assert.ok(phases.includes(`${own + 1}/${own + 1}`), `progress counts the document's chunks and its figure together: ${phases}`);
  assert.ok(r.timings.images === 1 && r.timings.imageMs >= 0);
  assert.equal(e.store.figureVectors(e.embedder.signature).length, 1);

  // An image file is embedded on its own, with its reading as its one chunk.
  const img = await e.ingest(file('photo.png', png(500, 400)));
  assert.deepEqual([img.doc.chunks, e.store.docFigureVectors(img.doc.id).length], [1, 1]);
});

/* Step 3: search reaches figures, and a figure travels with its passage (t-d3dd407413). */
function figureEngine(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-figsearch-'));
  const o = fakeOllama();
  // The stand-in model's scores are not gemma's, so any figure it reaches counts.
  const e = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: o.fetch, retries: 0 }), figureFloor: 0, readerOptions: READER });
  t.after(() => { e.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name, data) => { const f = path.join(root, name); fs.writeFileSync(f, data); return f; };
  return { e, file };
}

test('a figure the question does not reach is not shown, and a passage carries at most two', async (t) => {
  const { e, file } = figureEngine(t);
  // Three captioned pictures in one short Word section, so one passage holds all three captions.
  const docx = makeDocx([
    w.p('Antenna results', 'Heading1'),
    w.picture('rId1'), w.p('Fig. 1 Radiation pattern with director'),
    w.picture('rId2'), w.p('Fig. 2 Radiation pattern without director'),
    w.picture('rId3'), w.p('Fig. 3 Radiation pattern without reflector'),
  ], { parts: { rId1: { name: 'media/a.png', data: png(300, 300, '#a00') }, rId2: { name: 'media/b.png', data: png(300, 300, '#0a0') }, rId3: { name: 'media/c.png', data: png(300, 300, '#00a') } } });
  await e.ingest(file('antenna.docx', docx));
  const all = (await e.search('radiation pattern')).passages;
  // The author's passage; figures come back beside it or as results of their own.
  const text = all.filter((p) => !p.figureId);
  assert.equal(text.length, 1);
  assert.equal(text[0].figures.length, 2, 'the two the question reaches best, not all three');
  assert.equal(all.filter((p) => p.figureId).length, 1, 'the third, reached too, is a result of its own');
  assert.ok(all.every((p) => !p.readFrom), 'a reading never comes back as a passage of its own');
  e.figureFloor = 2; // no cosine reaches 2
  const none = (await e.search('radiation pattern')).passages;
  // Out of reach by look, figures still come back through their readings' words - never by look alone.
  assert.equal(none.find((p) => !p.figureId).figures.length, 0);
  assert.ok(none.filter((p) => p.figureId).every((p) => p.chunkIds.length && p.reading), 'found by reading, not by image');
});

test('a passage holding a figure\'s caption brings the figure with it', async (t) => {
  const { e, file } = figureEngine(t);
  const r = await e.ingest(file('costs.pdf', makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 }),
    { text: 'Asia spent the most on hosting, Europe the least.', y: 470 }]])));
  const [fig] = e.store.docFigures(r.doc.id);
  const { passages } = await e.search('costs by region in 2024');
  const withFigure = passages.find((p) => p.figures.length);
  assert.ok(withFigure, 'the passage with the caption carries the figure');
  assert.deepEqual(withFigure.figures.map(({ reading, ...f }) => f), [{ figureId: fig.id, kind: 'drawing', page: 1, caption: 'Figure 1 - Costs by region in 2024.' }]);
  assert.match(withFigure.figures[0].reading, /^Described from the image: A bar chart/, 'the figure brings what Claude read in it');
  assert.ok(!passages.some((p) => p.figureId === fig.id), 'a figure beside a passage found is not a second result');
});

test('a figure found on its own is a result of its own, saying what it is', async (t) => {
  const { e, file } = figureEngine(t);
  await e.ingest(file('notes.md', '# Notes\n\nMeeting notes about the office move and the parking rules.\n'));
  const img = await e.ingest(file('photo.png', png(600, 400)));
  const [fig] = e.store.docFigures(img.doc.id);
  // The stand-in model gives a picture the word "picture"; a question with that word reaches it.
  const { passages } = await e.search('a picture of the office');
  const hit = passages.find((p) => p.figureId);
  assert.ok(hit, JSON.stringify(passages.map((p) => p.docName)));
  assert.deepEqual([hit.figureId, hit.docName, hit.text], [fig.id, 'photo.png', 'A picture with no caption']);
  assert.match(hit.reading, /Described from the image/);
  // Reached by its image, or by the words Claude read in it.
  assert.ok(hit.ranks.figure >= 1 || hit.ranks.vector >= 1 || hit.ranks.keyword >= 1, JSON.stringify(hit.ranks));
});
