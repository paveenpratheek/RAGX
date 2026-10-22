import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, TARGET, targetFor } from '../engine/lib/chunk.js';

const para = (text, page) => ({ kind: 'para', text, page });
const sentence = (i) => `Sentence number ${i} talks about the quarterly figures for region ${i % 7}.`;

/* Joining every chunk to the next by dropping its lead must give back the
 * section's text exactly once - that is what search relies on. */
function rejoin(chunks) {
  return chunks.reduce((s, c, i) => (i ? s + c.text.slice(c.lead) : c.text), '');
}

test('chunks carry the heading path and never cross a heading', () => {
  const out = chunk([
    para('Before any heading.'),
    { kind: 'heading', level: 1, text: 'Guide' },
    para('Intro text.'),
    { kind: 'heading', level: 2, text: 'Setup' },
    para('Install it.'),
    { kind: 'heading', level: 3, text: 'Windows' },
    para('Use the installer.'),
    { kind: 'heading', level: 2, text: 'Usage' },
    para('Run it.'),
    { kind: 'heading', level: 2, text: 'Empty section' },
    { kind: 'heading', level: 1, text: 'Appendix' },
    para('Extra.'),
  ]);
  assert.deepEqual(out.map((c) => [c.heading, c.text]), [
    ['', 'Before any heading.'],
    ['Guide', 'Intro text.'],
    ['Guide > Setup', 'Install it.'],
    ['Guide > Setup > Windows', 'Use the installer.'],
    ['Guide > Usage', 'Run it.'],
    ['Appendix', 'Extra.'],
  ]);
});

test('long prose is packed by sentence under the target, overlapping by whole sentences', () => {
  const text = Array.from({ length: 120 }, (_, i) => sentence(i)).join(' ');
  const out = chunk([{ kind: 'heading', level: 1, text: 'Report' }, para(text, 3)]);
  assert.ok(out.length > 3);
  for (const c of out) assert.ok(c.text.length <= TARGET, `chunk of ${c.text.length}`);
  assert.equal(out[0].lead, 0);
  for (let i = 1; i < out.length; i++) {
    const c = out[i];
    assert.ok(c.lead > 0 && c.lead <= 250, `lead ${c.lead}`);
    assert.equal(c.text.slice(0, c.lead), out[i - 1].text.slice(-c.lead));
    assert.match(c.text.slice(0, c.lead), /^Sentence number \d+/);
  }
  assert.equal(rejoin(out), text);
  assert.ok(out.every((c) => c.pageFrom === 3 && c.pageTo === 3 && c.heading === 'Report'));
});

test('paragraphs keep their breaks and list items stay on consecutive lines', () => {
  const out = chunk([para('First paragraph.'), para('Second paragraph.'), para('- one'), para('- two')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'First paragraph.\n\nSecond paragraph.\n\n- one\n- two');
});

test('page ranges span the pages a chunk was built from', () => {
  const out = chunk([para('On page one.', 1), para('On page two.', 2)]);
  assert.deepEqual([out[0].pageFrom, out[0].pageTo], [1, 2]);
});

test('code is split only between lines, and never repeated as overlap', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i}); // line ${i}`);
  const out = chunk([{ kind: 'code', text: lines.join('\n') }]);
  assert.ok(out.length > 1);
  const seen = out.flatMap((c) => c.text.split('\n'));
  assert.deepEqual(seen, lines);
  assert.ok(out.every((c) => c.lead === 0 && c.text.length <= TARGET));
});

test('a table split across chunks keeps rows whole and repeats its header', () => {
  const rows = ['Item | Amount | Note', ...Array.from({ length: 80 }, (_, i) => `Item ${i} | ${i * 100} | paid in instalment ${i}`)];
  const out = chunk([{ kind: 'table', rows, text: rows.join('\n') }]);
  assert.ok(out.length > 1);
  for (const c of out) {
    assert.equal(c.text.split('\n')[0], rows[0]);
    assert.ok(c.text.length <= TARGET);
  }
  const body = out.flatMap((c) => c.text.split('\n').slice(1));
  assert.deepEqual(body, rows.slice(1));
});

test('a sentence longer than the target is cut at whitespace, and a word with none at the limit', () => {
  const long = Array.from({ length: 500 }, (_, i) => 'word' + i).join(' ');
  const out = chunk([para(long), para('x'.repeat(4000))]);
  assert.ok(out.every((c) => c.text.length <= TARGET));
  assert.equal(out.map((c) => c.text).join(' ').replace(/\s+/g, ' ').replace(/\s?x+/g, '').trim(), long);
  assert.equal(out.filter((c) => /^x+$/.test(c.text)).reduce((s, c) => s + c.text.length, 0), 4000);
});

test('targetFor sizes chunks to the window, under a ceiling', () => {
  assert.equal(targetFor(512), 1280);
  assert.equal(targetFor(8192), TARGET);
  assert.equal(targetFor(null), TARGET);
});

test('the reserved heading line comes out of each section\'s size, and overlap shrinks with it', () => {
  const text = Array.from({ length: 120 }, (_, i) => sentence(i)).join(' ');
  const reserve = (heading) => ('report.pdf > ' + heading + '\n\n').length;
  const out = chunk([{ kind: 'heading', level: 1, text: 'A long section heading that takes room' }, para(text)], { target: 600, reserve });
  for (const c of out) assert.ok(reserve(c.heading) + c.text.length <= 600, `${reserve(c.heading) + c.text.length}`);
  assert.ok(out.slice(1).every((c) => c.lead <= Math.round((600 - reserve(out[0].heading)) / 7)));
  assert.equal(rejoin(out), text);
});

test('headings alone produce no chunks', () => {
  assert.deepEqual(chunk([{ kind: 'heading', level: 1, text: 'Only a title' }]), []);
});
