import { test } from 'node:test';
import { READER } from './fixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { alive, LockError } from '../engine/lib/lifecycle.js';
import { fakeOllama } from './ollama-fake.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const ORIGIN = 'http://127.0.0.1:7070';
const lease = '# Lease\n\nRent of 1,200 is due on the first of each month.\n\n## Fees\n\nA late fee of 50 applies after five days.\n';

async function serve(t, { claude = 'answer', agy = 'echo', dir = null, poolOptions = {} } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'rag-server-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    agentOptions: {
      claude: { executable: process.execPath, prefixArgs: [FAKE, 'claude', claude], timeoutMs: 10_000 },
      agy: { executable: process.execPath, prefixArgs: [FAKE, 'agy', agy], timeoutMs: 10_000 },
    },
    poolOptions, signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  if (!dir) t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (p, { method = 'GET', body, headers = {}, token = s.token, raw = false, signal } = {}) => fetch(s.url + p, {
    method, signal,
    headers: { 'x-rag-token': token, origin: ORIGIN, ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  return { s, root, call };
}

const lines = async (res) => (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/* Read the event stream until an event matches, or fail after a while.
 * `.connected` settles once the stream's hello has arrived: a test sends its
 * request after that, or the event it waits for can pass before it listens
 * (t-acc77f0b6c). */
function waitFor(call, match, ms = 10_000) {
  let connectedNow;
  const connected = new Promise((r) => { connectedNow = r; });
  const result = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const res = await call('/api/events', { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('event stream ended');
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const e = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (e.type === 'hello') connectedNow();
          if (match(e)) return e;
        }
      }
    } finally { clearTimeout(timer); ac.abort(); connectedNow(); }
  })();
  result.connected = connected;
  return result;
}

async function withDoc(call) {
  const ready = waitFor(call, (e) => e.type === 'doc');
  await ready.connected;
  const up = await call('/api/docs', { method: 'POST', raw: true, body: lease, headers: { 'x-file-name': encodeURIComponent("lease (Paveen's).md") } });
  assert.equal(up.status, 202);
  return ready;
}

test('serving writes runtime.json with the url and token, and one data folder takes one engine', async (t) => {
  const { s, root } = await serve(t);
  const rt = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'runtime.json'), 'utf8'));
  assert.deepEqual([rt.url, rt.token, rt.pid], [s.url, s.token, process.pid]);
  await assert.rejects(startServer({ dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'x.json'), signals: false, log: () => {}, manageOllama: false }),
    (e) => e instanceof LockError && /already serving/.test(e.message));
});

test('requests without the token, from another origin or another host are refused', async (t) => {
  const { s, call } = await serve(t);
  assert.equal((await call('/api/state', { token: '' })).status, 401);
  assert.equal((await call('/api/state', { token: 'x'.repeat(32) })).status, 401);
  assert.equal((await call('/api/state', { headers: { origin: 'https://evil.example' } })).status, 403);
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host: `evil.example:${s.port}`, 'x-rag-token': s.token } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  assert.equal(rebound, 421);
  const ok = await call('/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
});

test("only ter-manager's origin passes the preflight", async (t) => {
  const { s } = await serve(t);
  const pre = (origin) => fetch(s.url + '/api/ask', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-rag-token' } });
  const good = await pre(ORIGIN);
  assert.equal(good.status, 204);
  assert.match(good.headers.get('access-control-allow-headers'), /X-Rag-Token/);
  assert.equal(good.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await pre('http://localhost:5173')).status, 403);
});

test('an upload keeps its name, is queued and ingested, and progress streams as it goes', async (t) => {
  const { call } = await serve(t);
  const progress = waitFor(call, (e) => e.type === 'ingest' && e.phase === 'ready');
  await progress.connected;
  const doc = await withDoc(call);
  assert.equal(doc.doc.name, "lease (Paveen's).md");
  assert.equal((await progress).name, "lease (Paveen's).md");
  const { docs } = await (await call('/api/docs')).json();
  assert.equal(docs[0].status, 'ready');
  assert.equal(docs[0].source_path, null, 'an upload has no source path');
});

