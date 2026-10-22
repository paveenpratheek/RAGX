import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgySession } from '../engine/lib/agents/agy.js';
import { AgentPool } from '../engine/lib/agents/pool.js';
import { agentFolder } from '../engine/lib/agents/runner.js';
import { Engine } from '../engine/lib/engine.js';
import { Embedder } from '../engine/lib/embed.js';
import { ask } from '../engine/lib/answer.js';
import { fakeOllama } from './ollama-fake.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

function makePool(t, behaviour = 'echo', opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-pool-'));
  const cwd = agentFolder(dir);
  const opened = [];
  const pool = new AgentPool({
    open: ({ resume, model }) => {
      const s = new AgySession({ executable: process.execPath, prefixArgs: [FAKE, 'agy', behaviour], resume, model, cwd });
      opened.push(s);
      return s;
    },
    ...opts,
  });
  t.after(async () => { await pool.closeAll(); opened.forEach((s) => s.kill()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { pool, opened };
}

const q = (session, prompt = 'Question?', extra = {}) => session.ask({ prompt, system: 'Rules.', timeoutMs: 10_000, ...extra });

test('two questions in one conversation are answered by the same process', async (t) => {
  const { pool } = makePool(t);
  const s1 = await pool.session(null);
  const a = JSON.parse((await q(s1)).text);
  pool.adopt(7, s1);
  const s2 = await pool.session(7);
  const b = JSON.parse((await q(s2)).text);
  assert.equal(s1, s2);
  assert.equal(a.pid, b.pid);
  assert.deepEqual([a.turn, b.turn], [1, 2]);
});

test('a second question while the first is still being answered is refused', async (t) => {
  const { pool } = makePool(t, 'slow');
  const s = await pool.session(null);
  pool.adopt(1, s);
  const first = q(s);
  await assert.rejects(pool.session(1), (e) => e.code === 'busy');
  await first;
});

test('at most two are open: a third closes the one idle longest, and is refused if both are answering', async (t) => {
  const { pool } = makePool(t, 'slow');
  const a = await pool.session(null); pool.adopt(1, a); await q(a);
  const b = await pool.session(null); pool.adopt(2, b); await q(b);
  const c = await pool.session(null); pool.adopt(3, c);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(a.alive, false, 'the oldest idle session was closed');
  assert.equal(b.alive, true);
  const busyB = q(b); const busyC = q(c);
  await assert.rejects(pool.session(null), (e) => e.code === 'pool-full');
  await Promise.all([busyB, busyC]);
});

test('a session idle past the limit is closed by the sweep', async (t) => {
  const { pool } = makePool(t, 'echo', { idleMs: 1000 });
  const s = await pool.session(null); pool.adopt(1, s); await q(s);
  await pool.sweep(Date.now() + 500);
  assert.equal(s.alive, true);
  await pool.sweep(Date.now() + 2000);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.alive, false);
  assert.equal(pool.list().length, 0);
});

test('a warm spare serves the next new conversation with the same model, and only that', async (t) => {
  const { pool, opened } = makePool(t);
  const spare = pool.warm();
  assert.ok(pool.hasSpare());
  assert.equal(pool.list()[0].spare, true);
  assert.equal(await pool.session(5, { resume: 'conv-5' }), opened[1], 'a resumed conversation cannot use the spare');
  assert.ok(spare.alive);
  pool.discard(5, opened[1]);
  assert.equal(await pool.session(null, { model: 'other' }), opened[2], 'nor can another model');
  pool.discard(null, opened[2]);
  assert.equal(await pool.session(null), spare);
  assert.equal(pool.hasSpare(), false);
});

test('when room is needed the spare is closed before any conversation', async (t) => {
  const { pool } = makePool(t);
  const a = await pool.session(null); pool.adopt(1, a); await q(a);
  const spare = pool.warm();
  await pool.session(2, { resume: 'conv-2' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(spare.alive, false);
  assert.equal(a.alive, true, 'the conversation idle longer than the spare stayed open');
});

test('a spare is never started by closing a conversation in use', async (t) => {
  const { pool } = makePool(t);
  const a = await pool.session(null); pool.adopt(1, a);
  const b = await pool.session(null); pool.adopt(2, b);
  assert.equal(pool.warm(), null);
  assert.ok(a.alive && b.alive);
});

test('a session that times out is ended and dropped; the next question resumes the conversation fresh', async (t) => {
  const hang = makePool(t, 'hang');
  const s = await hang.pool.session(null); hang.pool.adopt(4, s);
  await assert.rejects(q(s, 'Q', { timeoutMs: 800 }), (e) => e.code === 'timeout');
  hang.pool.discard(4, s);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.alive, false);

  const { pool } = makePool(t);
  const fresh = await pool.session(4, { resume: 'conv-4' });
  const seen = JSON.parse((await q(fresh)).text);
  assert.equal(seen.flags[seen.flags.indexOf('--conversation') + 1], 'conv-4');
});

test('closeAll ends every open process', async (t) => {
  const { pool } = makePool(t);
  const a = await pool.session(null); pool.adopt(1, a);
  pool.warm();
  await pool.closeAll();
  assert.equal(a.alive, false);
});

test('ask through the pool answers a follow-up from the process that answered the first question', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-pool-ask-'));
  const ollama = fakeOllama();
  const engine = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: ollama.fetch, retries: 0 }) });
  const pool = new AgentPool({ open: ({ resume, model }) => new AgySession({ executable: process.execPath, prefixArgs: [FAKE, 'agy', 'echo'], resume, model, cwd: agentFolder(engine.dir) }) });
  t.after(async () => { await pool.closeAll(); engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const f = path.join(root, 'lease.md');
  fs.writeFileSync(f, '# Lease\n\nRent of 1,200 is due on the first of each month.\n\n## Fees\n\nA late fee of 50 applies.\n');
  await engine.ingest(f);
  const seen = [];
  const first = await ask(engine, { question: 'When is rent due?', agent: 'agy', pool, onSources: (s) => seen.push(s) });
  const second = await ask(engine, { question: 'Any late fee?', conversationId: first.conversationId, agent: 'agy', pool });
  const [a, b] = [JSON.parse(first.answer), JSON.parse(second.answer)];
  assert.equal(a.pid, b.pid);
  assert.equal(b.turn, 2);
  assert.ok(seen[0].sources.length > 0 && seen[0].fresh[0] === 1, 'sources were announced before the answer');
});
