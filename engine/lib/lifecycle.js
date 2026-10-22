/* What the engine leaves on disk while it serves, and cleans up after.
 *
 *   <data>/engine.lock     one engine per data folder: two would each hold
 *                          their own vector index over one database
 *   <data>/agents.json     the agent processes this engine started, so ones a
 *                          hard kill left running are ended on the next start
 *   plugin/runtime.json    where the plugin finds the engine and its token
 *                          (git-ignored; served by ter-manager to the plugin)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { killTree } from './agents/runner.js';

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/* The image name of a running pid, or null - to check a recorded pid still
 * belongs to the program that was recorded, before ending it (ter-manager's
 * rule: re-check the pid; never end a process by a stale number). */
export function imageOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const m = /^"([^"]+)","(\d+)"/m.exec(r.stdout || '');
    return m && Number(m[2]) === pid ? m[1].toLowerCase() : null;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  const name = (r.stdout || '').trim();
  return name ? path.basename(name).toLowerCase() : null;
}

export class LockError extends Error {
  constructor(message, held) { super(message); this.name = 'LockError'; this.code = 'locked'; this.held = held; }
}

/* The lock names the holding process and a random id for this engine, so a
 * second engine is refused even inside the same process. A lock whose pid is
 * no longer running is stale and taken over (t-0264c2c3a0). Call again with
 * the same instance to update what it says. */
export function takeLock(dataDir, info, instance) {
  const file = path.join(dataDir, 'engine.lock');
  let held = null;
  try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* none, or unreadable: take it */ }
  if (held && held.instance !== instance && alive(held.pid)) {
    throw new LockError(`An engine is already serving ${dataDir} (pid ${held.pid}${held.url ? ', ' + held.url : ''}).`, held);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, instance, ...info }, null, 2));
  return () => {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now.instance === instance) fs.rmSync(file, { force: true });
    } catch (_) { /* gone already */ }
  };
}

/* The record of running agents, rewritten as they come and go. */
export function agentRecord(dataDir) {
  const file = path.join(dataDir, 'agents.json');
  const pids = new Map();
  const save = () => {
    try { fs.writeFileSync(file, JSON.stringify(Object.fromEntries(pids), null, 2)); } catch (_) { /* best effort */ }
  };
  return {
    file,
    add(pid, executable) { pids.set(String(pid), path.basename(executable).toLowerCase()); save(); },
    remove(pid) { if (pids.delete(String(pid))) save(); },
    clear() { pids.clear(); try { fs.rmSync(file, { force: true }); } catch (_) {} },
  };
}

/* Ends what an earlier engine, killed hard, left running - each pid only if
 * it is alive and still the program that was recorded (t-56e72cf475). */
export function endOrphans(dataDir) {
  const file = path.join(dataDir, 'agents.json');
  let recorded = {};
  try { recorded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return []; }
  const ended = [];
  for (const [p, image] of Object.entries(recorded)) {
    const pid = Number(p);
    if (alive(pid) && imageOf(pid) === image) { killTree(pid); ended.push({ pid, image }); }
  }
  fs.rmSync(file, { force: true });
  return ended;
}

/* plugin/local.json: where this copy of the engine lives on disk. A page
 * served at /plugins/rag/ cannot learn its own folder, and the plugin needs
 * it to start the engine; asking ter-manager's own /api/plugins would reach
 * past the host's message contract (t-91c800f187). Written by plugin-setup
 * and on every serve, so a moved repository corrects itself the next time it
 * runs. */
// fileURLToPath, not URL.pathname, which keeps %20 for spaces (t-d9c830f1ad).
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function writeLocal(file) {
  const info = { repo: REPO, cli: path.join(REPO, 'engine', 'cli.js'), node: process.execPath, writtenAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return info;
}

export function writeRuntime(file, info) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return () => {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now.pid === info.pid) fs.rmSync(file, { force: true });
    } catch (_) { /* gone already */ }
  };
}
