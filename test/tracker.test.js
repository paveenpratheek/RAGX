import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../engine/lib/store.js';
import { Tracker } from '../engine/lib/tracker.js';

function setup(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-tracker-'));
  const store = new Store(path.join(dir, 'rag.db'));
  let clock = Date.UTC(2026, 9, 22, 10, 0, 0);
  const tracker = new Tracker(store, { now: () => clock, ...opts });
  t.after(() => { tracker.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { tracker, advance: (ms) => { clock += ms; }, now: () => clock };
}

test('a call is recorded with who made it, its timings and what came back', (t) => {
  const { tracker } = setup(t);
  const seen = [];
  tracker.onCall((c) => seen.push(c.id));
  const c = tracker.record({ source: 'agent', client: 'mcp:claude-code/2.1.307', kind: 'search', question: 'how often do passwords rotate',
    ms: 820, timings: { embedMs: 610, loadMs: 0, searchMs: 12 }, results: 2,
    detail: { passages: [{ docName: 'policy.txt', text: 'Passwords rotate every 90 days.' }] } });
  assert.deepEqual(seen, [c.id]);
  const back = tracker.call(c.id);
  assert.equal(back.source, 'agent');
  assert.equal(back.embed_ms, 610);
  assert.equal(back.detail.passages[0].docName, 'policy.txt');
  const list = tracker.calls();
  assert.equal(list.length, 1);
  assert.equal(list[0].detail, undefined, 'the list leaves the detail out');
});

test('the summary splits calls by who and what, and counts model loads', (t) => {
  const { tracker } = setup(t);
  tracker.record({ source: 'you', kind: 'ask', ms: 15000, timings: { embedMs: 11400, loadMs: 11350, agentMs: 3000 } });
  tracker.record({ source: 'you', kind: 'search', ms: 300, timings: { embedMs: 250, loadMs: 0 } });
  tracker.record({ source: 'agent', kind: 'search', ms: 500, timings: { embedMs: 400, loadMs: 0 } });
  tracker.record({ source: 'agent', kind: 'search', ms: 700, error: 'engine stopped' });
  const s = tracker.summary();
  assert.equal(s.calls, 4);
  assert.equal(s.loads, 1);
  assert.equal(s.loadMs, 11350);
  assert.deepEqual([s.bySource.you.calls, s.bySource.agent.calls, s.bySource.agent.errors], [2, 2, 1]);
  assert.equal(s.bySource.you.maxMs, 15000);
  assert.equal(s.byKind.search.calls, 3);
  assert.deepEqual(tracker.calls({ source: 'agent' }).map((c) => c.source), ['agent', 'agent']);
});

test('samples are kept at 5-second detail for the last hour and as minute averages beyond', async (t) => {
  let util = 10;
  const { tracker, advance } = setup(t, {
    gpu: async () => ({ util: (util += 10), usedMb: 700, totalMb: 2048 }),
    model: async () => ({ up: true, loaded: true, vramMb: 548 }),
  });
  for (let i = 0; i < 12; i++) { await tracker.sample(); advance(5000); }
  const recent = tracker.samples(3600e3);
  assert.equal(recent.length, 12);
  assert.equal(recent[0].modelVram, 548);
  const minutes = tracker.samples(86400e3);
  assert.equal(minutes.length, 1);
  assert.equal(minutes[0].gpuUtilMax, 130);
  assert.equal(minutes[0].modelLoaded, 1);
  assert.equal(tracker.summary().modelLoadedSeconds, 60, 'twelve 5-second samples with the model loaded');
  assert.equal(tracker.summary().now.vramTotal, 2048);
});

test('raw samples go after a day and minute averages after a month', async (t) => {
  const { tracker, advance, now } = setup(t, { gpu: async () => ({ util: 5, usedMb: 100, totalMb: 2048 }), model: async () => ({ up: false, loaded: false, vramMb: 0 }) });
  await tracker.sample();
  advance(2 * 86400e3);
  tracker.prune();
  assert.equal(tracker.samples(3 * 86400e3).length, 1, 'the minute average outlives the raw sample');
  advance(30 * 86400e3);
  tracker.prune(now());
  assert.equal(tracker.samples(40 * 86400e3).length, 0);
});

test('without an NVIDIA GPU the samples carry no GPU numbers, and nothing breaks', async (t) => {
  const { tracker } = setup(t, { gpu: async () => null, model: async () => ({ up: true, loaded: false, vramMb: 0 }) });
  const s = await tracker.sample();
  assert.equal(s.gpuUtil, null);
  assert.equal(s.modelLoaded, 0);
});

test('clearing the history removes calls but not the resource samples', async (t) => {
  const { tracker } = setup(t, { gpu: async () => ({ util: 1, usedMb: 1, totalMb: 2 }) });
  tracker.record({ source: 'you', kind: 'search' });
  await tracker.sample();
  tracker.clear();
  assert.equal(tracker.calls().length, 0);
  assert.equal(tracker.samples().length, 1);
});
