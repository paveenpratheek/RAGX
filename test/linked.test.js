/* Images for NoteX: one image read on its own through the read route, up to
 * four readings at once, and images a Markdown document links on this
 * machine - noted under their heading, shown only from folders the user
 * listed (t-2a6293f2b7, t-a5d9223798, t-d112dfa471, t-1cfacc1b16). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { gate } from '../engine/lib/reader.js';
import { extractMarkdown } from '../engine/lib/extract/markdown.js';
import { fakeOllama } from './ollama-fake.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const ORIGIN = 'http://127.0.0.1:7070';

function png(w = 300, h = 200, colour = '#3b6cf6') {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return c.toBuffer('image/png');
}

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-linked-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    agentOptions: { claude: { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'answer'], timeoutMs: 10_000 } },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (p, { method = 'GET', body, headers = {}, raw = false } = {}) => fetch(s.url + p, {
    method,
    headers: { 'x-rag-token': s.token, origin: ORIGIN, ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  return { s, root, call };
}

test('the gate lets at most n run at once and hands a freed slot on', async () => {
  const g = gate(4);
  let now = 0, most = 0;
  const done = [];
  await Promise.all(Array.from({ length: 10 }, (_, i) => g.run(async () => {
    now++; most = Math.max(most, now);
    await new Promise((r) => setTimeout(r, 20));
    now--; done.push(i);
  })));
  assert.equal(most, 4);
  assert.equal(done.length, 10);
  assert.equal(g.active, 0);
});

test('Markdown notes file:/// images under the heading path the chunker gives them', () => {
  const file = path.resolve(os.tmpdir(), 'a folder', 'shot (3).png');
  const url = pathToFileURL(file).href;
  const { blocks, links } = extractMarkdown(`# Thesis\n\n## RESEARCH (totem) > GAP PAPERS\n\nAn area.\n\n![shot (3).png](${url})\nFile: ${file}\n\n![web](https://example.com/x.png)\n`);
  assert.deepEqual(links, [{ heading: 'Thesis > RESEARCH (totem) > GAP PAPERS', name: 'shot (3).png', path: file }]);
  // The link itself is not text: its name stays, the URL goes.
  const para = blocks.find((b) => b.text.includes('shot (3).png'));
  assert.ok(para && !para.text.includes('file:///') && !para.text.includes('.png)'), para && para.text);
});

test('the read route reads one image and keeps the reading', async (t) => {
  const { call } = await serve(t);
  const img = png();
  const first = await call('/api/read-image', { method: 'POST', raw: true, body: img, headers: { 'x-file-name': encodeURIComponent('shot.png') } });
  assert.equal(first.status, 200);
  const r = await first.json();
  assert.equal(r.kind, 'chart');
  assert.match(r.text, /Opus \| \$5\.03/);
  assert.equal(r.model, 'haiku');
  assert.equal(r.cached, false);
  const again = await (await call('/api/read-image', { method: 'POST', raw: true, body: img })).json();
  assert.equal(again.cached, true);
  assert.equal(again.text, r.text);
  const bad = await call('/api/read-image', { method: 'POST', raw: true, body: Buffer.from('not an image') });
  assert.equal(bad.status, 400);
});

test('a cited place brings its linked images, shown only from listed folders', async (t) => {
  const { root, call } = await serve(t);
  const shown = path.join(root, 'workspace', 'fabric', 'sources');
  fs.mkdirSync(shown, { recursive: true });
  const inside = path.join(shown, 'pipeline diagram.png');
  fs.writeFileSync(inside, png(320, 240, '#23905a'));
  const outside = path.join(root, 'elsewhere.png');
  fs.writeFileSync(outside, png());
  const text = '# Fabric\n\n## Planner Screen (totem) > Images\n\nThe orthorectification pipeline for SAR imagery.\n\n'
    + `![pipeline diagram.png](${pathToFileURL(inside).href})\n\n![elsewhere.png](${pathToFileURL(outside).href})\n`;
  const doc = path.join(root, 'fabric.notex.md');
  fs.writeFileSync(doc, text);
  assert.equal((await call('/api/docs/path', { method: 'POST', body: { path: doc } })).status, 202);
  let found;
  for (let i = 0; i < 100 && !found; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const r = await (await call('/api/search', { method: 'POST', body: { q: 'orthorectification pipeline' } })).json();
    found = (r.passages || []).find((p) => p.images && p.images.length);
  }
  assert.ok(found, 'the passage comes back with its images');
  assert.equal(found.heading, 'Fabric > Planner Screen (totem) > Images');
  assert.deepEqual(found.images.map((im) => [im.name, im.path]), [['pipeline diagram.png', inside], ['elsewhere.png', outside]]);
  const [mine, other] = found.images.map((im) => im.linkedId);

  // Nothing is opened until its folder is listed.
  assert.equal((await call(`/api/linked/${mine}/image`)).status, 403);
  assert.equal((await call('/api/settings', { method: 'PUT', body: { imageFolders: ['relative\\folder'] } })).status, 400);
  const set = await (await call('/api/settings', { method: 'PUT', body: { imageFolders: [path.join(root, 'workspace')] } })).json();
  assert.deepEqual(set.settings.imageFolders, [path.join(root, 'workspace')]);
  const ok = await call(`/api/linked/${mine}/image`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), fs.readFileSync(inside));
  assert.equal((await call(`/api/linked/${other}/image`)).status, 403);
  fs.rmSync(inside);
  assert.equal((await call(`/api/linked/${mine}/image`)).status, 404);
});