test('a job joining the queue is announced, and a deleted conversation is gone', async (t) => {
  const { root, call } = await serve(t);
  const f = path.join(root, 'notes.txt');
  fs.writeFileSync(f, 'Invoice INV-2024-0042 was paid by transfer.');
  const queued = waitFor(call, (e) => e.type === 'queue' && (e.current === 'notes.txt' || (e.queue || []).includes('notes.txt')));
  const ready = waitFor(call, (e) => e.type === 'doc');
  await Promise.all([queued.connected, ready.connected]);
  await call('/api/docs/path', { method: 'POST', body: { path: f } });
  assert.ok(await queued);
  await ready;
  const done = (await lines(await call('/api/ask', { method: 'POST', body: { question: 'Invoice?', agent: 'claude' } }))).pop();
  assert.equal((await call(`/api/conversations/${done.conversationId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/conversations/${done.conversationId}`)).status, 404);
});

test('a file can be added by its path, and a relative path is refused', async (t) => {
  const { root, call } = await serve(t);
  const f = path.join(root, 'notes.txt');
  fs.writeFileSync(f, 'Invoice INV-2024-0042 was paid by transfer.');
  const ready = waitFor(call, (e) => e.type === 'doc');
  await ready.connected;
  assert.equal((await call('/api/docs/path', { method: 'POST', body: { path: f } })).status, 202);
  assert.equal((await ready).doc.name, 'notes.txt');
  assert.equal((await call('/api/docs/path', { method: 'POST', body: { path: 'notes.txt' } })).status, 400);
  const { passages } = await (await call('/api/search', { method: 'POST', body: { q: 'INV-2024-0042' } })).json();
  assert.equal(passages[0].docName, 'notes.txt');
});

test('ask streams the sources first, then the answer, then the checked citations', async (t) => {
  const { call } = await serve(t);
  await withDoc(call);
  const res = await call('/api/ask', { method: 'POST', body: { question: 'When is rent due?', agent: 'claude' } });
  assert.match(res.headers.get('content-type'), /ndjson/);
  const events = await lines(res);
  assert.equal(events[0].type, 'sources');
  assert.equal(events[0].sources[0].n, 1);
  assert.ok(events[0].sources[0].fresh);
  assert.ok(events.slice(1, -1).every((e) => e.type === 'delta'));
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  assert.equal(events.slice(1, -1).map((e) => e.text).join(''), done.answer);
  assert.deepEqual(done.cited, [1]);
});

test('an agy follow-up over HTTP is answered by the process that answered the first question', async (t) => {
  const { call, s } = await serve(t);
  await withDoc(call);
  const first = (await lines(await call('/api/ask', { method: 'POST', body: { question: 'When is rent due?', agent: 'agy' } }))).pop();
  const second = (await lines(await call('/api/ask', { method: 'POST', body: { question: 'Any late fee?', agent: 'agy', conversationId: first.conversationId } }))).pop();
  const [a, b] = [JSON.parse(first.answer), JSON.parse(second.answer)];
  assert.equal(a.pid, b.pid);
  assert.equal(b.turn, 2);
  assert.equal(s.pool.list()[0].conversationId, first.conversationId);
});

test('a warm spare is started on request and answers the next new conversation', async (t) => {
  const { call, s } = await serve(t);
  await withDoc(call);
  const w = await (await call('/api/agents/warm', { method: 'POST' })).json();
  assert.equal(w.warming, true);
  const sparePid = s.pool.list()[0].pid;
  const done = (await lines(await call('/api/ask', { method: 'POST', body: { question: 'Rent?', agent: 'agy' } }))).pop();
  assert.equal(JSON.parse(done.answer).pid, sparePid);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.pool.list().filter((p) => p.spare).length, 1, 'a new spare was started after the old one was taken');
});

