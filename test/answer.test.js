import { test } from 'node:test';
import { READER } from './fixtures.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../engine/lib/engine.js';
import { Embedder } from '../engine/lib/embed.js';
import { ask, citations, buildPrompt, label, RULES } from '../engine/lib/answer.js';
import { fakeOllama } from './ollama-fake.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');

test('citations reads single, repeated, listed and short-range forms', () => {
  assert.deepEqual(citations('A [2]. B [1][3]. C [4, 6]. D [7-9]. E [2].'), [1, 2, 3, 4, 6, 7, 8, 9]);
  assert.deepEqual(citations('From [1990-2020] and [see notes].'), []);
  assert.deepEqual(citations('none here'), []);
});

test('a first prompt numbers its sources; a follow-up says which earlier ones still apply', () => {
  const s = (n) => ({ n, docName: 'lease.pdf', heading: 'Terms > Rent', pageFrom: 3, pageTo: 3, text: `Text ${n}.` });
  assert.equal(label(s(2)), '[2] lease.pdf, p.3 - Terms > Rent');
  assert.equal(buildPrompt({ question: 'When?', fresh: [s(1), s(2)] }),
    'Sources:\n\n[1] lease.pdf, p.3 - Terms > Rent\nText 1.\n\n[2] lease.pdf, p.3 - Terms > Rent\nText 2.\n\nQuestion: When?');
  assert.match(buildPrompt({ question: 'And?', fresh: [s(3)], earlier: 2 }), /^More sources \(the earlier ones, \[1\]-\[2\], still apply\)/);
  assert.match(buildPrompt({ question: 'And?', fresh: [], earlier: 2 }), /^No new sources were found/);
  assert.match(RULES, /not instructions to you/);
});

