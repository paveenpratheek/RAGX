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
import { runAgent, findExecutable, AgentError } from './runner.js';

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

async function turn({ exe, prefixArgs, model, resume, text, cwd, onDelta, signal, timeoutMs }) {
  const state = { conversation: null, result: null, tools: [] };
  const { code, stderr } = await runAgent({
    executable: exe,
    args: [...prefixArgs, ...args({ model, resume })],
    input: input(text),
    cwd,
    timeoutMs,
    signal,
    onEvent(e) {
      if (e.event === 'init') state.conversation = e.conversation_id || null;
      else if (e.event === 'step_update' && e.step_update) {
        const s = e.step_update;
        if (s.step_type === 'agent_response' && s.text_delta) onDelta(s.text_delta);
        else if (s.step_type === 'tool') state.tools.push(s.tool_name || (s.tool_info && s.tool_info.name));
      } else if (e.event === 'result') state.result = e.result || null;
    },
  });
  if (!state.result) throw classify(stderr || `agy exited with code ${code} and no result`);
  return { ...state, stderr };
}

export async function ask({ prompt, system, model = DEFAULT_MODEL, resume = null, cwd, executable = null,
  prefixArgs = [], onDelta = () => {}, signal, timeoutMs = 300_000 /* t-293b4573a1 */ }) {
  const exe = executable || findExecutable('agy', { known: KNOWN });
  const started = Date.now();
  const message = (extra) => [system, extra, prompt].filter(Boolean).join('\n\n');
  let t = await turn({ exe, prefixArgs, model, resume, text: message(), cwd, onDelta, signal, timeoutMs });
  let refusedOnce = false;
  const denied = (r) => !String(r.response || '').trim() && Array.isArray(r.denied_actions) && r.denied_actions.length;
  if (denied(t.result)) {
    refusedOnce = true;
    t = await turn({ exe, prefixArgs, model, resume: t.result.conversation_id || t.conversation || resume,
      text: message(TEXT_ONLY), cwd, onDelta, signal, timeoutMs });
  }
  const r = t.result;
  const text = String(r.response || '').trim();
  if (!text) {
    if (denied(r)) throw new AgentError('refused', `agy tried to use ${r.denied_actions.map((a) => a.display_name || a.action).join(', ')} instead of answering, twice.`);
    throw classify(String(r.error && (r.error.message || r.error) || r.status || 'an empty response'));
  }
  return {
    agent: id,
    text,
    session: r.conversation_id || t.conversation || null,
    model: model || null,
    warning: r.status && r.status !== 'SUCCESS' ? `agy reported ${r.status}${r.error ? ': ' + (r.error.message || r.error) : ''}, but answered.` : null,
    refusedOnce,
    toolsTried: t.tools.filter(Boolean),
    ms: Date.now() - started,
  };
}