test('a second question to a conversation still answering is refused with 409', async (t) => {
  const { call } = await serve(t, { agy: 'slow' });
  await withDoc(call);
  const first = (await lines(await call('/api/ask', { method: 'POST', body: { question: 'Rent?', agent: 'agy' } }))).pop();
  const running = call('/api/ask', { method: 'POST', body: { question: 'Fees?', agent: 'agy', conversationId: first.conversationId } });
  await new Promise((r) => setTimeout(r, 350));
  const again = await call('/api/ask', { method: 'POST', body: { question: 'More?', agent: 'agy', conversationId: first.conversationId } });
  assert.equal(again.status, 409);
  await (await running).text();
});

test('closing the request mid-answer ends the agent', async (t) => {
  const { call, s } = await serve(t, { agy: 'hang' });
  await withDoc(call);
  const ac = new AbortController();
  const req = call('/api/ask', { method: 'POST', body: { question: 'Rent?', agent: 'agy' }, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 600));
  const live = s.pool.list().map((x) => x.pid);
  assert.equal(live.length, 1, 'the answering session is held by the pool before it has a conversation');
  ac.abort();
  await req.catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(s.pool.list().length, 0);
  for (const p of live) assert.equal(alive(p), false, `agent ${p} still running`);
});

test('stopping ends answers in flight and open agents, and removes runtime.json and the lock', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { s, call } = await serve(t, { agy: 'hang', dir: root });
  await withDoc(call);
  const asking = call('/api/ask', { method: 'POST', body: { question: 'Rent?', agent: 'agy' } }).then(lines);
  await new Promise((r) => setTimeout(r, 600));
  const pids = s.pool.list().map((x) => x.pid);
  assert.equal(pids.length, 1);
  assert.equal((await call('/api/shutdown', { method: 'POST' })).status, 202);
  const events = await asking;
  assert.equal(events.pop().code, 'cancelled');
  await s.stop();
  assert.ok(!fs.existsSync(path.join(root, 'plugin', 'runtime.json')));
  assert.ok(!fs.existsSync(path.join(root, 'data', 'engine.lock')));
  for (const p of pids) assert.equal(alive(p), false);
  // The folder can be served again.
  const again = await serve(t, { dir: root });
  await again.s.stop();
});

test('agents a hard-killed engine left running are ended on the next start, if still the same program', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-orphan-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'data', 'agents.json'), JSON.stringify({ [orphan.pid]: path.basename(process.execPath).toLowerCase(), 99999991: 'agy.exe' }));
  t.after(() => { try { orphan.kill(); } catch (_) {} fs.rmSync(root, { recursive: true, force: true }); });
  const { s } = await serve(t, { dir: root });
  assert.deepEqual(s.orphans.map((o) => o.pid), [orphan.pid]);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(alive(orphan.pid), false);
  await s.stop();
});

test('serving starts Ollama when none is running, and stopping ends the one it started', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-ollama-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const probe = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => probe.once('listening', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const host = `http://127.0.0.1:${port}`;
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'data'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    ollamaOptions: { host, executable: process.execPath, prefixArgs: [path.join(path.dirname(FAKE), 'fake-ollama.mjs')], startTimeoutMs: 8000 },
    signals: false, log: () => {},
  });
  const started = await s.ollamaReady;
  assert.equal(started.owned, true);
  const st = await (await fetch(s.url + '/api/state', { headers: { 'x-rag-token': s.token } })).json();
  assert.equal(st.ollama.owned, true);
  assert.ok(alive(started.pid));
  await s.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(started.pid), false);
  assert.equal(await fetch(host + '/api/version').then(() => 'up', () => 'down'), 'down');
});