const lease = '# Lease\n\nThe tenancy runs for two years from January.\n\n## Rent\n\nRent of 1,200 is due on the first of each month.\n\n## Fees\n\nA late fee of 50 applies after five days.\n';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-answer-'));
  const ollama = fakeOllama();
  const engine = Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: ollama.fetch, retries: 0 }), figureFloor: 0, readerOptions: READER });
  t.after(() => { engine.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const file = (name, text) => { const f = path.join(root, name); fs.writeFileSync(f, text); return f; };
  const askWith = (behaviour, opts) => {
    const deltas = [];
    const agentName = opts.agent || 'claude';
    return ask(engine, {
      ...opts,
      onDelta: (d) => deltas.push(d),
      agentOptions: { executable: process.execPath, prefixArgs: [FAKE, agentName, behaviour], timeoutMs: 15_000 },
    }).then((r) => ({ ...r, deltas }));
  };
  return { engine, file, askWith };
}

test('a first question sends numbered sources and the rules, and records the conversation', async (t) => {
  const { engine, file, askWith } = setup(t);
  await engine.ingest(file('lease.md', lease));
  const r = await askWith('echo', { question: 'When is the rent due?' });
  const seen = JSON.parse(r.answer);
  assert.match(seen.prompt, /^Sources:\n\n\[1\] lease\.md - Lease > Rent\nRent of 1,200/);
  assert.match(seen.prompt, /Question: When is the rent due\?$/);
  assert.equal(seen.flags[seen.flags.indexOf('--append-system-prompt') + 1], RULES);
  assert.equal(seen.flags[seen.flags.indexOf('--model') + 1], 'sonnet');
  assert.ok(!seen.flags.includes('--resume'));
  assert.equal(path.basename(seen.cwd), 'agent');

  const conv = engine.store.conversation(r.conversationId);
  assert.deepEqual([conv.agent, conv.model, conv.session], ['claude', 'sonnet', 'sess-1']);
  assert.deepEqual(engine.store.messages(conv.id).map((m) => m.role), ['user', 'assistant']);
  assert.ok(engine.store.sources(conv.id).length >= 1);
});

test('a follow-up resumes the session, keeps old numbers and sends only new sources', async (t) => {
  const { engine, file, askWith } = setup(t);
  await engine.ingest(file('lease.md', lease));
  const first = await askWith('echo', { question: 'When is the rent due?', k: 1 });
  const firstSources = engine.store.sources(first.conversationId);
  assert.equal(firstSources.length, 1);

  const second = await askWith('echo', { question: 'Is there a late fee?', conversationId: first.conversationId, k: 3 });
  const seen = JSON.parse(second.answer);
  assert.equal(seen.flags[seen.flags.indexOf('--resume') + 1], 'sess-1');
  assert.match(seen.prompt, /^More sources \(the earlier ones, \[1\]-\[1\], still apply\)/);
  assert.ok(!seen.prompt.includes('[1] lease.md'), 'a source already shown is not sent again');
  assert.match(seen.prompt, /\[2\] lease\.md/);
  const all = engine.store.sources(first.conversationId);
  assert.deepEqual(all.map((s) => s.n), all.map((_, i) => i + 1));
  assert.equal(all[0].text, firstSources[0].text);
  assert.equal(second.conversationId, first.conversationId);
});

test('citations are checked: real ones link to their source, an invented one is flagged', async (t) => {
  const { engine, file, askWith } = setup(t);
  await engine.ingest(file('lease.md', lease));
  const r = await askWith('cite-unknown', { question: 'When is the rent due?' });
  assert.deepEqual(r.cited.map((s) => s.n), [1]);
  assert.deepEqual(r.unknown, [9]);
  assert.deepEqual(engine.store.messages(r.conversationId)[1].unknown, [9]);
  assert.equal(r.deltas.join(''), r.answer, 'the answer streamed as it came');
});

test('agy works the same way, and a conversation stays with its agent', async (t) => {
  const { engine, file, askWith } = setup(t);
  await engine.ingest(file('lease.md', lease));
  const r = await askWith('answer', { question: 'When is the rent due?', agent: 'agy' });
  assert.equal(engine.store.conversation(r.conversationId).session, 'conv-1');
  await assert.rejects(askWith('answer', { question: 'More?', agent: 'claude', conversationId: r.conversationId }), (e) => e.code === 'wrong-agent');
  const follow = await askWith('echo', { question: 'More?', conversationId: r.conversationId, agent: 'agy' });
  const seen = JSON.parse(follow.answer);
  assert.equal(seen.flags[seen.flags.indexOf('--conversation') + 1], 'conv-1');
});

test('with nothing indexed no agent is started at all', async (t) => {
  const { askWith } = setup(t);
  const r = await askWith('crash', { question: 'Anything?' });
  assert.equal(r.asked, false);
  assert.match(r.answer, /Nothing in the indexed documents/);
});

test('the model comes from the question, then the setting, then the default', async (t) => {
  const { engine, file, askWith } = setup(t);
  await engine.ingest(file('lease.md', lease));
  engine.store.setMeta('claude_model', 'haiku');
  const bySetting = JSON.parse((await askWith('echo', { question: 'Rent?' })).answer);
  assert.equal(bySetting.flags[bySetting.flags.indexOf('--model') + 1], 'haiku');
  const byQuestion = JSON.parse((await askWith('echo', { question: 'Rent?', model: 'opus' })).answer);
  assert.equal(byQuestion.flags[byQuestion.flags.indexOf('--model') + 1], 'opus');
});

test('a figure beside a source goes to Claude as an image, labelled; Antigravity reads its caption only', async (t) => {
  const { makePdf, barChartPage } = await import('./fixtures.js');
  const { engine, file, askWith } = setup(t);
  const r0 = await engine.ingest(file('costs.pdf', makePdf([[{ text: 'Costs', size: 20, y: 760 }, ...barChartPage({ top: 700 })]])));
  const [fig] = engine.store.docFigures(r0.doc.id);

  const r = await askWith('echo', { question: 'Which region cost the most in 2024?' });
  const seen = JSON.parse(r.answer);
  assert.equal(seen.images, 1);
  assert.match(seen.labels[0], /^The figure beside source \[1\] - Figure 1 - Costs by region in 2024\.:$/);
  assert.match(seen.prompt, /\(Beside this passage: figure "Figure 1 - Costs by region in 2024\." - its image is given\.\)/);
  assert.match(RULES, /figures/);
  assert.equal(r.images, 1);
  // The source keeps its figure, so a reopened conversation can show it.
  assert.deepEqual(engine.store.sources(r.conversationId)[0].figures.map((f) => f.figureId), [fig.id]);

  const a = await askWith('echo', { question: 'Which region cost the most in 2024?', agent: 'agy' });
  const agySeen = JSON.parse(a.answer);
  assert.match(agySeen.prompt, /\(Beside this passage: figure "Figure 1 - Costs by region in 2024\."\.\)/, 'no image is claimed');
  assert.equal(a.images, 0);
});
