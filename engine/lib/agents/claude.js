/* Claude Code, headless, on the user's subscription.
 *
 * The flags are the set phase 0 proved (t-2823b9405e): --safe-mode turns off
 * CLAUDE.md, skills, plugins, hooks and MCP servers but keeps the login,
 * which --bare would not (t-27612a758b); --tools "" leaves the agent nothing
 * to call; --include-partial-messages streams the answer token by token.
 * A follow-up question resumes the conversation's session by id rather than
 * resending the history (t-13d777c126). Sonnet unless the setting or the
 * question names another model (t-8316e94d0c). A run that will never be
 * resumed - reading an image - keeps no session in the user's Claude history
 * (t-7ab84e8281).
 */
import { startAgent, awaitAgent, findExecutable, AgentError } from './runner.js';

export const id = 'claude';
export const DEFAULT_MODEL = 'sonnet';

export function args({ model, system, resume, persist = true }) {
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--safe-mode', '--tools', '', '--strict-mcp-config'];
  if (model) a.push('--model', model);
  if (system) a.push('--append-system-prompt', system);
  if (resume) a.push('--resume', resume);
  if (!persist) a.push('--no-session-persistence');
  return a;
}

/* images: [{ label, png }] - each figure goes before the text it is named in,
 * as an image block after a line saying which source it is. Claude in this
 * locked-down mode takes them: step 0 had it read $5.03 off a bar chart
 * (t-a88b94fd27, t-e0ef9c734c). */
export function input(prompt, images = []) {
  const content = [];
  for (const im of images) {
    content.push({ type: 'text', text: im.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(im.png).toString('base64') } });
  }
  content.push({ type: 'text', text: prompt });
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function classify(message) {
  if (/log ?in|auth|credential|api key/i.test(message)) {
    return new AgentError('not-logged-in', `Claude Code is not logged in - run "claude" once in a terminal and log in. (${message})`);
  }
  if (/limit|rate|overloaded|quota/i.test(message)) return new AgentError('limit', `Claude is at a usage limit: ${message}`);
  return new AgentError('failed', `Claude did not answer: ${message}`);
}

/* A Claude Code process started and waiting for its one input, so its
 * start-up is done before the question or image arrives - a spare reader
 * started ahead (t-df9b7a8cf6). It answers one input and exits: nothing of
 * one run reaches the next (t-2bc75de11d). */
export function start({ system, model = DEFAULT_MODEL, resume = null, persist = true, cwd, executable = null, prefixArgs = [] }) {
  const exe = executable || findExecutable('claude');
  const state = { init: null, result: null, streamed: false, onDelta: () => {}, thrown: null };
  const agent = startAgent({
    executable: exe,
    args: [...prefixArgs, ...args({ model, system, resume, persist })],
    cwd,
    onEvent(e) {
      if (state.thrown) return;
      try {
        if (e.type === 'system' && e.subtype === 'init') state.init = e;
        else if (e.type === 'stream_event') {
          const d = e.event && e.event.delta;
          if (d && d.type === 'text_delta' && d.text) { state.streamed = true; state.onDelta(d.text); }
        } else if (e.type === 'result') state.result = e;
      } catch (err) { state.thrown = err; agent.kill(); }
    },
  });
  return { agent, state, model };
}

/* Gives a started process its one input and waits for its answer. */
export async function finish(run, { prompt, images = [], onDelta = () => {}, signal, timeoutMs = 180_000 /* t-293b4573a1 */ }) {
  const { agent, state, model } = run;
  state.onDelta = onDelta;
  const started = Date.now();
  agent.write(input(prompt, images));
  agent.end();
  const { code, stderr } = await awaitAgent(agent, agent.closed, { timeoutMs, signal });
  if (agent.failed) throw agent.failed;
  if (state.thrown) throw state.thrown;
  const r = state.result;
  if (!r) throw classify(stderr || `claude exited with code ${code} and no result`);
  if (r.is_error || (r.subtype && r.subtype !== 'success')) throw classify(String(r.result || r.subtype));
  const text = String(r.result || '');
  if (!state.streamed && text) onDelta(text);
  return {
    agent: id,
    text,
    session: r.session_id || (state.init && state.init.session_id) || null,
    model: state.init ? state.init.model : model,
    isolation: state.init ? { tools: state.init.tools, mcpServers: state.init.mcp_servers, apiKeySource: state.init.apiKeySource } : null,
    cost: r.total_cost_usd ?? null,
    ms: Date.now() - started,
  };
}

export async function ask(opts) { return finish(start(opts), opts); }
