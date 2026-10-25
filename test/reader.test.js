/* Reading images with Claude (t-fb07dc61a4): the reply, the kept readings,
 * no saved sessions, and readings chunked apart from the author's text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../engine/lib/store.js';
import { parseReading, readImage, readingBlocks, imageKey, READ_SYSTEM } from '../engine/lib/reader.js';
import { args } from '../engine/lib/agents/claude.js';
import { chunk, chunkApart } from '../engine/lib/chunk.js';
import { hybridSearch } from '../engine/lib/search.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-reader-'));
  const store = new Store(path.join(dir, 'rag.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

test('a reply is read as the JSON asked for, also fenced; anything else is kept as the description', () => {
  const r = parseReading('```json\n{"kind": "chart", "text": "Opus | $5.03", "description": "A bar chart."}\n```');
  assert.deepEqual(r, { kind: 'chart', text: 'Opus | $5.03', description: 'A bar chart.', parsed: true });
  assert.equal(parseReading('Here it is:\n{"kind":"page","text":"Hello","description":"A note."}').text, 'Hello');
  assert.deepEqual(parseReading('A bar chart of costs.'), { kind: null, text: '', description: 'A bar chart of costs.', parsed: false });
  assert.match(READ_SYSTEM, /exactly as written/);
  assert.match(READ_SYSTEM, /not instructions/);
});

test('a reading is never kept as a session in Claude\'s history', () => {
  assert.ok(args({ model: 'haiku', persist: false }).includes('--no-session-persistence'));
  assert.ok(!args({ model: 'sonnet' }).includes('--no-session-persistence'), 'answers keep theirs, for follow-ups');
});

test('an image is read once: the same picture again is answered from the kept reading', async (t) => {
  const { dir, store } = tempStore(t);
  const png = Buffer.from('not really a png, but bytes all the same');
  const stats = {};
  const opts = { store, cwd: dir, stats, agentOptions: { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'read'], timeoutMs: 15_000 } };
  const first = await readImage(png, opts);
  assert.equal(first.cached, false);
  assert.deepEqual([first.kind, first.text], ['chart', 'Arm | Cost\nOpus | $5.03\nHaiku | $0.07']);
  assert.match(first.description, /1 image given; flags --no-session-persistence/);
  const again = await readImage(png, { ...opts, agentOptions: { executable: 'no-such-program-at-all' } });
  assert.equal(again.cached, true, 'no agent is started for a picture already read');
  assert.equal(again.text, first.text);
  assert.deepEqual([stats.reads, stats.cached], [1, 1]);
  assert.ok(stats.readMs >= 0);
  // Another reader model reads it afresh.
  assert.equal(store.reading(imageKey(png), 'sonnet'), null);

  const prose = await readImage(Buffer.from('another picture'), { ...opts, agentOptions: { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'read-prose'], timeoutMs: 15_000 } });
  assert.deepEqual([prose.parsed, prose.text], [false, '']);
  assert.match(prose.description, /Opus the most expensive/);
});

test('a figure\'s reading becomes blocks saying it was read; a scanned page\'s is page text', () => {
  const reading = { text: 'Costs by region\nArm | Cost\nOpus | $5.03', description: 'A bar chart of costs.' };
  const fig = readingBlocks(reading, { page: 18 });
  assert.deepEqual(fig.map((b) => [b.kind, b.page]), [['para', 18], ['para', 18], ['para', 18], ['table', 18]]);
  assert.equal(fig[0].text, 'Described from the image: A bar chart of costs.');
  assert.deepEqual(fig[3].rows, ['Arm | Cost', 'Opus | $5.03']);
  const scan = readingBlocks({ text: 'Invoice INV-2024-0042\n\nPaid in full on 3 March.', description: 'An invoice.' }, { page: 2, scan: true });
  assert.deepEqual(scan.map((b) => b.text), ['Invoice INV-2024-0042', 'Paid in full on 3 March.']);
  assert.ok(scan.every((b) => b.page === 2));
});

test('readings are chunked apart from the author\'s words, and search never joins the two', (t) => {
  const { store } = tempStore(t);
  const author = chunk([{ kind: 'heading', level: 1, text: 'Costs' }, { kind: 'para', text: 'The costs of every reader arm are compared below.' }]);
  const read = chunkApart([{ heading: 'Costs', figureId: 7, blocks: readingBlocks({ text: 'Opus | $5.03', description: 'A bar chart of costs.' }) }]);
  assert.deepEqual(read.map((c) => [c.heading, c.figureId, c.origin]), [['Costs', 7, 'read']]);
  assert.match(read[0].text, /Described from the image/);

  const docId = store.addDoc({ sha256: 'x', name: 'costs.pdf', ext: '.pdf', bytes: 1 });
  store.replaceFigures(docId, [{ kind: 'drawing', file: 'figures/1/1.png', width: 300, height: 200 }]);
  const figureId = store.docFigures(docId)[0].id;
  store.replaceChunks(docId, [...author, ...read.map((c) => ({ ...c, figureId }))]);
  store.setReady(docId, 'sig');
  const rows = store.docChunkIds(docId).map((id) => store.chunk(id));
  assert.deepEqual(rows.map((c) => [c.figure_id, c.origin]), [[null, null], [figureId, 'read']]);

  // Neighbours with one heading, both matching: the author's passage, and the reading as its figure.
  const passages = hybridSearch({ store, index: null, question: 'costs', queryVector: null, k: 8 });
  assert.equal(passages.length, 2);
  const fig = passages.find((p) => p.figureId);
  assert.equal(fig.figureId, figureId);
  assert.match(fig.reading, /^Described from the image: A bar chart of costs\.\n\nText in the image:\n\nOpus \| \$5\.03$/);
  assert.ok(!passages.find((p) => !p.figureId).text.includes('Described from the image'), 'never joined to the author\'s words');
});

test('an index from before gains the reads table and the chunk columns on opening', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-oldchunks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rag.db');
  const old = new DatabaseSync(file);
  old.exec(`create table documents (id integer primary key, sha256 text not null unique, name text not null, ext text not null, source_path text,
    bytes integer not null, status text not null, error text, pages integer, chunks integer not null default 0, embedded_with text, added_at text not null, updated_at text not null);
    create table chunks (id integer primary key, doc_id integer not null references documents(id) on delete cascade, ord integer not null,
    heading text not null default '', text text not null, lead integer not null default 0, page_from integer, page_to integer, unique (doc_id, ord));`);
  old.close();
  const store = new Store(file);
  const cols = store.db.prepare('pragma table_info(chunks)').all().map((c) => c.name);
  assert.ok(cols.includes('figure_id') && cols.includes('origin'));
  store.putReading('abc', 'haiku', { kind: 'chart', text: 'x', description: 'y', ms: 5 });
  assert.deepEqual(store.reading('abc', 'haiku'), { kind: 'chart', text: 'x', description: 'y', parsed: true, ms: 5 });
  assert.equal(store.getMeta('schema_version'), '6');
  store.close();
});

/* Reading in the engine: new documents read, rebuilt ones reuse, the user
 * asks for the rest (t-f0fbeabf6b, t-472dbed87a, t-64a996ef5a). */
