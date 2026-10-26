/* Phase 4: the files on a File Fabric canvas come into the library through
 * NoteX's Add, each with the place it sits at (t-fff1f21827), matched by
 * canvas, address and name (t-2d4339a7ad), read only where RAGX may read
 * (t-7c03feb73f). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';

const ORIGIN = 'http://127.0.0.1:7070';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function serve(t, { allow = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-canvasfiles-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const ws = path.join(root, 'workspace');
  const docsDir = path.join(root, 'notex', 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  if (allow) s.engine.store.setMeta('image_folders', JSON.stringify([ws]));
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
  /* A canvas as NoteX leaves it: its files in sources/, its document, and the list. */
  const canvas = async (name, files) => {
    const src = path.join(ws, name, 'sources');
    fs.mkdirSync(src, { recursive: true });
    for (const f of files) if (f.text !== undefined) fs.writeFileSync(path.join(src, f.name), f.text);
    fs.writeFileSync(path.join(docsDir, `${name}.files.json`), JSON.stringify({ canvas: name, files: files.map((f) => ({
      name: f.name, address: f.address, path: f.path || path.join(src, f.name), kind: 'file', sha256: f.sha256 || sha(fs.readFileSync(path.join(src, f.name))),
    })) }));
    fs.writeFileSync(path.join(docsDir, `${name}.notex.md`), `## ${name} (fabric)\n\nThe canvas ${name}.\n\n${files.map((f) => `- ${f.name} at ${f.address}`).join('\n')}\n`);
    const r = await call('/api/notex/add', { method: 'POST', body: { names: [`${name}.notex.md`] } });
    await idle();
    return r;
  };
  const docs = async () => (await call('/api/docs')).body.docs;
  const files = async () => (await docs()).filter((d) => !d.name.endsWith('.notex.md'));
  return { root, s, ws, call, canvas, docs, files, idle };
}

const paper = (v) => `# RAPTOR\n\nTree-organised retrieval, edition ${v}.\n\n## Method\n\nRecursive summaries are clustered.\n`;

test('a file on a canvas comes in once, with its place; a second place on another canvas shares it', async (t) => {
  const { canvas, files, s } = await serve(t);
  const r = await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'GitX (totem) > Papers' }]);
  assert.deepEqual(r.body.files, ['Research']);
  let f = await files();
  assert.equal(f.length, 1);
  assert.equal(f[0].origin, 'notex');
  assert.deepEqual(f[0].places, [{ canvas: 'Research', address: 'GitX (totem) > Papers', name: 'raptor.md' }]);

  await canvas('Reading', [{ name: 'raptor.md', text: paper(1), address: 'Queue' }]);
  f = await files();
  assert.equal(f.length, 1, 'the same bytes are one document');
  assert.deepEqual(f[0].places.map((p) => p.canvas), ['Reading', 'Research']);
  assert.ok(s.engine.store.keywordSearch('clustered', 5).length >= 1, 'its text is searchable');
});

test('nothing changed: no job; moved: only its place changes', async (t) => {
  const { canvas, files } = await serve(t);
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }]);
  const id = (await files())[0].id;
  assert.deepEqual((await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }])).body.files, []);
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Archive' }]);
  const f = await files();
  assert.equal(f[0].id, id);
  assert.deepEqual(f[0].places.map((p) => p.address), ['Archive']);
});

test('replaced in its place: the new version in, the old out, and a conversation kept to it follows', async (t) => {
  const { canvas, files, s } = await serve(t);
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }]);
  const old = (await files())[0].id;
  const conv = s.engine.store.addConversation({ agent: 'claude', model: 'sonnet', title: 'q' });
  s.engine.store.setScope(conv, [old]);
  await canvas('Research', [{ name: 'raptor.md', text: paper(2), address: 'Papers' }]);
  const f = await files();
  assert.equal(f.length, 1);
  assert.notEqual(f[0].id, old);
  assert.deepEqual(s.engine.store.conversation(conv).scope.map(Number), [f[0].id]);
});

test('a file the user added gains a place and stays when the canvas lets it go; one named like it is not replaced', async (t) => {
  const { canvas, files, s, root } = await serve(t);
  const own = path.join(root, 'raptor.md');
  fs.writeFileSync(own, paper(1));
  const mine = await s.engine.ingest(own);
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }]);
  let f = await files();
  assert.equal(f.length, 1);
  assert.equal(f[0].id, mine.doc.id);
  assert.equal(f[0].origin, null, 'still the user\'s');

  // Another file of the same name, other bytes, on another canvas: a document of its own.
  await canvas('Other', [{ name: 'raptor.md', text: paper(9), address: 'Desk' }]);
  assert.equal((await files()).length, 2);

  // Both canvases let go: the canvas's own file goes, the user's stays.
  await canvas('Research', []);
  await canvas('Other', []);
  f = await files();
  assert.deepEqual(f.map((d) => d.id), [mine.doc.id]);
  assert.deepEqual(f[0].places, []);
});

test('only files RAGX may read come in: inside an allowed folder, File Fabric\'s copy, with the listed bytes', async (t) => {
  const { canvas, files, root } = await serve(t);
  const outside = path.join(root, 'elsewhere', 'Research', 'sources', 'secret.md');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, '# Secret\n\nNot on any canvas.\n');
  const r = await canvas('Research', [
    { name: 'secret.md', address: 'Papers', path: outside, sha256: sha(fs.readFileSync(outside)) },
    { name: 'notes.exe', text: 'MZ', address: 'Papers' },
    { name: 'raptor.md', text: paper(1), address: 'Papers', sha256: sha('something else') },
  ]);
  assert.deepEqual(r.body.files, ['Research']);
  assert.deepEqual(await files(), [], 'none of the three is read');
});

test('with File Fabric\'s workspace not allowed in Settings, nothing is read', async (t) => {
  const { canvas, files } = await serve(t, { allow: false });
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }]);
  assert.deepEqual(await files(), []);
});

test('where a file sits shows in search results, answer sources and its place\'s card', async (t) => {
  const { canvas, call, root } = await serve(t);
  await canvas('Research', [{ name: 'raptor.md', text: paper(1), address: 'Papers' }]);
  const hit = (await call('/api/search', { method: 'POST', body: { q: 'recursive summaries clustered' } })).body.passages.find((p) => p.docName === 'raptor.md');
  assert.deepEqual(hit.places, [{ canvas: 'Research', address: 'Papers', name: 'raptor.md' }]);
  const { label } = await import('../engine/lib/answer.js');
  assert.equal(label({ n: 2, docName: 'raptor.md', heading: 'RAPTOR > Method', places: hit.places }), '[2] raptor.md - RAPTOR > Method (on Research at Papers)');

  // NoteX's place map for the canvas, as ragx_place reads it.
  const map = { fabric: { name: 'Research' }, places: [
    { id: 'fabric', kind: 'fabric', label: 'Research', address: '', parent: null, children: ['a'] },
    { id: 'a', kind: 'area', name: 'Papers', label: 'Papers', address: 'Papers', parent: 'fabric', children: [], neighbours: [], wires: [], files: [{ name: 'raptor.md', kind: 'file' }] },
  ] };
  fs.writeFileSync(path.join(root, 'notex', 'docs', 'Research.places.json'), JSON.stringify(map));
  const card = (await call('/api/place', { method: 'POST', body: { canvas: 'Research', at: 'Papers' } })).body.text;
  assert.match(card, /In RAGX as documents: raptor\.md/);
});
