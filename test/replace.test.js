/* A file added with the name of a document already in the library: replaced
 * when asked - by upload, by path - or kept beside it (t-5eca331928,
 * t-7e7fbdf2f2, t-b2385584f0). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';

const ORIGIN = 'http://127.0.0.1:7070';
const lease = (rent) => `# Lease\n\nThe tenancy runs for two years from January.\n\n## Rent\n\nRent of ${rent} is due on the first of each month.\n\n## Repairs\n\nThe landlord repairs the roof and the boiler.\n`;

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-replace-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (p, { method = 'GET', body, raw = false, headers = {} } = {}) => {
    const r = await fetch(s.url + p, {
      method, headers: { 'x-rag-token': s.token, origin: ORIGIN, ...(raw ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const docs = async () => (await call('/api/docs')).body.docs;
  const until = async (fn, what) => {
    for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const settled = (n) => until(async () => { const d = await docs(); return d.length === n && d.every((x) => x.status === 'ready') ? d : null; }, `${n} ready documents`);
  return { root, s, call, docs, settled, ollama };
}

test('an upload named like a document replaces it only when asked, and re-embeds only what changed', async (t) => {
  const { call, settled, ollama, s } = await serve(t);
  const up = (text, headers = {}) => call('/api/docs', { method: 'POST', raw: true, body: text, headers: { 'x-file-name': 'lease.md', ...headers } });

  // The page's preflight must let the header through.
  const pre = await fetch(s.url + '/api/docs', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-headers': 'x-replace' } });
  assert.match(pre.headers.get('access-control-allow-headers'), /X-Replace/);

  assert.equal((await up(lease('1,200'))).body.replace, false);
  await settled(1);

  // Keep both: two documents of the name.
  await up(lease('1,300'));
  const both = await settled(2);
  assert.deepEqual(both.map((d) => d.name), ['lease.md', 'lease.md']);

  // Replace: one version left, the newest; only the changed Rent place embedded.
  const before = ollama.inputs.length;
  assert.equal((await up(lease('1,400'), { 'x-replace': '1' })).body.replace, true);
  const [last] = await settled(1);
  assert.ok(last.id > both[1].id);
  const sent = ollama.inputs.slice(before);
  assert.equal(sent.length, 1, `only the changed place: ${JSON.stringify(sent)}`);
  assert.match(sent[0], /1,400/);
});

test('a path can replace too, and the same bytes again change nothing', async (t) => {
  const { root, call, settled } = await serve(t);
  const file = path.join(root, 'lease.md');
  fs.writeFileSync(file, lease('900'));
  await call('/api/docs/path', { method: 'POST', body: { path: file } });
  const [first] = await settled(1);

  fs.writeFileSync(file, lease('950'));
  assert.equal((await call('/api/docs/path', { method: 'POST', body: { path: file, replace: true } })).body.replace, true);
  const [second] = await settled(1);
  assert.notEqual(second.id, first.id);

  await call('/api/docs/path', { method: 'POST', body: { path: file, replace: true } });
  await new Promise((r) => setTimeout(r, 300));
  const [same] = await settled(1);
  assert.equal(same.id, second.id, 'already in the library: kept as it is');
});
