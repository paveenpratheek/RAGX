/* Asking only some documents: a conversation keeps the documents it was
 * limited to, search fills every slot from them, and an agent can narrow a
 * ragx_search the same way (t-c323b2002a, t-2c61e12cb6, t-6fbca7a8a6). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fake-agent.mjs');
const MCP = path.join(HERE, '..', 'engine', 'mcp.js');
const ORIGIN = 'http://127.0.0.1:7070';

// Removed at exit: an engine still holding its database cannot have its folder deleted on Windows (t-4827696cff).
const dirs = [];
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-scope-'));
  dirs.push(root);
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    agentOptions: { claude: { executable: process.execPath, prefixArgs: [FAKE, 'claude', 'answer'], timeoutMs: 10_000 } },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(() => s.stop());
  // Three papers on one topic, each with several passages about it.
  const ids = {};
  for (const name of ['alpha', 'beta', 'gamma']) {
    const f = path.join(root, `${name}.md`);
    fs.writeFileSync(f, Array.from({ length: 4 }, (_, i) => `## ${name} section ${i + 1}\n\nSAR orthorectification with ground control points, method ${i + 1} of the ${name} paper.\n`).join('\n'));
    ids[name] = (await s.engine.ingest(f)).doc.id;
  }
  const json = async (p, body) => {
    const r = await fetch(s.url + p, { method: body ? 'POST' : 'GET', headers: { 'x-rag-token': s.token, origin: ORIGIN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: r.headers.get('content-type').includes('ndjson') ? (await r.text()).trim().split('\n').map((l) => JSON.parse(l)) : await r.json() };
  };
  return { s, root, ids, json };
}

const docsOf = (passages) => [...new Set(passages.map((p) => p.docName))].sort();

test('search limited to two documents fills its slots from them alone', async (t) => {
  const { ids, json } = await serve(t);
  const q = 'SAR orthorectification with ground control points';
  const all = (await json('/api/search', { q, k: 8 })).body;
  assert.deepEqual(docsOf(all.passages), ['alpha.md', 'beta.md', 'gamma.md']);
  const two = (await json('/api/search', { q, k: 6, docs: [ids.alpha, ids.beta] })).body;
  assert.deepEqual(docsOf(two.passages), ['alpha.md', 'beta.md']);
  assert.equal(two.passages.length, 6, 'three from each, every slot filled');
  assert.equal((await json('/api/search', { q, docs: ['x'] })).status, 400);
  assert.deepEqual((await json('/api/search', { q, docs: [] })).body.passages, []);
});

test('a conversation keeps the documents it was limited to', async (t) => {
  const { s, ids, json } = await serve(t);
  const ask = async (body) => (await json('/api/ask', body)).body;
  const first = await ask({ question: 'How is SAR orthorectified with ground control points?', docs: [ids.alpha, ids.beta] });
  const done = first.find((e) => e.type === 'done');
  const sources = first.find((e) => e.type === 'sources').sources;
  assert.deepEqual(docsOf(sources), ['alpha.md', 'beta.md']);
  assert.deepEqual(done.scope, [ids.alpha, ids.beta]);
  const conv = (await json(`/api/conversations/${done.conversationId}`)).body.conversation;
  assert.deepEqual(conv.scope, [ids.alpha, ids.beta]);

  // A follow-up that says nothing about documents keeps the conversation's choice.
  const again = await ask({ question: 'And which method comes first?', conversationId: done.conversationId });
  assert.ok(again.find((e) => e.type === 'sources').sources.every((x) => x.docName !== 'gamma.md'));

  // A document removed later simply drops out.
  s.engine.remove(ids.beta);
  const third = await ask({ question: 'What else about ground control points?', conversationId: done.conversationId });
  assert.deepEqual(third.find((e) => e.type === 'done').scope, [ids.alpha]);

  // Nothing in the chosen documents: no agent is started.
  const none = await ask({ question: 'ground control points', docs: [ids.beta] });
  const nd = none.find((e) => e.type === 'done');
  assert.equal(nd.asked, false);
  assert.match(nd.answer, /Nothing in the chosen documents/);
});

test('ragx_search takes the documents to search by name', async (t) => {
  const { root } = await serve(t);
  const child = spawn(process.execPath, [MCP, '--runtime', path.join(root, 'runtime.json'), '--notifications', path.join(root, 'notifications.json'), '--wait-ms', '5000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buf = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((r) => { const id = ++seq; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.307' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tool = async (args) => (await rpc('tools/call', { name: 'ragx_search', arguments: args })).result;

  const r = await tool({ query: 'SAR orthorectification with ground control points', k: 6, documents: ['alpha.md', 'gamm'] });
  const text = r.content[0].text;
  assert.match(text, /results from the user's documents in alpha\.md; gamma\.md for/);
  assert.ok(!/beta\.md/.test(text), text);
  const unknown = await tool({ query: 'SAR', documents: ['delta'] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /No document is called "delta"\. The documents are: alpha\.md; beta\.md; gamma\.md/);
  const many = await tool({ query: 'SAR', documents: ['.md'] });
  assert.match(many.content[0].text, /fits 3 documents/);
});
