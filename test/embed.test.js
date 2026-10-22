import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Embedder, EmbedError, signature, chunkInput, DEFAULT_MODEL, OLLAMA } from '../engine/lib/embed.js';

/* A stand-in for Ollama: answers by the handler given, records every call. */
function fakeOllama(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, body });
    const { status = 200, json } = await handler(new URL(url).pathname, body, calls.length);
    return { ok: status < 300, status, statusText: String(status), json: async () => json };
  };
  return { fetch, calls };
}

const vectors = (n, dim = 3) => Array.from({ length: n }, (_, i) => Array.from({ length: dim }, (_, j) => (i + j) / 10));

test('documents are embedded in batches, with truncate off and the document prefix on', async () => {
  const { fetch, calls } = fakeOllama((path, body) => ({ json: { embeddings: vectors(body.input.length) } }));
  const e = new Embedder({ fetch, batch: 2, docPrefix: 'search_document: ' });
  const out = await e.embedDocuments(['a', 'b', 'c']);
  assert.equal(out.length, 3);
  assert.ok(out[0] instanceof Float32Array);
  assert.deepEqual(calls.map((c) => c.body.input), [['search_document: a', 'search_document: b'], ['search_document: c']]);
  assert.ok(calls.every((c) => c.body.truncate === false && c.body.model === DEFAULT_MODEL));
});

test('a query gets the query prefix, not the document one', async () => {
  const { fetch, calls } = fakeOllama(() => ({ json: { embeddings: vectors(1) } }));
  await new Embedder({ fetch, queryPrefix: 'search_query: ', docPrefix: 'search_document: ' }).embedQuery('when?');
  assert.deepEqual(calls[0].body.input, ['search_query: when?']);
});

test('describe reads the dimension and context length, and refuses a model that cannot embed', async () => {
  const show = (caps) => fakeOllama(() => ({ json: {
    capabilities: caps,
    model_info: { 'general.architecture': 'nomic-bert-moe', 'nomic-bert-moe.embedding_length': 768, 'nomic-bert-moe.context_length': 512 },
  } }));
  assert.deepEqual(await new Embedder({ fetch: show(['embedding']).fetch }).describe(), { model: DEFAULT_MODEL, dim: 768, ctx: 512 });
  await assert.rejects(new Embedder({ model: 'llama3', fetch: show(['completion']).fetch }).describe(), (e) => e.code === 'not-embedding');
});

test('Ollama errors come back by name', async () => {
  const missing = fakeOllama(() => ({ status: 404, json: { error: 'model "x" not found, try pulling it first' } }));
  await assert.rejects(new Embedder({ model: 'x', fetch: missing.fetch }).embedQuery('q'),
    (e) => e instanceof EmbedError && e.code === 'model-missing' && /ollama pull x/.test(e.message));
  const long = fakeOllama(() => ({ status: 400, json: { error: 'the input length exceeds the context length' } }));
  await assert.rejects(new Embedder({ fetch: long.fetch }).embedQuery('q'), (e) => e.code === 'too-long');
  const down = { fetch: async () => { throw new TypeError('fetch failed'); } };
  await assert.rejects(new Embedder({ fetch: down.fetch, retries: 0 }).embedQuery('q'), (e) => e.code === 'ollama-down' && /ollama serve/.test(e.message));
});

test('a server error is retried, a refusal is not', async () => {
  const flaky = fakeOllama((p, body, n) => (n < 2 ? { status: 500, json: { error: 'busy' } } : { json: { embeddings: vectors(1) } }));
  await new Embedder({ fetch: flaky.fetch, retries: 2 }).embedQuery('q');
  assert.equal(flaky.calls.length, 2);
  const bad = fakeOllama(() => ({ status: 400, json: { error: 'invalid input' } }));
  await assert.rejects(new Embedder({ fetch: bad.fetch, retries: 2 }).embedQuery('q'), (e) => e.code === 'ollama');
  assert.equal(bad.calls.length, 1);
});

test('vectors of a different length than the first are refused', async () => {
  let n = 0;
  const { fetch } = fakeOllama(() => ({ json: { embeddings: [vectors(1, n++ ? 4 : 3)[0]] } }));
  const e = new Embedder({ fetch });
  await e.embedQuery('one');
  await assert.rejects(e.embedQuery('two'), /4 dimensions, expected 3/);
});

test('the signature changes with the model and the document prefix, not the query prefix', () => {
  assert.equal(signature({ model: 'nomic' }), 'nomic');
  assert.equal(signature({ model: 'nomic', docPrefix: 'search_document: ' }), 'nomic|doc:search_document: ');
  assert.equal(signature({ model: 'nomic', queryPrefix: 'q: ' }), 'nomic');
  assert.equal(chunkInput('Lease.pdf', 'Terms > Rent', 'Due monthly.'), 'Lease.pdf > Terms > Rent\n\nDue monthly.');
  assert.equal(chunkInput('notes.txt', '', 'Hi.'), 'notes.txt\n\nHi.');
});

/* Against the real Ollama, when it is running. */
const live = await fetch(OLLAMA + '/api/version').then((r) => r.ok).catch(() => false);
const hasNomic = live && await fetch(OLLAMA + '/api/show', { method: 'POST', body: JSON.stringify({ model: DEFAULT_MODEL }) }).then((r) => r.ok).catch(() => false);

test('live: nomic reports 768 dimensions and a 512-token window, and embeds normalised vectors', { skip: !hasNomic && 'Ollama or the model is not available' }, async () => {
  const e = new Embedder();
  assert.deepEqual(await e.describe(), { model: DEFAULT_MODEL, dim: 768, ctx: 512 });
  const [v] = await e.embedDocuments(['The invoice was paid on 3 March.']);
  assert.equal(v.length, 768);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-3);
});

test('live: a chunk too long for nomic fails by name instead of being cut', { skip: !hasNomic && 'Ollama or the model is not available' }, async () => {
  await assert.rejects(new Embedder().embedDocuments(['word '.repeat(3000)]), (e) => e.code === 'too-long');
});

test('live: a model that is not downloaded is named', { skip: !live && 'Ollama is not running' }, async () => {
  await assert.rejects(new Embedder({ model: 'no-such-embedding-model-xyz' }).describe(), (e) => e.code === 'model-missing');
});
