/* NoteX's documents in RAGX's Library: listed from NoteX's folder beside
 * RAGX's data folder, added and marked as NoteX's, and replaced when they
 * change (t-c30c32cbe2, t-9406918dd3, t-25a3490818, t-086ad99f31). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const ORIGIN = 'http://127.0.0.1:7070';
const canvas = (n) => `## Planner Screen (totem) > Images\n\nAn area holding ${n} screenshots of the SAR pipeline.\n`;

async function serve(t) {
  // Laid out as ter-manager lays out plugin data: <saveDir>/plugins/rag and plugins/notex.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-notex-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'plugins', 'rag'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    agentOptions: { claude: { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'answer'], timeoutMs: 10_000 } },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(s.url + p, { method, headers: { 'x-rag-token': s.token, origin: ORIGIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const until = async (fn, what) => {
    for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { root, call, until, docsDir: path.join(root, 'plugins', 'notex', 'docs') };
}

test('NoteX canvases are listed, added as NoteX\'s, and replaced when they change', async (t) => {
  const { root, call, until, docsDir } = await serve(t);
  assert.deepEqual((await call('/api/notex')).body, { folder: docsDir, exists: false, files: [], kept: 0 });

  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'testing2.notex.md'), canvas(3));
  fs.writeFileSync(path.join(docsDir, 'testing2.places.json'), '{}');
  const mine = path.join(root, 'lease.md');
  fs.writeFileSync(mine, '# Lease\n\nRent is due on the first of each month.\n');
  assert.equal((await call('/api/docs/path', { method: 'POST', body: { path: mine } })).status, 202);

  let list = (await call('/api/notex')).body;
  assert.deepEqual(list.files.map((f) => [f.name, f.fabric, f.status]), [['testing2.notex.md', 'testing2', 'new']]);
  assert.equal((await call('/api/notex/add', { method: 'POST', body: { names: ['..\\lease.md'] } })).status, 404);
  assert.deepEqual((await call('/api/notex/add', { method: 'POST', body: {} })).body, { queued: ['testing2.notex.md'] });

  const ready = (name) => until(async () => (await call('/api/docs')).body.docs.find((d) => d.name === name && d.status === 'ready'), name);
  const first = await ready('testing2.notex.md');
  const lease = await ready('lease.md');
  assert.equal(first.origin, 'notex');
  assert.equal(lease.origin, null);
  list = (await call('/api/notex')).body;
  assert.deepEqual(list.files.map((f) => [f.status, f.docId]), [['added', first.id]]);
  assert.deepEqual((await call('/api/notex/add', { method: 'POST', body: {} })).body, { queued: [] });

  // The fabric changed in File Fabric and NoteX wrote it again: Update replaces it.
  fs.writeFileSync(path.join(docsDir, 'testing2.notex.md'), canvas(4));
  list = (await call('/api/notex')).body;
  assert.deepEqual(list.files.map((f) => [f.status, f.docId]), [['changed', first.id]]);
  await call('/api/notex/add', { method: 'POST', body: { names: ['testing2.notex.md'] } });
  const docs = await until(async () => {
    const all = (await call('/api/docs')).body.docs;
    const t2 = all.filter((d) => d.name === 'testing2.notex.md');
    return t2.length === 1 && t2[0].id !== first.id && t2[0].status === 'ready' ? all : null;
  }, 'the old version to go');
  assert.equal(docs.find((d) => d.name === 'testing2.notex.md').origin, 'notex');
  assert.ok(docs.some((d) => d.name === 'lease.md'), 'the user\'s own file stays');
  assert.equal((await call('/api/notex')).body.files[0].status, 'added');
});

test('a canvas may give six places to a search, any other document three', async (t) => {
  const { root, call, until, docsDir } = await serve(t);
  const places = Array.from({ length: 7 }, (_, i) => `## Board > Area ${i + 1}\n\nThe orthorectification pipeline step ${i + 1} for SAR tiles.\n`).join('\n');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'Board.notex.md'), places);
  fs.writeFileSync(path.join(root, 'plain.md'), places.replace(/Board/g, 'Plain'));
  await call('/api/notex/add', { method: 'POST', body: {} });
  await call('/api/docs/path', { method: 'POST', body: { path: path.join(root, 'plain.md') } });
  await until(async () => { const d = (await call('/api/docs')).body.docs; return d.length === 2 && d.every((x) => x.status === 'ready'); }, 'both documents');
  const { passages } = (await call('/api/search', { method: 'POST', body: { q: 'orthorectification pipeline step for SAR tiles', k: 12 } })).body;
  const from = (name) => passages.filter((p) => p.docName === name).length;
  assert.equal(from('Board.notex.md'), 6);
  assert.equal(from('plain.md'), 3);
});

test('a canvas added by hand is recognised as NoteX\'s, and the folder can be set', async (t) => {
  const { root, call, until, docsDir } = await serve(t);
  fs.mkdirSync(docsDir, { recursive: true });
  const file = path.join(docsDir, 'Testing.notex.md');
  fs.writeFileSync(file, canvas(2));
  await call('/api/docs/path', { method: 'POST', body: { path: file } });
  await until(async () => (await call('/api/docs')).body.docs.find((d) => d.status === 'ready'), 'Testing');
  assert.equal((await call('/api/docs')).body.docs[0].origin, null);
  assert.equal((await call('/api/notex')).body.files[0].status, 'added');
  assert.equal((await call('/api/docs')).body.docs[0].origin, 'notex');

  const other = path.join(root, 'elsewhere');
  assert.equal((await call('/api/settings', { method: 'PUT', body: { notexDocs: 'relative' } })).status, 400);
  const set = (await call('/api/settings', { method: 'PUT', body: { notexDocs: other } })).body.settings;
  assert.equal(set.notexDocs, other);
  assert.deepEqual((await call('/api/notex')).body, { folder: other, exists: false, files: [], kept: 0 });
  assert.equal((await call('/api/settings', { method: 'PUT', body: { notexDocs: '' } })).body.settings.notexDocs, docsDir);
});

// t-9ba4e48993, t-96cbf048b2
test('the canvases NoteX keeps in RAGX by auto-sync are marked, from its config.json', async (t) => {
  const { call, docsDir } = await serve(t);
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'Thesis.notex.md'), canvas(1));
  fs.writeFileSync(path.join(docsDir, 'Board.notex.md'), canvas(2));
  let list = (await call('/api/notex')).body;
  assert.equal(list.kept, 0, 'no config.json: nothing kept');
  assert.ok(list.files.every((f) => f.kept === null));

  const config = path.join(docsDir, '..', 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workspace: 'E:\ws', sync: { Thesis: { synced: 123, at: '2026-10-25T12:00:00.000Z' }, Gone: { synced: null, at: null } } }));
  list = (await call('/api/notex')).body;
  assert.equal(list.kept, 2, 'every canvas switched on counts, written by NoteX or not');
  assert.deepEqual(list.files.map((f) => [f.fabric, f.kept]).sort(), [['Board', null], ['Thesis', { at: '2026-10-25T12:00:00.000Z' }]]);

  fs.writeFileSync(config, '{ half written');
  assert.equal((await call('/api/notex')).body.kept, 0, 'a config caught mid-write marks nothing rather than failing');
});
