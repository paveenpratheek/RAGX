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

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}

/* Starts the agent, writes input to its stdin and closes it, and hands each
 * JSON line of stdout to onEvent. Resolves with the exit code and the tail
 * of stderr; rejects only on time-out, cancel or a failure to start. */
export function runAgent({ executable, args, input, cwd, timeoutMs, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const child = spawn(executable, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });

    const timer = setTimeout(() => {
      killTree(child);
      finish(reject, new AgentError('timeout', `The agent did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    const onAbort = () => {
      killTree(child);
      finish(reject, new AgentError('cancelled', 'Cancelled.'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

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
        try { onEvent(event); } catch (e) { killTree(child); finish(reject, e); }
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-4000); });

    child.on('error', (e) => finish(reject, new AgentError('not-found', `Could not start ${executable}: ${e.message}`)));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      finish(resolve, { code, stderr: stderr.trim() });
    });

    child.stdin.on('error', () => { /* the agent exited before reading - its exit says why */ });
    child.stdin.end(input);
  });
}