test('every call is tracked with who made it, and the tracker API reports it', async (t) => {
  const { call } = await serve(t);
  const tracked = waitFor(call, (e) => e.type === 'call' && e.call.kind === 'ingest');
  await tracked.connected;
  await withDoc(call);
  assert.equal((await tracked).call.source, 'other', 'a request that names no client');
  await call('/api/search', { method: 'POST', body: { q: 'rent' }, headers: { 'x-rag-client': 'plugin' } });
  await call('/api/search', { method: 'POST', body: { q: 'late fee' }, headers: { 'x-rag-client': 'mcp:claude-code/2.1.307 cwd=E:\\work' } });
  await call('/api/docs', { headers: { 'x-rag-client': 'mcp:claude-code/2.1.307' } });
  await call('/api/docs', { headers: { 'x-rag-client': 'plugin' } });
  (await call('/api/ask', { method: 'POST', body: { question: 'When is rent due?', agent: 'claude' }, headers: { 'x-rag-client': 'plugin' } })).text();
  await new Promise((r) => setTimeout(r, 300));

  const { calls } = await (await call('/api/tracker/calls')).json();
  assert.deepEqual(calls.map((c) => `${c.source}:${c.kind}`), ['you:ask', 'agent:documents', 'agent:search', 'you:search', 'other:ingest'],
    'the page listing documents is not a call; an agent doing it is');
  const agentSearch = await (await call(`/api/tracker/calls/${calls[2].id}`)).json();
  assert.equal(agentSearch.client, 'mcp:claude-code/2.1.307 cwd=E:\\work');
  assert.equal(agentSearch.question, 'late fee');
  assert.ok(agentSearch.detail.passages[0].text.length > 0, 'what came back is kept');
  const ask = await (await call(`/api/tracker/calls/${calls[0].id}`)).json();
  assert.equal(ask.agent, 'claude');
  assert.ok(ask.detail.answer && ask.detail.cited);
  assert.ok(ask.agent_ms >= 0 && ask.ms >= ask.agent_ms);

  const s = await (await call('/api/tracker/summary?range=day')).json();
  assert.equal(s.calls, 5);
  assert.deepEqual([s.bySource.you.calls, s.bySource.agent.calls], [2, 2]);
  assert.equal((await call('/api/tracker/calls', { method: 'DELETE' })).status, 200);
  assert.equal((await (await call('/api/tracker/calls')).json()).calls.length, 0);
});

test('the event stream carries an ask live: announced at its start, through its phases, then its record', async (t) => {
  const { call } = await serve(t);
  await (await withDoc(call));
  const seen = [];
  const done = waitFor(call, (e) => { if (e.type && e.type.startsWith('call')) seen.push(e); return e.type === 'call' && e.call.kind === 'ask'; });
  await done.connected;
  await (await call('/api/ask', { method: 'POST', body: { question: 'When is rent due?', agent: 'claude' }, headers: { 'x-rag-client': 'plugin' } })).text();
  const end = await done;
  const asks = seen.filter((e) => e.run === end.run);
  assert.deepEqual(asks.map((e) => e.type === 'call-phase' ? e.phase : e.type), ['call-start', 'agent answering', 'call']);
  assert.equal(asks[0].question, 'When is rent due?');
  assert.equal(asks[0].source, 'you');
  assert.equal(end.call.detail, undefined);
});

test('state reports Ollama, the agents, the settings and the pool', async (t) => {
  const { call } = await serve(t);
  const st = await (await call('/api/state')).json();
  assert.equal(st.ollama.state, 'up');
  assert.equal(st.settings.claudeModel, 'sonnet');
  assert.ok('claude' in st.agents && 'agy' in st.agents);
  assert.deepEqual(st.pool, []);
  const put = await (await call('/api/settings', { method: 'PUT', body: { agent: 'agy', claudeModel: 'haiku' } })).json();
  assert.deepEqual([put.settings.agent, put.settings.claudeModel], ['agy', 'haiku']);
  assert.equal((await call('/api/settings', { method: 'PUT', body: { agent: 'gpt' } })).status, 400);
});

