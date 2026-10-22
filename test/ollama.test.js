import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OllamaControl } from '../engine/lib/ollama.js';
import { alive } from '../engine/lib/lifecycle.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-ollama.mjs');

async function freePort() {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const calls = async (host) => (await fetch(host + '/calls')).json();
const unloads = async (host) => (await calls(host)).filter((c) => c.body && c.body.keep_alive === 0).length;

function control(host, extra = {}) {
  const tracked = new Map();
  const tracker = { add: (pid, exe) => tracked.set(pid, exe), remove: (pid) => tracked.delete(pid) };
  return { ctl: new OllamaControl({ host, executable: process.execPath, prefixArgs: [FAKE], tracker, startTimeoutMs: 8000, ...extra }), tracked };
}

test('with nothing running, the engine starts Ollama, owns it, and stopping ends it', async () => {
  const host = `http://127.0.0.1:${await freePort()}`;
  const { ctl, tracked } = control(host);
  const r = await ctl.ensure();
  assert.equal(r.owned, true);
  assert.ok(await ctl.up());
  assert.ok(tracked.has(r.pid), 'recorded, so a hard kill leaves nothing behind for long');
  await fetch(host + '/api/embed', { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text-v2-moe', input: 'x' }) });
  const done = await ctl.stop('nomic-embed-text-v2-moe');
  assert.deepEqual(done, { unloaded: true, stopped: true });
  assert.equal(await ctl.up(), false);
  assert.equal(alive(r.pid), false);
});

test("an Ollama that was already running is the user's: stopping only unloads the model", async (t) => {
  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  const theirs = spawn(process.execPath, [FAKE, 'serve'], { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` }, stdio: 'ignore' });
  t.after(() => theirs.kill());
  const { ctl } = control(host);
  for (let i = 0; i < 40 && !(await ctl.up()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await ctl.ensure(), { owned: false });
  await fetch(host + '/api/embed', { method: 'POST', body: JSON.stringify({ model: 'nomic-embed-text-v2-moe', input: 'x' }) });
  assert.deepEqual(await ctl.stop('nomic-embed-text-v2-moe'), { unloaded: true, stopped: false });
  assert.ok(await ctl.up(), 'their Ollama is still running');
  assert.equal(await ctl.loaded('nomic-embed-text-v2-moe'), false, 'but the model is out of memory');
});

test('no unload is sent for a model that is not loaded, since that would load it first', async (t) => {
  const port = await freePort();
  const host = `http://127.0.0.1:${port}`;
  const theirs = spawn(process.execPath, [FAKE, 'serve'], { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` }, stdio: 'ignore' });
  t.after(() => theirs.kill());
  const { ctl } = control(host);
  for (let i = 0; i < 40 && !(await ctl.up()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(await ctl.stop('nomic-embed-text-v2-moe'), { unloaded: false, stopped: false });
  assert.equal(await unloads(host), 0);
});

test('an Ollama that fails to start is reported with its own words', async () => {
  const host = `http://127.0.0.1:${await freePort()}`;
  const { ctl } = control(host, { prefixArgs: [FAKE, 'fail'] });
  await assert.rejects(ctl.ensure(), /exited while starting.*address already in use/);
  assert.equal(ctl.owned, false);
});
