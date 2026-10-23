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

  // Neighbours with one heading, both matching: two passages, not one.
  const passages = hybridSearch({ store, index: null, question: 'costs', queryVector: null, k: 8 });
  assert.equal(passages.length, 2);
  assert.deepEqual(passages.map((p) => p.readFrom ?? null).sort(), [figureId, null].sort());
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
  assert.equal(store.getMeta('schema_version'), '5');
  store.close();
});
