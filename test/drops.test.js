/* The medallion pipeline's gold: drops NoteX placed on an agent canvas come
 * in as documents of their own, each with its place and drop time, only
 * from NoteX's bronze (t-a3a1000832), and a search can keep to a time
 * window (t-d9e3a576d5). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { timeWindow } from '../engine/lib/engine.js';
import { fakeOllama } from './ollama-fake.js';

const ORIGIN = 'http://127.0.0.1:7070';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-drops-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const docsDir = path.join(root, 'notex', 'docs');
  const blobs = path.join(root, 'notex', 'bronze', 'blobs');
  fs.mkdirSync(docsDir, { recursive: true });
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(s.url + p, { method, headers: { 'x-rag-token': s.token, origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const st = (await call('/api/state')).body;
      if (!st.queue.length && !st.ingesting) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('the queue never emptied');
  };
  /* A drop as NoteX keeps it: its bytes in bronze under their hash. */
  const blob = (text, ext) => {
    const h = sha(Buffer.from(text));
    const f = path.join(blobs, ext === '.txt' ? 'text' : 'md', h.slice(0, 2), h + ext);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return { path: f, sha256: h };
  };
  /* NoteX's list for a canvas, then its request. */
  const send = async (canvas, entries) => {
    fs.writeFileSync(path.join(docsDir, `${canvas}.drops.json`), JSON.stringify({ canvas, files: entries }));
    const r = await call('/api/notex/drops', { method: 'POST', body: { canvas } });
    await idle();
    return r;
  };
  const docs = async () => (await call('/api/docs')).body.docs;
  return { root, s, call, blob, send, docs, docsDir };
}

const note = '# Scanned figures\n\nRAGX misses figures on scanned PDF pages: the finder only follows vector drawings.\n';
const idea = 'A reranker after hybrid search would sharpen the top results.';

test('a placed drop comes in as its own document, with its place and when it was dropped', async (t) => {
  const { send, blob, docs, s } = await serve(t);
  const b = blob(note, '.md');
  const r = await send('Harness', [{ name: 'scanned.md', ...b, address: 'RAGX (totem) > Ingest', drop: { id: 'd-0123456789', at: '2026-10-20T09:30:00.000Z' } }]);
  assert.equal(r.status, 202);
  assert.equal(r.body.queued, true);
  const d = (await docs()).find((x) => x.name === 'scanned.md');
  assert.equal(d.status, 'ready');
  assert.equal(d.origin, 'notex');
  assert.deepEqual(d.places, [{ canvas: 'Harness', address: 'RAGX (totem) > Ingest', name: 'scanned.md' }]);
  assert.deepEqual(s.engine.store.dropsOf(d.id), [{ id: 'd-0123456789', canvas: 'Harness', droppedAt: '2026-10-20T09:30:00.000Z' }]);
  // The document list carries its drops, so the search range can group it under its canvas (t-385f1e60fe).
  assert.deepEqual(d.drops, [{ id: 'd-0123456789', canvas: 'Harness', droppedAt: '2026-10-20T09:30:00.000Z' }]);
  // Sent again unchanged, there is nothing to do.
  assert.equal((await send('Harness', [{ name: 'scanned.md', ...b, address: 'RAGX (totem) > Ingest', drop: { id: 'd-0123456789', at: '2026-10-20T09:30:00.000Z' } }])).body.queued, false);
  const { passages } = await s.engine.search('scanned pages vector drawings', { k: 3 });
  assert.equal(passages[0].docName, 'scanned.md');
  assert.equal(passages[0].droppedAt, '2026-10-20T09:30:00.000Z');
  assert.deepEqual(passages[0].places, [{ canvas: 'Harness', address: 'RAGX (totem) > Ingest', name: 'scanned.md' }]);
});