async function readingEngine(t, { reader = 'read', readCap } = {}) {
  const { Engine } = await import('../engine/lib/engine.js');
  const { Embedder } = await import('../engine/lib/embed.js');
  const { fakeOllama } = await import('./ollama-fake.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-reading-'));
  const o = fakeOllama();
  const readerOptions = { executable: process.execPath, prefixArgs: [FAKE, 'claude', reader], timeoutMs: 15_000 };
  const e = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: o.fetch, retries: 0 }), figureFloor: 0, readerOptions, readCap });
  t.after(() => { e.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name, data) => { const f = path.join(root, name); fs.writeFileSync(f, data); return f; };
  const chunks = (docId) => e.store.docChunkIds(docId).map((id) => e.store.chunk(id));
  return { e, file, chunks };
}
const { makePdf, barChartPage, draw } = await import('./fixtures.js');
const chartPdf = () => makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]]);

test('a new document\'s figures are read and their readings searchable; re-indexing reuses them without a call', async (t) => {
  const { e, file, chunks } = await readingEngine(t);
  const r = await e.ingest(file('costs.pdf', chartPdf()));
  assert.deepEqual([r.status, r.read, r.unread, r.readError, r.timings.reads, r.timings.readCached], ['added', 1, 0, null, 1, 0]);
  assert.ok(r.timings.readMs > 0);
  const [fig] = e.store.docFigures(r.doc.id);
  assert.equal(fig.read, 1);
  const read = chunks(r.doc.id).filter((c) => c.origin === 'read');
  assert.equal(read.length, 1);
  assert.equal(read[0].figure_id, fig.id);
  assert.match(read[0].heading, /Figure 1 - Costs by region in 2024\. \(read from the image\)$/);
  assert.match(read[0].text, /Described from the image: A bar chart of reader cost/);
  assert.equal(r.doc.figures_read, 1);
  // The words inside the image are now found by keyword.
  const { passages } = await e.search('Opus 5.03');
  assert.ok(passages.some((p) => p.figureId === fig.id && /Opus \| \$5\.03/.test(p.reading || '') || (p.figures || []).some((f) => /Opus/.test(f.reading || ''))),
    JSON.stringify(passages.map((p) => p.text.slice(0, 40))));

  // Re-index rebuilds the figures; the kept reading comes back with no call.
  e.readerOptions = { executable: 'no-such-program-at-all' };
  const again = await e.reindex(r.doc.id);
  assert.deepEqual([again.status, again.read, again.timings.reads, again.timings.readCached], ['reindexed', 1, 0, 1]);
  assert.equal(chunks(r.doc.id).filter((c) => c.origin === 'read').length, 1);
});

