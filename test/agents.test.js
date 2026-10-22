import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as claude from '../engine/lib/agents/claude.js';
import * as agy from '../engine/lib/agents/agy.js';
import { cleanEnv, agentFolder, findExecutable, AgentError } from '../engine/lib/agents/runner.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-agents-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return agentFolder(dir);
}

/* Each adapter, pointed at the stand-in with a behaviour. */
const run = (adapter, behaviour, cwd, opts = {}) => {
  const deltas = [];
  return adapter.ask({
    prompt: 'Sources:\n[1] notes.txt - The vault code is 7741.\n\nQuestion: What is the vault code?',
    system: 'Answer only from the sources.',
    cwd,
    executable: process.execPath,
    prefixArgs: [FAKE, adapter.id, behaviour],
    onDelta: (d) => deltas.push(d),
    timeoutMs: 15_000,
    ...opts,
  }).then((r) => ({ ...r, deltas }));
};

test('API keys are taken out of the agent environment, everything else is kept', () => {
  const env = cleanEnv({ ANTHROPIC_API_KEY: 'x', anthropic_auth_token: 'y', GEMINI_API_KEY: 'z', GOOGLE_API_KEY: 'w', PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'login' });
  assert.deepEqual(env, { PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'login' });
});

test("the agents' folder is refused inside a git repository", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repo, '.git'));
  fs.mkdirSync(path.join(repo, 'data'));
  assert.throws(() => agentFolder(path.join(repo, 'data')), (e) => e.code === 'unsafe-folder' && /GitX/.test(e.message));
});

test('a missing executable is named with where it was looked for', () => {
  assert.throws(() => findExecutable('no-such-agent-cli', { known: ['C:\\nowhere'] }), (e) => e.code === 'not-found' && /nowhere/.test(e.message));
  assert.throws(() => findExecutable('claude', { override: 'C:\\nope\\claude.exe' }), /where the setting points/);
});

test('claude gets the isolating flags, the prompt on stdin, and no API keys', async (t) => {
  const cwd = folder(t);
  process.env.ANTHROPIC_API_KEY = 'must-not-reach-the-agent';
  t.after(() => { delete process.env.ANTHROPIC_API_KEY; });
  const r = await run(claude, 'echo', cwd, { model: 'sonnet' });
  const seen = JSON.parse(r.text);
  for (const f of ['--safe-mode', '--strict-mcp-config', '--include-partial-messages']) assert.ok(seen.flags.includes(f), f);
  assert.equal(seen.flags[seen.flags.indexOf('--tools') + 1], '');
  assert.equal(seen.flags[seen.flags.indexOf('--model') + 1], 'sonnet');
  assert.equal(seen.flags[seen.flags.indexOf('--append-system-prompt') + 1], 'Answer only from the sources.');
  assert.match(seen.prompt, /Question: What is the vault code\?/);
  assert.deepEqual(seen.keys, []);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd));
});

test('claude streams token by token and returns the answer, session and isolation', async (t) => {
  const r = await run(claude, 'answer', folder(t));
  assert.equal(r.text, 'The vault code is 7741 [1].');
  assert.ok(r.deltas.length > 1);
  assert.equal(r.deltas.join(''), r.text);
  assert.equal(r.session, 'sess-1');
  assert.deepEqual(r.isolation, { tools: [], mcpServers: [], apiKeySource: 'none' });
});

test('claude parses the real output recorded in phase 0', async (t) => {
  const r = await run(claude, 'replay', folder(t));
  assert.equal(r.text, 'The vault code is 7741 [1].');
  assert.equal(r.deltas.join(''), r.text);
  assert.equal(r.session, '42d96368-7626-4727-8036-524ccc1af157');
  assert.equal(r.isolation.apiKeySource, 'none');
});

test('claude resumes a session by id', async (t) => {
  const r = await run(claude, 'echo', folder(t), { resume: 'abc-123' });
  assert.equal(r.session, 'abc-123');
  const seen = JSON.parse(r.text);
  assert.equal(seen.flags[seen.flags.indexOf('--resume') + 1], 'abc-123');
});

test('claude not logged in, crashed or hung is reported by name', async (t) => {
  const cwd = folder(t);
  await assert.rejects(run(claude, 'login', cwd), (e) => e instanceof AgentError && e.code === 'not-logged-in' && /run "claude"/.test(e.message));
  await assert.rejects(run(claude, 'crash', cwd), (e) => e.code === 'failed' && /boom/.test(e.message));
  const t0 = Date.now();
  await assert.rejects(run(claude, 'hang', cwd, { timeoutMs: 1500 }), (e) => e.code === 'timeout');
  assert.ok(Date.now() - t0 < 6000, 'the hung agent was ended, not waited out');
});

test('a cancel ends the agent', async (t) => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(run(claude, 'hang', folder(t), { signal: ac.signal }), (e) => e.code === 'cancelled');
});

test('agy gets the rules ahead of the prompt in one stdin message, and no API keys', async (t) => {
  process.env.GEMINI_API_KEY = 'must-not-reach-the-agent';
  t.after(() => { delete process.env.GEMINI_API_KEY; });
  const r = await run(agy, 'echo', folder(t));
  const seen = JSON.parse(r.text);
  assert.deepEqual(seen.flags, ['--input-format', 'stream-json', '--output-format', 'stream-json', '-p', '']);
  assert.match(seen.prompt, /^Answer only from the sources\.\n\nSources:/);
  assert.deepEqual(seen.keys, []);
});

test('agy parses the real output recorded in phase 0', async (t) => {
  const r = await run(agy, 'replay', folder(t));
  assert.equal(r.text, 'The vault code is 7741 [1].');
  assert.equal(r.session, '68129628-84df-4fd3-a2bc-20311263459e');
  assert.equal(r.warning, null);
});

test('agy resumes a conversation by id', async (t) => {
  const r = await run(agy, 'echo', folder(t), { resume: 'conv-9' });
  assert.equal(r.session, 'conv-9');
});

test('agy refusing to answer without tools is retried once in text-only form', async (t) => {
  const r = await run(agy, 'deny-once', folder(t));
  assert.equal(r.text, 'The vault code is 7741 [1].');
  assert.equal(r.refusedOnce, true);
  await assert.rejects(run(agy, 'deny-always', folder(t)), (e) => e.code === 'refused' && /View file/.test(e.message));
});

test('an agy answer that comes with status ERROR is kept, with a warning', async (t) => {
  const r = await run(agy, 'error-with-answer', folder(t));
  assert.equal(r.text, 'The vault code is 7741 [1].');
  assert.match(r.warning, /ERROR.*503/);
});

test('agy not signed in is reported by name', async (t) => {
  await assert.rejects(run(agy, 'login', folder(t)), (e) => e.code === 'not-logged-in' && /run "agy"/.test(e.message));
});
