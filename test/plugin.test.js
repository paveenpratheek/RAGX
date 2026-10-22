/* The plugin's two pure modules, which run in Node as they do in the page. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, inline, citedIn } from '../plugin/md.js';
import { splitLines } from '../plugin/api.js';

test('markdown becomes a tree of paragraphs, lists, tables, code and headings', () => {
  const tree = parse('## Costs\n\nRent is **1,200** a month [1].\n\n- one\n- two [2][3]\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| x | y [4] |\n\n```\ncode [9]\n```');
  assert.deepEqual(tree.map((b) => b.t), ['h', 'p', 'list', 'list', 'table', 'pre']);
  assert.equal(tree[2].ordered, false);
  assert.equal(tree[3].ordered, true);
  assert.equal(tree[5].v, 'code [9]', 'code keeps its brackets as text');
  assert.deepEqual(tree[4].rows[0][1].filter((n) => n.t === 'cite').map((n) => n.n), [4]);
});

test('citations in every form become numbers, and a year span does not', () => {
  const cites = (s) => inline(s).filter((n) => n.t === 'cite').map((n) => n.n);
  assert.deepEqual(cites('a [1] b [2][3] c [4, 6] d [7-9]'), [1, 2, 3, 4, 6, 7, 8, 9]);
  assert.deepEqual(cites('from [1990-2020]'), []);
  assert.deepEqual(citedIn('x [3] y [1][3]'), [3, 1]);
});

test('markup in an answer stays text: no node in the tree can carry HTML', () => {
  const tree = parse('<img src=x onerror=alert(1)> and <script>alert(1)</script> **<b>bold</b>** [see](javascript:alert(1))');
  const walk = (nodes) => nodes.flatMap((n) => [n, ...(n.c ? walk(n.c) : [])]);
  const all = walk(tree[0].c);
  assert.ok(all.every((n) => ['text', 'strong', 'em', 'code', 'cite'].includes(n.t)));
  const text = all.filter((n) => n.t === 'text').map((n) => n.v).join('');
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.ok(!text.includes('javascript:'), 'a link keeps its text and drops its target');
});

test('stream lines are split as they arrive, keeping a partial line for later', () => {
  const a = splitLines('{"type":"sources"}\n{"type":"delta","text":"Hel');
  assert.deepEqual(a.events, [{ type: 'sources' }]);
  const b = splitLines(a.rest + 'lo"}\n\nnot json\n');
  assert.deepEqual(b.events, [{ type: 'delta', text: 'Hello' }]);
  assert.equal(b.rest, '');
});