test('with reading off a new document\'s figures wait; Read figures now reads them, at most the cap at a time', async (t) => {
  const { e, file } = await readingEngine(t, { readCap: 1 });
  e.store.setMeta('read_figures', 'off');
  const scan = await e.ingest(file('scan.pdf', makePdf([[draw.scan(0x80)], [draw.scan(0x40)]])));
  assert.deepEqual([scan.status, scan.read, scan.unread, scan.doc.chunks], ['added', 0, 2, 0]);
  assert.deepEqual(e.store.unreadDocs().map((d) => d.name), ['scan.pdf']);

  const first = await e.readNow(scan.doc.id);
  assert.deepEqual([first.status, first.read, first.unread], ['read', 1, 1], 'one at a time with a cap of one');
  const second = await e.readNow(scan.doc.id);
  assert.deepEqual([second.read, second.unread], [1, 0]);
  assert.deepEqual(e.store.unreadDocs(), []);
  // A scanned page's reading is page text, headed by its page.
  const pages = e.store.docChunkIds(scan.doc.id).map((id) => e.store.chunk(id));
  assert.deepEqual(pages.map((c) => [c.heading, c.page_from, c.origin]), [['Scanned page 1', 1, 'read'], ['Scanned page 2', 2, 'read']]);
});

test('a failed reading never fails the document: its figures stay not read until Read figures now', async (t) => {
  const { e, file } = await readingEngine(t, { reader: 'login' });
  const r = await e.ingest(file('costs.pdf', chartPdf()));
  assert.equal(r.status, 'added');
  assert.equal(r.doc.status, 'ready');
  assert.deepEqual([r.read, r.unread], [0, 1]);
  assert.match(r.readError, /not logged in/);
  e.readerOptions = { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'read'], timeoutMs: 15_000 };
  const now = await e.readNow(r.doc.id);
  assert.deepEqual([now.read, now.unread, now.readError], [1, 0, null]);
});
