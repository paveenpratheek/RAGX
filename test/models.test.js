import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder, DEFAULT_MODEL } from '../engine/lib/embed.js';
import { listModels, ModelPull, validName, sameModel } from '../engine/lib/models.js';
import { fakeOllama } from './ollama-fake.js';

/* fakeOllama, plus what it lacks: /api/tags for the installed models (a chat
 * model among them) and a streaming /api/pull. A pulled model becomes
 * installed; 'slow' streams until it is cancelled; 'nope' does not exist. */
function ollamaWithPull() {
  const models = { [DEFAULT_MODEL]: 64 };
  const seen = { aborted: false };
  const base = fakeOllama({ models });
  const chat = new Set(['llama3.2:latest']);
  const sizes = { [DEFAULT_MODEL]: 330e6, 'llama3.2:latest': 2e9 };
  const reply = (status, json) => ({ ok: status < 300, status, statusText: String(status), json: async () => json });
  const stream = (lines, { hang = false } = {}, signal) => ({
    ok: true, status: 200,
    body: new ReadableStream({
      async start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + '\n'));
        if (!hang) return c.close();
        signal.addEventListener('abort', () => { seen.aborted = true; c.error(new DOMException('aborted', 'AbortError')); });
      },
    }),
  });
  const fetch = async (url, init = {}) => {
    const p = new URL(url).pathname;
    if (p === '/api/tags') return reply(200, { models: [...Object.keys(models), ...chat].map((name) => ({ name, size: sizes[name] ?? 1e8 })) });
    const body = init.body ? JSON.parse(init.body) : {};
    if (p === '/api/show' && chat.has(body.model)) return reply(200, { capabilities: ['completion'] });
    if (p === '/api/pull') {
      if (body.model === 'nope') return stream([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]);
      if (body.model === 'slow') return stream([{ status: 'pulling manifest' }, { status: 'pulling aa', digest: 'aa', total: 100, completed: 10 }], { hang: true }, init.signal);
      const lines = [{ status: 'pulling manifest' },
        { status: 'pulling aa', digest: 'aa', total: 300, completed: 0 }, { status: 'pulling aa', digest: 'aa', total: 300, completed: 300 },
        { status: 'pulling bb', digest: 'bb', total: 100, completed: 100 },
        { status: 'verifying sha256 digest' }, { status: 'writing manifest' }, { status: 'success' }];
      if (body.model === 'phi3:mini') chat.add('phi3:mini'); else models[body.model] = 32;
      return stream(lines);
    }
    return base.fetch(url, init);
  };
  return { fetch, models, seen };
}

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-models-'));
  const ollama = ollamaWithPull();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (p, { method = 'GET', body } = {}) => {
    const r = await fetch(s.url + p, { method, headers: { 'x-rag-token': s.token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const pullDone = async () => {
    for (let i = 0; i < 100; i++) { const { body } = await call('/api/state'); if (body.pull && body.pull.done) return body.pull; await new Promise((r) => setTimeout(r, 30)); }
    throw new Error('the download never finished');
  };
  return { s, call, pullDone, ollama };
}

test('model names: Ollama names pass, anything that could be a path or a flag does not', () => {
  for (const ok of ['bge-m3', 'embeddinggemma-2:440m', 'jeffh/intfloat-multilingual-e5-large:f16', 'nomic-embed-text']) assert.ok(validName(ok), ok);
  for (const bad of ['', '-rf', '../x', 'a b', 'a:b:c', 'x'.repeat(201), null]) assert.ok(!validName(bad), String(bad));
  assert.ok(sameModel('bge-m3', 'bge-m3:latest'));
  assert.ok(!sameModel('bge-m3', 'bge-m3:567m'));
});

test('the model list holds only models that can embed, with their size and what they embed', async () => {
  const o = ollamaWithPull();
  const list = await listModels({ host: 'http://127.0.0.1:11434', fetch: o.fetch });
  assert.deepEqual(list, [{ name: DEFAULT_MODEL, size: 330e6, vision: true }]);
});

test('over HTTP: the list and suggestions, a download with its progress, then the model can be saved', async (t) => {
  const { call, pullDone } = await serve(t);
  let r = await call('/api/ollama/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.current, DEFAULT_MODEL);
  assert.deepEqual(r.body.models.map((m) => m.name), [DEFAULT_MODEL]);
  assert.equal(r.body.suggested.find((m) => m.name === DEFAULT_MODEL).installed, true);
  assert.equal(r.body.suggested.find((m) => m.name === 'bge-m3').installed, false);

  r = await call('/api/ollama/pull', { method: 'POST', body: { model: 'bge-m3' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.pull.model, 'bge-m3');
  const p = await pullDone();
  assert.deepEqual({ ok: p.ok, completed: p.completed, total: p.total, embeds: p.embeds, error: p.error }, { ok: true, completed: 400, total: 400, embeds: true, error: null });

  r = await call('/api/ollama/models');
  assert.deepEqual(r.body.models.map((m) => m.name), ['bge-m3', DEFAULT_MODEL]);
  assert.equal(r.body.suggested.find((m) => m.name === 'bge-m3').installed, true);
  // Downloading does not change the setting; saving does.
  assert.equal((await call('/api/settings')).body.model, DEFAULT_MODEL);
  r = await call('/api/settings', { method: 'PUT', body: { embedModel: 'bge-m3' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.model, 'bge-m3');
});

test('a download that fails, one that cannot embed, a bad name, a second at once, and a cancel', async (t) => {
  const { call, pullDone } = await serve(t);
  assert.equal((await call('/api/ollama/pull', { method: 'POST', body: { model: '../etc' } })).status, 400);

  await call('/api/ollama/pull', { method: 'POST', body: { model: 'nope' } });
  let p = await pullDone();
  assert.equal(p.ok, false);
  assert.equal(p.error, 'Ollama has no model called nope.');

  await call('/api/ollama/pull', { method: 'POST', body: { model: 'phi3:mini' } });
  p = await pullDone();
  assert.equal(p.ok, true);
  assert.equal(p.embeds, false, 'a chat model is downloaded, and said not to embed');

  assert.equal((await call('/api/ollama/pull', { method: 'POST', body: { model: 'slow' } })).status, 202);
  const second = await call('/api/ollama/pull', { method: 'POST', body: { model: 'bge-m3' } });
  assert.equal(second.status, 409);
  assert.match(second.body.error.message, /slow is downloading/);
  const c = await call('/api/ollama/pull', { method: 'DELETE' });
  assert.equal(c.body.cancelled, true);
  p = await pullDone();
  assert.equal(p.error, 'Cancelled.');
});

test('progress is told at most every few hundred ms, and always at the end', async () => {
  const events = [];
  const o = ollamaWithPull();
  const pull = new ModelPull({ host: 'http://127.0.0.1:11434', fetch: o.fetch, emit: (e) => events.push(e.pull), everyMs: 10_000 });
  pull.start('bge-m3');
  await pull.finished;
  assert.equal(events.length, 2, 'the first line, then the end');
  assert.equal(events.at(-1).done, true);
  assert.equal(events.at(-1).ok, true);
});

test('stopping the engine ends a download in flight', async (t) => {
  const { s, call, ollama } = await serve(t);
  await call('/api/ollama/pull', { method: 'POST', body: { model: 'slow' } });
  await s.stop();
  assert.equal(ollama.seen.aborted, true, 'the stream from Ollama was ended');
});
