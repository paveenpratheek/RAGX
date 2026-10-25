/* Running an agent CLI headless: what both adapters share.
 *
 * The agent never reaches the RAG; the engine puts the passages in its
 * prompt (t-f57de7dbb8), so the agent needs nothing but a prompt in and text
 * out. Everything here keeps it that way and keeps it on the user's own
 * subscription (t-a08e5f354e):
 *
 * - API keys are taken out of its environment. With ANTHROPIC_API_KEY set,
 *   Claude Code bills the API instead of the login, and agy would do the
 *   same with GEMINI_API_KEY, which is set on this machine (t-aa63527044).
 * - It runs in the engine's own empty folder, which must not sit inside a
 *   git repository: GitX's global agy hook records answers given in one
 *   (t-206ab24911).
 * - The prompt goes on stdin; the Windows command line stops at 32,767
 *   characters and eight passages can pass that.
 * - It is started without a shell, so nothing in a prompt or a path is ever
 *   read as a command.
 * - A time-out or a cancel ends the whole process tree, not just the parent
 *   (t-bb20babed3).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentError';
    this.code = code; // not-found | not-logged-in | limit | refused | timeout | cancelled | unsafe-folder | failed
  }
}

export const SCRUBBED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) if (SCRUBBED.includes(key.toUpperCase())) delete out[key];
  return out;
}

/* An executable by name: the setting if one is given, then PATH, then the
 * places its installer is known to use. */
export function findExecutable(name, { override = null, known = [] } = {}) {
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new AgentError('not-found', `${name} is not at ${override}, where the setting points.`);
  }
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...dirs, ...known]) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch (_) { /* not here */ }
    }
  }
  throw new AgentError('not-found', `${name} was not found on PATH${known.length ? ' or in ' + known.join(', ') : ''}.`);
}

/* The agents' folder, made if missing, refused if a .git sits at or above it. */
export function agentFolder(dataDir) {
  const dir = path.join(dataDir, 'agent');
  fs.mkdirSync(dir, { recursive: true });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) {
      throw new AgentError('unsafe-folder', `The agents' folder ${dir} is inside the git repository at ${d}; GitX would record its answers. Use a data folder outside any repository.`);
    }
    if (path.dirname(d) === d) return dir;
  }
}

export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* already gone */ } }
}

/* Every agent process started, so the engine can write them down and, after
 * a hard kill of its own, end the ones left behind on its next start. */
let tracker = { add() {}, remove() {} };
export function setTracker(t) { tracker = t; }

/* A running agent: write lines to its stdin, get each JSON line of its stdout
 * as an event. `closed` resolves with the exit code and the tail of stderr,
 * whatever ends it; `failed` is set if it could not start at all. One-shot
 * runs are this with stdin closed after one write (t-1fe9772761). */
export function startAgent({ executable, args, cwd, onEvent }) {
  const child = spawn(executable, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const agent = {
    child,
    pid: child.pid,
    exited: false,
    failed: null,
    write(line) { if (!agent.exited) child.stdin.write(line); },
    end() { if (!agent.exited) child.stdin.end(); },
    kill() { if (!agent.exited) killTree(child.pid); },
  };
  if (child.pid) tracker.add(child.pid, executable);

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    buf += s;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; }
      onEvent(event);
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-4000); });
  child.stdin.on('error', () => { /* the agent exited before reading - its exit says why */ });

  agent.closed = new Promise((resolve) => {
    child.on('error', (e) => { agent.failed = new AgentError('not-found', `Could not start ${executable}: ${e.message}`); });
    child.on('close', (code) => {
      agent.exited = true;
      if (child.pid) tracker.remove(child.pid);
      resolve({ code, stderr: stderr.trim() });
    });
  });
  return agent;
}

/* Waits for something an agent will do, or ends it: after timeoutMs, on
 * cancel, or when it exits first. A time-out or cancel ends the whole
 * process tree (t-bb20babed3). */
export function awaitAgent(agent, promise, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(v); };
    const timer = setTimeout(() => {
      agent.kill();
      finish(reject, new AgentError('timeout', `The agent did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    const onAbort = () => { agent.kill(); finish(reject, new AgentError('cancelled', 'Cancelled.')); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}