test('a search keeps to a time window: drop time first, else the time a document was added', async (t) => {
  const { send, blob, s, root } = await serve(t);
  await send('Harness', [
    { name: 'scanned.md', ...blob(note, '.md'), address: 'RAGX (totem) > Ingest', drop: { id: 'd-0000000001', at: '2026-10-20T09:30:00.000Z' } },
    { name: 'A reranker after (d-0000000002).txt', ...blob(idea, '.txt'), address: 'RAGX (totem) > Search', drop: { id: 'd-0000000002', at: '2026-10-28T16:00:00.000Z' } },
  ]);
  const own = path.join(root, 'mine.md');
  fs.writeFileSync(own, '# Mine\n\nScanned pages and rerankers, added by hand today.\n');
  await s.engine.ingest(own);
  const names = async (opts) => [...new Set((await s.engine.search('scanned pages reranker results', { k: 8, ...opts })).passages.map((p) => p.docName))].sort();
  assert.deepEqual(await names({ from: '2026-10-19', to: '2026-10-21' }), ['scanned.md']);
  assert.deepEqual(await names({ from: '2026-10-28', to: '2026-10-28' }), ['A reranker after (d-0000000002).txt'], 'a bare date for to takes the whole day');
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(await names({ from: today }), ['mine.md'], 'never dropped: the time it was added');
  assert.deepEqual(await names({ to: '2026-01-01' }), []);
  assert.throws(() => timeWindow('soon', null), /is not a date/);
  assert.throws(() => timeWindow('2026-10-30', '2026-10-01'), /is after/);
});

test('/api/search takes the window too, and refuses one it cannot read', async (t) => {
  const { send, blob, call } = await serve(t);
  await send('Harness', [{ name: 'scanned.md', ...blob(note, '.md'), address: 'RAGX (totem) > Ingest', drop: { id: 'd-0000000001', at: '2026-10-20T09:30:00.000Z' } }]);
  assert.equal((await call('/api/search', { method: 'POST', body: { q: 'scanned', from: '2026-10-20', to: '2026-10-20' } })).body.passages.length > 0, true);
  assert.equal((await call('/api/search', { method: 'POST', body: { q: 'scanned', from: '2026-10-21' } })).body.passages.length, 0);
  const bad = await call('/api/search', { method: 'POST', body: { q: 'scanned', from: 'yesterday' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad-time');
});

test('a drop no longer listed - forgotten in NoteX - leaves the library with its row', async (t) => {
  const { send, blob, docs, s } = await serve(t);
  const a = { name: 'scanned.md', ...blob(note, '.md'), address: 'RAGX (totem) > Ingest', drop: { id: 'd-0000000001', at: '2026-10-20T09:30:00.000Z' } };
  const b = { name: 'idea (d-0000000002).txt', ...blob(idea, '.txt'), address: 'RAGX (totem) > Search', drop: { id: 'd-0000000002', at: '2026-10-28T16:00:00.000Z' } };
  await send('Harness', [a, b]);
  assert.equal((await docs()).length, 2);
  await send('Harness', [b]);
  const left = await docs();
  assert.deepEqual(left.map((d) => d.name), ['idea (d-0000000002).txt']);
  assert.deepEqual(s.engine.store.canvasDrops('Harness').map((d) => d.id), ['d-0000000002']);
  await send('Harness', []);
  assert.deepEqual(await docs(), []);
});

test('only drops in NoteX\'s bronze, with an id and a time, are taken', async (t) => {
  const { send, blob, docs, root, call } = await serve(t);
  const elsewhere = path.join(root, 'secret.md');
  fs.writeFileSync(elsewhere, note);
  const good = blob(note, '.md');
  await send('Harness', [
    { name: 'secret.md', path: elsewhere, sha256: sha(Buffer.from(note)), address: '', drop: { id: 'd-0000000001', at: '2026-10-20T09:30:00Z' } },
    { name: 'nodrop.md', ...good, address: '' },
    { name: '../up.md', ...good, address: '', drop: { id: 'd-0000000003', at: '2026-10-20T09:30:00Z' } },
  ]);
  assert.deepEqual(await docs(), []);
  assert.equal((await call('/api/notex/drops', { method: 'POST', body: { canvas: 'Nowhere' } })).status, 404);
  assert.equal((await call('/api/notex/drops', { method: 'POST', body: {} })).status, 400);
});
