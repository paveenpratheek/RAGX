/* Ollama, started and stopped with the engine (t-b2ed74b05c).
 *
 * When the engine starts and nothing answers on Ollama's address, it starts
 * `ollama serve` itself and owns it: stopping the engine unloads the model
 * and ends that Ollama with its runners, freeing the GPU. When Ollama was
 * already running - the tray app, or for other models - it is the user's, and
 * stopping the engine only unloads the engine's embedding model, leaving that
 * Ollama running (t-d9e10986c9).
 *
 * Unloading is POST /api/embed with keep_alive 0, sent only when /api/ps
 * shows the model loaded: sent for a model that is not loaded, Ollama loads
 * it first - 13-14 s on this laptop - just to unload it (t-f10f16e340).
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findExecutable, killTree } from './agents/runner.js';

const KNOWN = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama')] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class OllamaControl {
  constructor({ host = 'http://127.0.0.1:11434', executable = null, prefixArgs = [], tracker = null,
    fetch: fetchImpl = globalThis.fetch, startTimeoutMs = 30_000 } = {}) {
    Object.assign(this, { host, executable, prefixArgs, tracker, fetchImpl, startTimeoutMs });
    this.child = null;   // set when this engine started Ollama
    this.stderr = '';
  }

  get owned() { return Boolean(this.child); }
  get pid() { return this.child ? this.child.pid : null; }

  async up() {
    try {
      const r = await this.fetchImpl(this.host + '/api/version', { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch (_) { return false; }
  }

  /* Running already: leave it be. Not running: start it and wait for it. */
  async ensure() {
    if (await this.up()) return { owned: false };
    await this.start();
    return { owned: true, pid: this.pid };
  }

  async start() {
    const exe = this.executable || findExecutable('ollama', { known: KNOWN });
    const u = new URL(this.host);
    const child = spawn(exe, [...this.prefixArgs, 'serve'], {
      env: { ...process.env, OLLAMA_HOST: `${u.hostname}:${u.port || 11434}` },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    // Ollama logs freely to stderr; read it all, keep the tail, so a full
    // pipe never stalls it.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { this.stderr = (this.stderr + s).slice(-4000); });
    let exited = null;
    child.on('exit', (code) => { exited = code ?? 'signal'; if (this.child === child) this.child = null; if (this.tracker) this.tracker.remove(child.pid); });
    child.on('error', (e) => { exited = e.message; });
    this.child = child;
    if (this.tracker && child.pid) this.tracker.add(child.pid, exe);

    const until = Date.now() + this.startTimeoutMs;
    while (Date.now() < until) {
      if (exited !== null) {
        this.child = null;
        throw new Error(`Ollama exited while starting (${exited}): ${this.stderr.trim().split('\n').slice(-3).join(' | ') || 'no output'}`);
      }
      if (await this.up()) return;
      await sleep(300);
    }
    killTree(child.pid);
    this.child = null;
    throw new Error(`Ollama did not answer on ${this.host} within ${this.startTimeoutMs / 1000} s.`);
  }

  async loaded(model) {
    try {
      const r = await this.fetchImpl(this.host + '/api/ps', { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return false;
      const { models = [] } = await r.json();
      const want = model.includes(':') ? model : `${model}:latest`;
      return models.some((m) => m.name === want || m.model === want || m.name === model);
    } catch (_) { return false; }
  }

  async unload(model) {
    if (!(await this.loaded(model))) return false;
    await this.fetchImpl(this.host + '/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: [], keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return true;
  }

  /* Returns what was done, for the engine's log. */
  async stop(model) {
    let unloaded = false;
    try { unloaded = await this.unload(model); } catch (_) { /* Ollama may be gone already */ }
    if (!this.child) return { unloaded, stopped: false };
    const child = this.child;
    this.child = null;
    killTree(child.pid);
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);
    return { unloaded, stopped: true };
  }
}
