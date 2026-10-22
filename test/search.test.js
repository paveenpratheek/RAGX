import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../engine/lib/store.js';
import { VectorIndex, normalise, toBlob, fromBlob } from '../engine/lib/vectors.js';
import { buildMatch, fuse, hybridSearch } from '../engine/lib/search.js';

test('buildMatch quotes each word and survives FTS5 syntax characters', () => {
  assert.equal(buildMatch('When was INV-2024-0042 paid?'), '"inv-2024-0042" OR "paid"');
  assert.equal(buildMatch('the "quoted" word: colon'), '"quoted" OR "word" OR "colon"');
  assert.equal(buildMatch('what is it?'), null);
  assert.equal(buildMatch('payment PAYMENT payment'), '"payment"');
});

test('a built match runs in FTS5 where the raw question would fail', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-search-'));
  const store = new Store(path.join(dir, 'rag.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = store.addDoc({ sha256: 's', name: 'bill.txt', ext: '.txt', bytes: 1 });
  const [chunk] = store.replaceChunks(id, [{ text: 'The invoice INV-2024-0042 was paid by bank transfer.' }]);
  store.setReady(id, 'm');
  assert.throws(() => store.keywordSearch('INV-2024-0042', 5), /no such column/);
  assert.deepEqual(store.keywordSearch(buildMatch('INV-2024-0042'), 5).map((r) => r.id), [chunk]);
});

test('blobs round-trip a Float32Array even from an unaligned offset', () => {
  const v = new Float32Array([0.1, -0.2, 0.3]);
  const padded = new Uint8Array(13);
  padded.set(toBlob(v), 1);
  assert.deepEqual(Array.from(fromBlob(padded.subarray(1))), Array.from(v));
});

test('the vector index returns the top k by dot product and survives removal', () => {
  const index = new VectorIndex(3);
  index.add(1, [1, 0, 0]);
  index.add(2, [0, 1, 0]);
  index.add(3, [0.9, 0.1, 0]);
  index.add(4, [0, 0, 1]);
  assert.deepEqual(index.search([1, 0, 0], 2).map((r) => r.id), [1, 3]);
  index.remove([1]);
  assert.equal(index.search([1, 0, 0], 2)[0].id, 3);
  assert.equal(index.count, 3);
  index.add(3, [0, 0, 1]);
  assert.equal(index.count, 3, 're-adding an id replaces it');
  assert.equal(index.search([1, 0, 0], 1)[0].score < 0.5, true);
  assert.throws(() => index.add(9, [1, 2]), /dimensions/);
});

test('the vector index grows past its first allocation', () => {
  const index = new VectorIndex(2);
  for (let i = 0; i < 3000; i++) index.add(i, [Math.cos(i), Math.sin(i)]);
  assert.equal(index.count, 3000);
  const top = index.search([1, 0], 5);
  assert.equal(top.length, 5);
  assert.ok(top[0].score > 0.9999);
  assert.ok(top.every((r, i) => i === 0 || r.score <= top[i - 1].score));
});

test('fuse ranks an item found by both lists above items found by one', () => {
  const out = fuse([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'b' }]]);
  assert.equal(out[0].id, 'b');
  assert.deepEqual(out[0].ranks, { 0: 2, 1: 2 });
  assert.equal(out.length, 3);
});

function corpus(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-hybrid-'));
  const store = new Store(path.join(dir, 'rag.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const index = new VectorIndex(3);
  const add = (name, chunks) => {
    const id = store.addDoc({ sha256: name, name, ext: '.txt', bytes: 1 });
    const ids = store.replaceChunks(id, chunks.map(([text, , lead]) => ({ text, lead })));
    store.setReady(id, 'm');
    ids.forEach((cid, i) => index.add(cid, chunks[i][1]));
    return ids;
  };
  return { store, index, add };
}

test('hybrid search finds the exact code by keyword and the paraphrase by vector', (t) => {
  const { store, index, add } = corpus(t);
  const [code] = add('bill', [['Invoice INV-2024-0042 settled in full.', [0, 0, 1]]]);
  const [lease] = add('lease', [['The tenancy lasts two years from January.', [1, 0, 0]]]);
  add('misc', [['Staff parking is behind the building.', [0, 1, 0]]]);

  const byCode = hybridSearch({ store, index, question: 'INV-2024-0042', queryVector: [0, 1, 0] });
  assert.equal(byCode[0].chunkIds[0], code);
  assert.equal(byCode[0].ranks.keyword, 1);

  const byMeaning = hybridSearch({ store, index, question: 'how long is the lease', queryVector: [0.95, 0.05, 0] });
  assert.equal(byMeaning[0].chunkIds[0], lease);
  assert.equal(byMeaning[0].ranks.vector, 1);
});

test('hybrid search caps chunks per document and joins neighbours without repeating the overlap', (t) => {
  const { store, index, add } = corpus(t);
  const ids = add('long', [
    ['Alpha one. Shared tail.', [1, 0, 0]],
    [' Shared tail. Beta two.', [0.99, 0.01, 0], 13],
    ['Gamma three.', [0.98, 0.02, 0]],
    ['Delta four.', [0.97, 0.03, 0]],
  ]);
  add('other', [['Unrelated other text.', [0.5, 0.5, 0]]]);
  const out = hybridSearch({ store, index, question: 'alpha', queryVector: [1, 0, 0], k: 8, perDoc: 3 });
  const long = out.filter((p) => p.docName === 'long');
  assert.equal(long.length, 1);
  assert.deepEqual(long[0].chunkIds, ids.slice(0, 3));
  assert.equal(long[0].text, 'Alpha one. Shared tail. Beta two.Gamma three.');
  assert.ok(out.some((p) => p.docName === 'other'));
});

test('normalise leaves a zero vector at zero rather than dividing by it', () => {
  assert.deepEqual(Array.from(normalise([0, 0])), [0, 0]);
});
