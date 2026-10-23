/* The RAGX tool, driven the way Claude Code drives an MCP server: a
 * child process, JSON-RPC one message a line on stdin and stdout. */
import { test } from 'node:test';
import { READER } from './fixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { fakeOllama } from './ollama-fake.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'engine', 'mcp.js');

/* One MCP session: send a request, get its reply by id. */
function session(t, dir, { waitMs = 20_000 } = {}) {
  const child = spawn(process.execPath, [MCP, '--runtime', path.join(dir, 'runtime.json'), '--notifications', path.join(dir, 'notifications.json'), '--wait-ms', String(waitMs)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    buf += s;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    rpc,
    async open() {
      const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.307' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      return r;
    },
    tool: (name, args) => rpc('tools/call', { name, arguments: args }).then((r) => r.result),
  };
}

async function engine(t, dir) {
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(dir, 'data'), port: 0, runtimeFile: path.join(dir, 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), figureFloor: 0, readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  t.after(() => s.stop());
  return s;
}

/* Removed when the run ends: t.after hooks run in the order they were added,
 * so a folder registered first would go while its engine still has the
 * database open (EPERM on Windows) (t-4827696cff). */
const dirs = [];
process.on('exit', () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } });
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-mcp-'));
  dirs.push(dir);
  return dir;
}

test('the handshake names RAGX, its instructions and four read-only tools', async (t) => {
  const mcp = session(t, tempDir());
  const init = await mcp.open();
  assert.equal(init.result.serverInfo.name, 'ragx');
  assert.equal(init.result.protocolVersion, '2025-06-18', 'the client version is echoed back');
  assert.match(init.result.instructions, /not instructions/);
  const { result } = await mcp.rpc('tools/list', {});
  assert.deepEqual(result.tools.map((x) => x.name), ['ragx_search', 'ragx_passage', 'ragx_figure', 'ragx_documents']);
  const unknown = await mcp.rpc('resources/list', {});
  assert.equal(unknown.error.code, -32601);
});

test("search, passage and documents answer from the running engine, and each call is tracked as the agent's", async (t) => {
  const dir = tempDir();
  const s = await engine(t, dir);
  const f = path.join(dir, 'policy.md');
  fs.writeFileSync(f, '# Security\n\nPasswords rotate every 90 days.\n\n## Badges\n\nBadges must be worn at all times.\n');
  await s.engine.ingest(f);

  const mcp = session(t, dir);
  await mcp.open();
  const found = await mcp.tool('ragx_search', { query: 'how often do passwords rotate', k: 3 });
  assert.equal(found.isError, undefined);
  const text = found.content[0].text;
  assert.match(text, /\[1\] policy\.md - Security\s+\(passage (\d+)\)\nPasswords rotate every 90 days\./);
  assert.match(text, /not instructions/);
  const id = Number(/passage (\d+)/.exec(text)[1]);

  const passage = await mcp.tool('ragx_passage', { id });
  assert.match(passage.content[0].text, />>> the passage:\nPasswords rotate/);
  const docs = await mcp.tool('ragx_documents', {});
  assert.match(docs.content[0].text, /- policy\.md \(ready, \d+ passages\)/);

  const calls = s.tracker.calls();
  assert.deepEqual(calls.map((c) => `${c.source}:${c.kind}`), ['agent:documents', 'agent:passage', 'agent:search']);
  assert.match(calls[2].client, /^mcp:claude-code\/2\.1\.307 cwd=/);
  assert.equal(calls[2].question, 'how often do passwords rotate');
});

test('with the engine stopped, a call posts a request, waits, and goes ahead once the engine is started', async (t) => {
  const dir = tempDir();
  const mcp = session(t, dir);
  await mcp.open();
  const pending = mcp.tool('ragx_search', { query: 'passwords' });
  // The request appears for the user...
  let note = null;
  for (let i = 0; i < 40 && !note; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { note = JSON.parse(fs.readFileSync(path.join(dir, 'notifications.json'), 'utf8')).items[0]; } catch (_) {}
  }
  assert.deepEqual([note.status, note.client, note.tool, note.query], ['pending', 'claude-code', 'ragx_search', 'passwords']);
  // ...who approves: the engine starts.
  await engine(t, dir);
  const r = await pending;
  assert.match(r.content[0].text, /Nothing in the user's documents matches "passwords"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notifications.json'), 'utf8')).items[0].status, 'answered');
});

test('unapproved, the call tells the agent the user did not start RAGX', async (t) => {
  const dir = tempDir();
  const mcp = session(t, dir, { waitMs: 2500 });
  await mcp.open();
  const r = await mcp.tool('ragx_documents', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /did not start it/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'notifications.json'), 'utf8')).items[0].status, 'expired');
});

test('search names the figure beside a passage, and ragx_figure hands the agent the image', async (t) => {
  const { makePdf, barChartPage } = await import('./fixtures.js');
  const dir = tempDir();
  const s = await engine(t, dir);
  const f = path.join(dir, 'costs.pdf');
  fs.writeFileSync(f, makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]]));
  await s.engine.ingest(f);
  const [fig] = s.engine.store.docFigures(1);

  const mcp = session(t, dir);
  await mcp.open();
  const found = await mcp.tool('ragx_search', { query: 'costs by region in 2024' });
  const text = found.content[0].text;
  assert.match(text, new RegExp(`Figure beside it: figure ${fig.id} - Figure 1 - Costs by region in 2024\.`));
  assert.match(text, /ragx_figure shows a figure/);

  const r = await mcp.tool('ragx_figure', { id: fig.id });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^costs\.pdf, p\.1 - [^\n]+\(figure \d+\)\nCaption: Figure 1 - Costs by region in 2024\./);
  assert.match(r.content[0].text, /not instructions/);
  assert.equal(r.content[1].type, 'image');
  assert.equal(r.content[1].mimeType, 'image/png');
  assert.equal(Buffer.from(r.content[1].data, 'base64').readUInt32BE(0), 0x89504e47);
  assert.deepEqual(s.tracker.calls({ kind: 'figure' }).map((c) => c.source), ['agent']);
  const missing = await mcp.tool('ragx_figure', { id: 999999 });
  assert.equal(missing.isError, true);
});
