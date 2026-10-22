/* Antigravity's CLI (agy), headless, on the user's Google login.
 *
 * Its stream-json protocol, as phase 0 found it (t-9c42adf0c8): one stdin line
 * per turn shaped {"event":"user","message":{...}}, and output events that
 * nest their fields under step_update and result. There is no system-prompt
 * flag, so the rules lead the message, and no flag that turns its tools off:
 * a tool it reaches for headless is denied, and the turn comes back SUCCESS
 * with an empty response and denied_actions - a refusal, not an answer. That
 * is retried once with the instruction to answer in text only (t-855f6bbf27).
 *
 * A turn can also come back status ERROR with a real response (a capacity
 * 503 mid-turn); the response is what counts, so it is kept (t-2d9080653f).
 */
import path from 'node:path';
import { startAgent, awaitAgent, findExecutable, AgentError } from './runner.js';

export const id = 'agy';
export const DEFAULT_MODEL = null; // agy's own default

const KNOWN = process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin')] : [];

export function args({ model, resume }) {
  const a = ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p', ''];
  if (model) a.push('--model', model);
  if (resume) a.push('--conversation', resume);
  return a;
}

export function input(text) {
  return JSON.stringify({ event: 'user', message: { role: 'user', content: text } }) + '\n';
}

const TEXT_ONLY = 'Answer in plain text only. You need no tools and must not use any.';

function classify(message) {
  if (/log(ged)? ?in|sign(ed)? ?in|auth|credential/i.test(message)) {
    return new AgentError('not-logged-in', `agy is not logged in - run "agy" once in a terminal and sign in. (${message})`);
  }
  if (/capacity|limit|quota|rate|503|429/i.test(message)) return new AgentError('limit', `agy is at a limit: ${message}`);
  return new AgentError('failed', `agy did not answer: ${message}`);
}

const denied = (r) => !String(r.response || '').trim() && Array.isArray(r.denied_actions) && r.denied_actions.length;

/* One agy process holding one conversation. Turns go in on its open stdin,
 * one at a time: in a process kept open a follow-up took 42 s against 109 s
 * for a fresh one (t-15fc91e57a), which is why the server keeps these open
 * (t-53c25eef6e). A session that times out, is cancelled or exits is dead
 * and is never reused. */
export class AgySession {
  constructor({ executable = null, prefixArgs = [], model = DEFAULT_MODEL, resume = null, cwd }) {
    this.exe = executable || findExecutable('agy', { known: KNOWN });
    this.model = model;
    this.conversation = resume;
    this.busy = false;
    this.lastUsed = Date.now();
    this.pending = null; // the turn waiting for its result
    this.agent = startAgent({
      executable: this.exe,
      args: [...prefixArgs, ...args({ model, resume })],
      cwd,
      onEvent: (e) => this.onEvent(e),
    });
    this.agent.closed.then(({ code, stderr }) => {
      const p = this.pending;
      this.pending = null;
      if (p) p.reject(this.agent.failed || classify(stderr || `agy exited with code ${code} and no result`));
    });
  }

  get alive() { return !this.agent.exited; }
  get pid() { return this.agent.pid; }

  onEvent(e) {
    if (e.event === 'init') { this.conversation = e.conversation_id || this.conversation; return; }
    const p = this.pending;
    if (!p) return;
    if (e.event === 'step_update' && e.step_update) {
      const s = e.step_update;
      if (s.step_type === 'agent_response' && s.text_delta) p.onDelta(s.text_delta);
      else if (s.step_type === 'tool') p.tools.push(s.tool_name || (s.tool_info && s.tool_info.name));
    } else if (e.event === 'result') {
      this.pending = null;
      p.resolve(e.result || {});
    }
  }

  turn(text, { onDelta, signal, timeoutMs }) {
    const tools = [];
    const result = new Promise((resolve, reject) => { this.pending = { resolve, reject, onDelta, tools }; });
    this.agent.write(input(text));
    return awaitAgent(this.agent, result, { timeoutMs, signal }).then((r) => ({ result: r, tools }));
  }

  async ask({ prompt, system, onDelta = () => {}, signal, timeoutMs = 300_000 /* t-293b4573a1 */ }) {
    if (!this.alive) throw new AgentError('failed', 'This agy process has already exited.');
    if (this.busy) throw new AgentError('busy', 'agy is still answering the last question in this conversation.');
    this.busy = true;
    const started = Date.now();
    const message = (extra) => [system, extra, prompt].filter(Boolean).join('\n\n');
    try {
      let t = await this.turn(message(), { onDelta, signal, timeoutMs });
      let refusedOnce = false;
      if (denied(t.result)) {
        refusedOnce = true;
        t = await this.turn(message(TEXT_ONLY), { onDelta, signal, timeoutMs });
      }
      const r = t.result;
      if (r.conversation_id) this.conversation = r.conversation_id;
      const text = String(r.response || '').trim();
      if (!text) {
        if (denied(r)) throw new AgentError('refused', `agy tried to use ${r.denied_actions.map((a) => a.display_name || a.action).join(', ')} instead of answering, twice.`);
        throw classify(String(r.error && (r.error.message || r.error) || r.status || 'an empty response'));
      }
      return {
        agent: id,
        text,
        session: this.conversation,
        model: this.model || null,
        warning: r.status && r.status !== 'SUCCESS' ? `agy reported ${r.status}${r.error ? ': ' + (r.error.message || r.error) : ''}, but answered.` : null,
        refusedOnce,
        toolsTried: t.tools.filter(Boolean),
        ms: Date.now() - started,
      };
    } finally {
      this.busy = false;
      this.lastUsed = Date.now();
    }
  }

  /* Closing stdin lets agy finish and exit on its own; if it has not within
   * a few seconds it is ended. */
  async close(graceMs = 5000) {
    if (!this.alive) return;
    this.agent.end();
    const t = setTimeout(() => this.agent.kill(), graceMs);
    await this.agent.closed;
    clearTimeout(t);
  }

  kill() { this.agent.kill(); }
}

/* One question, one process: the command-line path. */
export async function ask({ prompt, system, model = DEFAULT_MODEL, resume = null, cwd, executable = null,
  prefixArgs = [], onDelta = () => {}, signal, timeoutMs = 300_000 }) {
  const session = new AgySession({ executable, prefixArgs, model, resume, cwd });
  try {
    return await session.ask({ prompt, system, onDelta, signal, timeoutMs });
  } finally {
    await session.close();
  }
}
