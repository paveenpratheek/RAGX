/* Claude Code, headless, on the user's subscription.
 *
 * The flags are the set phase 0 proved (t-2823b9405e): --safe-mode turns off
 * CLAUDE.md, skills, plugins, hooks and MCP servers but keeps the login,
 * which --bare would not (t-27612a758b); --tools "" leaves the agent nothing
 * to call; --include-partial-messages streams the answer token by token.
 * A follow-up question resumes the conversation's session by id rather than
 * resending the history (t-13d777c126). Sonnet unless the setting or the
 * question names another model (t-8316e94d0c).
 */
import { runAgent, findExecutable, AgentError } from './runner.js';

export const id = 'claude';
export const DEFAULT_MODEL = 'sonnet';

export function args({ model, system, resume }) {
  const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--safe-mode', '--tools', '', '--strict-mcp-config'];
  if (model) a.push('--model', model);
  if (system) a.push('--append-system-prompt', system);
  if (resume) a.push('--resume', resume);
  return a;
}

export function input(prompt) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n';
}

function classify(message) {
  if (/log ?in|auth|credential|api key/i.test(message)) {
    return new AgentError('not-logged-in', `Claude Code is not logged in - run "claude" once in a terminal and log in. (${message})`);
  }
  if (/limit|rate|overloaded|quota/i.test(message)) return new AgentError('limit', `Claude is at a usage limit: ${message}`);
  return new AgentError('failed', `Claude did not answer: ${message}`);
}

export async function ask({ prompt, system, model = DEFAULT_MODEL, resume = null, cwd, executable = null,
  prefixArgs = [], onDelta = () => {}, signal, timeoutMs = 180_000 /* t-293b4573a1 */ }) {
  const exe = executable || findExecutable('claude');
  const state = { init: null, result: null, streamed: false };
  const started = Date.now();
  const { code, stderr } = await runAgent({
    executable: exe,
    args: [...prefixArgs, ...args({ model, system, resume })],
    input: input(prompt),
    cwd,
    timeoutMs,
    signal,
    onEvent(e) {
      if (e.type === 'system' && e.subtype === 'init') state.init = e;
      else if (e.type === 'stream_event') {
        const d = e.event && e.event.delta;
        if (d && d.type === 'text_delta' && d.text) { state.streamed = true; onDelta(d.text); }
      } else if (e.type === 'result') state.result = e;
    },
  });
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