test('a cited passage comes with the text around it, and a removed document is gone', async (t) => {
  const { call } = await serve(t);
  const { doc } = await withDoc(call);
  const { passages } = await (await call('/api/search', { method: 'POST', body: { q: 'late fee' } })).json();
  const view = await (await call(`/api/chunks/${passages[0].chunkIds[0]}`)).json();
  assert.equal(view.docName, "lease (Paveen's).md");
  assert.ok(view.chunk.text.length > 0);
  assert.equal((await call(`/api/docs/${doc.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/chunks/${passages[0].chunkIds[0]}`)).status, 404);
});

test('a figure is served as its details and its PNG, and an agent fetching one is tracked', async (t) => {
  const { makePdf, barChartPage } = await import('./fixtures.js');
  const { s, call } = await serve(t);
  const ready = waitFor(call, (e) => e.type === 'doc');
  await ready.connected;
  const pdf = makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]]);
  assert.equal((await call('/api/docs', { method: 'POST', raw: true, body: pdf, headers: { 'x-file-name': 'costs.pdf' } })).status, 202);
  const { doc } = await ready;
  assert.equal(doc.figures, 1);

  const { figures } = await (await call(`/api/docs/${doc.id}/figures`)).json();
  assert.deepEqual(figures.map((f) => [f.docName, f.kind, f.page, f.caption]), [['costs.pdf', 'drawing', 1, 'Figure 1 - Costs by region in 2024.']]);
  const id = figures[0].id;
  assert.equal((await (await call(`/api/figures/${id}`)).json()).caption, 'Figure 1 - Costs by region in 2024.');
  const img = await call(`/api/figures/${id}/image`, { headers: { 'x-rag-client': 'mcp:claude-code/2.1.308 cwd=E:\work' } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.readUInt32BE(0), 0x89504e47, 'a PNG');
  await call(`/api/figures/${id}/image`, { headers: { 'x-rag-client': 'plugin' } });
  assert.deepEqual(s.tracker.calls({ kind: 'figure' }).map((c) => c.source), ['agent'], 'the page showing a figure is not a call');
  assert.equal((await call('/api/figures/999999/image')).status, 404);
  assert.equal((await call(`/api/figures/${id}/image`, { token: 'wrong' })).status, 401);
});

test('reading over HTTP: an upload is read, reading can be turned off, and Read figures now reads what waits', async (t) => {
  const { makePdf, barChartPage } = await import('./fixtures.js');
  const { s, call } = await serve(t);
  const upload = async (name, caption, title) => {
    const ready = waitFor(call, (e) => e.type === 'doc' && e.doc.name === name);
    await ready.connected;
    await call('/api/docs', { method: 'POST', raw: true, body: makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700, caption, title })]]), headers: { 'x-file-name': name } });
    return (await ready).doc;
  };
  const a = await upload('a.pdf', 'Figure 1 - Costs by region in 2024.');
  assert.deepEqual([a.figures, a.figures_read], [1, 1]);
  const ingest = s.tracker.calls({ kind: 'ingest' })[0];
  assert.equal(ingest.reads, 1);
  assert.ok(ingest.read_ms > 0);

  const off = await (await call('/api/settings', { method: 'PUT', body: { readFigures: false, readModel: 'haiku' } })).json();
  assert.deepEqual([off.settings.readFigures, off.settings.readModel], [false, 'haiku']);
  // A different chart: the same image would come from its kept reading, which costs nothing.
  const b = await upload('b.pdf', 'Figure 2 - Costs by region in 2025.', 'Costs in 2025');
  assert.deepEqual([b.figures, b.figures_read], [1, 0], 'not read with reading off');

  const read = waitFor(call, (e) => e.type === 'doc' && e.status === 'read');
  await read.connected;
  const r = await (await call('/api/read', { method: 'POST' })).json();
  assert.deepEqual(r.queued, ['b.pdf']);
  assert.equal((await read).doc.figures_read, 1);
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(s.tracker.calls({ kind: 'read' }).map((c) => [c.question, c.reads]), [['b.pdf', 1]]);
  assert.equal((await call('/api/docs/999/read', { method: 'POST' })).status, 404);
});
