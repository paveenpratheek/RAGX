/* Reading one image with Gemini, through Antigravity's CLI (agy), on the
 * user's Google login - the reader beside Claude (t-773bfd9026).
 *
 * Run as NoteX's engine/lib/gemini.js runs its Gemini calls (t-23220d9414):
 * - in a home folder of RAGX's own, <data>/gemini-home, so the user's Google
 *   login still works but none of their Antigravity MCP servers, skills or
 *   settings load (with them, a one-word answer waited ~90 s);
 * - in a fresh, empty work folder per image, removed afterwards, holding only
 *   the image as image-1.png, with access outside it off and writing,
 *   commands, URLs and MCP denied by agy's own permission rules;
 * - the image as a file the prompt names for view_file, since agy's
 *   stream-json input takes text only (t-50ef522e1f);
 * - API keys taken out of the environment, and the whole process tree ended
 *   after the time-out.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { AgentError, findExecutable, cleanEnv } from './runner.js';

/* The Gemini models offered for reading, as `agy models` names them - the ones NoteX offers too. */
export const GEMINI_MODELS = ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'];
export const isGemini = (model) => /^gemini-/i.test(String(model || ''));

const KNOWN = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin')] : [];
const DENY = ['write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
const SETTINGS = JSON.stringify({ allowNonWorkspaceAccess: false, permissions: { deny: DENY } });
const RULES = 'Answer in your reply only. Do not run commands, list folders, write or change files, or fetch web pages: none of that is allowed here, and trying ends your turn with no answer.';
const IMAGE = 'image-1.png';

/* A folder of RAGX's own, never inside a git repository, where hooks would record what Gemini read. */
function ownFolder(dataDir, name) {
  const dir = path.join(dataDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) throw new AgentError('unsafe-folder', `RAGX's folder ${dir} is inside the git repository at ${d}; keep RAGX's data outside any repository to read with Gemini.`);
    if (path.dirname(d) === d) return dir;
  }
}

function classify(message) {
  if (/not authenticated|log(ged)? ?in|sign(ed)? ?in|auth|credential/i.test(message)) return new AgentError('not-logged-in', `Antigravity is not signed in - open Antigravity, or run "agy" once in a terminal, and sign in. (${message})`);
  if (/limit|quota|rate|exhausted|overloaded|credits|capacity|503|429/i.test(message)) return new AgentError('limit', `Gemini is at a usage limit: ${message}`);
  if (/unknown model|model .*not (found|available)|invalid model/i.test(message)) return new AgentError('failed', `Antigravity does not offer that model now ("agy models" lists what it has): ${message}`);
  return new AgentError('failed', `Gemini did not read the image: ${message}`);
}

const killTree = (pid) => {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gone */ } }
};

/* What the model is told: the reader's instructions, the rules, the file to open, the ask. */
export function geminiReadInput({ system, prompt }) {
  const text = [system, '', RULES, '', `The image is the file ${IMAGE} in your current folder. Open it with view_file by that exact name - it is all there is, so do not list the folder - and look at it before you answer.`, '', prompt].join('\n');
  return JSON.stringify({ event: 'user', message: { role: 'user', content: text } }) + '\n';
}

/* The result event of agy's stream-json output. */
export function geminiResult(out) {
  const lines = String(out).trim().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e && e.event === 'result' && e.result) return e.result;
    } catch (_) { /* not JSON */ }
  }
  return null;
}

/* One image, one answer: { text, model, ms }. */
export function readWithGemini({ png, system, prompt, model = GEMINI_MODELS[0], dataDir, executable = null, prefixArgs = [], timeoutMs = 120_000, signal }) {
  const exe = executable || findExecutable('agy', { known: KNOWN });
  const home = ownFolder(dataDir, 'gemini-home');
  const work = path.join(ownFolder(dataDir, 'gemini-runs'), crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, IMAGE), png);
  const env = { ...cleanEnv(), USERPROFILE: home, HOME: home };
  const args = [...prefixArgs, '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--settings', SETTINGS, '-p', ''];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let out = '', err = '', done = false;
    const end = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* held a moment longer; gemini-runs is cleared next time */ }
      fn(v);
    };
    const onAbort = () => { killTree(child.pid); end(reject, new AgentError('cancelled', 'The reading was cancelled.')); };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort); }
    const timer = setTimeout(() => { killTree(child.pid); end(reject, new AgentError('timeout', `Gemini did not read the image within ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => { out += s; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { err = (err + s).slice(-4000); });
    child.stdin.on('error', () => { /* it exited before reading; its exit says why */ });
    child.on('error', (e) => end(reject, new AgentError('not-found', `Could not start ${exe}: ${e.message}`)));
    child.on('close', (code) => {
      const r = geminiResult(out);
      if (!r) return end(reject, classify(err.trim() || `agy exited with code ${code} and no answer`));
      const text = String(r.response || '').trim();
      // A real answer counts even when agy marks the turn an error (t-2d9080653f).
      if (!text) {
        const tried = (r.denied_actions || []).map((a) => a.display_name || a.action).join(', ');
        if (tried) return end(reject, new AgentError('refused', `Gemini tried ${tried} instead of reading the image, which it may not do here.`));
        return end(reject, classify(String((r.error && (r.error.message || r.error)) || r.finished_reason || r.status || 'an empty answer')));
      }
      end(resolve, { text, model, ms: Date.now() - started });
    });
    child.stdin.end(geminiReadInput({ system, prompt }));
  });
}
