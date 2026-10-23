/* A stand-in for the claude and agy CLIs, speaking each one's stream-json.
 *
 *   node fake-agent.mjs <claude|agy> <behaviour> [the real CLI's flags...]
 *
 * Behaviours: answer, echo (answers with what it was given: flags, cwd,
 * which API keys it can see, the prompt), replay (the real output recorded
 * in phase 0), crash, hang, login, deny-once, deny-always, error-with-answer,
 * cite-unknown (cites a source number that was never given), slow (answers
 * after 0.8 s, to catch a second question arriving mid-answer), read (an
 * image's reading as JSON), read-prose (a reading that is not JSON).
 * npm test spends no subscription because of this (t-fbffe96c78). It is not
 * named *.test.js, so the test runner does not start it (t-8b630a28cc).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [protocol, behaviour, ...flags] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');

/* Like the real CLIs, each stdin line is a turn answered as it arrives, and
 * the process ends when stdin closes - so a session can hold it open for
 * several turns (t-65d057e543). */
let buf = '';
let turnNo = 0;
let hanging = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (s) => {
  buf += s;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) turn(JSON.parse(line));
  }
});
process.stdin.on('end', () => { if (!hanging) process.exit(0); });

function turn(msg) {
  turnNo++;
  // Claude's message is blocks: figures' labels and images first, the prompt last.
  const blocks = protocol === 'claude' ? msg.message.content : [];
  const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
  const prompt = protocol === 'claude' ? texts[texts.length - 1] : msg.message.content;
  const images = blocks.filter((b) => b.type === 'image' && b.source && b.source.media_type === 'image/png' && b.source.data).length;
  const keys = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'].filter((k) => k in process.env);
  const flag = (name) => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : null; };

  if (behaviour === 'replay') {
    process.stdout.write(fs.readFileSync(path.join(here, 'recorded', `${protocol}-stream.jsonl`), 'utf8'));
    return;
  }
  if (behaviour === 'crash') { process.stderr.write('boom: something broke\n'); process.exit(3); }
  if (behaviour === 'hang') { hanging = setInterval(() => {}, 1000); return; }

  let answer = 'The vault code is 7741 [1].';
  if (behaviour === 'echo') answer = JSON.stringify({ flags, cwd: process.cwd(), keys, prompt, images, labels: texts.slice(0, -1), pid: process.pid, turn: turnNo });
  if (behaviour === 'cite-unknown') answer = 'Rent is due monthly [1], and late fees apply [9].';
  // Reading an image: the JSON the reader asks for, saying what it was given.
  if (behaviour === 'read') answer = JSON.stringify({ kind: 'chart', text: 'Arm | Cost\nOpus | $5.03\nHaiku | $0.07', description: `A bar chart of reader cost; ${images} image given; flags ${flags.filter((f) => f.startsWith('--no-')).join(' ')}.` });
  if (behaviour === 'read-prose') answer = 'This looks like a bar chart of costs, with Opus the most expensive.';
  if (behaviour === 'slow') { setTimeout(() => answerWith(answer), 800); return; }
  answerWith(answer);

  function answerWith(answer) {
  if (protocol === 'claude') {
    const session = flag('--resume') || 'sess-1';
    out({ type: 'system', subtype: 'init', session_id: session, tools: [], mcp_servers: [], apiKeySource: 'none', model: flag('--model') || 'default' });
    if (behaviour === 'login') {
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: session });
      return;
    }
    for (const piece of answer.match(/.{1,12}/gs)) out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
    out({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: session, total_cost_usd: 0.001 });
    return;
  }

  // agy
  const conversation = flag('--conversation') || 'conv-1';
  if (turnNo === 1) out({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: ['view_file'] } });
  out({ event: 'step_update', step_update: { step_index: 0, state: 'DONE', step_type: 'user_input' } });
  if (behaviour === 'login') {
    out({ event: 'result', result: { conversation_id: conversation, status: 'ERROR', response: '', error: { message: 'You are not signed in' } } });
    return;
  }
  const textOnly = /plain text only/.test(prompt);
  if (behaviour === 'deny-always' || (behaviour === 'deny-once' && !textOnly)) {
    out({ event: 'step_update', step_update: { step_index: 1, state: 'ERROR', step_type: 'tool', tool_name: 'view_file' } });
    out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '', denied_actions: [{ action: 'view_file', display_name: 'View file' }] } });
    return;
  }
  out({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: answer } });
  const status = behaviour === 'error-with-answer' ? 'ERROR' : 'SUCCESS';
  out({ event: 'result', result: { conversation_id: conversation, status, response: answer, error: status === 'ERROR' ? { message: '503 No capacity' } : null } });
  }
}
