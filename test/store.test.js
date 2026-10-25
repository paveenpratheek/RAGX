import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, STATUS } from '../engine/lib/store.js';

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-store-'));
  const store = new Store(path.join(dir, 'rag.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function addReadyDoc(store, name, chunks, embeddedWith = 'm') {
  const id = store.addDoc({ sha256: name + '-sha', name, ext: '.txt', bytes: 1 });
  const ids = store.replaceChunks(id, chunks.map((text) => ({ text })));
  store.setReady(id, embeddedWith);
  return { id, ids };
}

test('meta keeps the schema version and settings', (t) => {
  const s = tempStore(t);
  assert.equal(s.getMeta('schema_version'), '6');
  assert.equal(s.getMeta('embed_model', 'none'), 'none');
  s.setMeta('embed_model', 'nomic');
  s.setMeta('embed_model', 'bge');
  assert.equal(s.getMeta('embed_model'), 'bge');
});

test('a document goes from queued to ready with its chunk count', (t) => {
  const s = tempStore(t);
  const id = s.addDoc({ sha256: 'abc', name: 'a.txt', ext: '.txt', bytes: 10 });
  assert.equal(s.doc(id).status, STATUS.queued);
  s.replaceChunks(id, [{ text: 'one' }, { text: 'two' }]);
  s.setReady(id, 'nomic');
  const d = s.doc(id);
  assert.equal(d.status, STATUS.ready);
  assert.equal(d.chunks, 2);
  assert.equal(d.embedded_with, 'nomic');
  assert.equal(s.docBySha('abc').id, id);
});

test('keyword search stems English word forms', (t) => {
  const s = tempStore(t);
  const { ids } = addReadyDoc(s, 'terms', [
    'Payments are due thirty days after invoicing.',
    'Connected devices are listed in the appendix.',
    'The office is closed on public holidays.',
  ]);
  assert.deepEqual(s.keywordSearch('"payment"', 5).map((r) => r.id), [ids[0]]);
  assert.deepEqual(s.keywordSearch('"connection"', 5).map((r) => r.id), [ids[1]]);
});

test('removing a document takes its chunks out of the keyword index and its vectors with it', (t) => {
  const s = tempStore(t);
  const a = addReadyDoc(s, 'a', ['alpha bravo charlie']);
  addReadyDoc(s, 'b', ['delta echo foxtrot']);
  s.putVectors([{ id: a.ids[0], vector: new Float32Array([1, 0, 0]) }]);
  assert.equal(s.keywordSearch('"bravo"', 5).length, 1);
  s.removeDoc(a.id);
  assert.equal(s.keywordSearch('"bravo"', 5).length, 0);
  assert.equal(s.keywordSearch('"echo"', 5).length, 1);
  assert.equal(s.totals().vectors, 0);
});

test('replacing chunks re-indexes them', (t) => {
  const s = tempStore(t);
  const { id } = addReadyDoc(s, 'a', ['old words here']);
  s.replaceChunks(id, [{ text: 'new words here' }]);
  assert.equal(s.keywordSearch('"old"', 5).length, 0);
  assert.equal(s.keywordSearch('"new"', 5).length, 1);
});

test('unembedded lists exactly the chunks still owed a vector', (t) => {
  const s = tempStore(t);
  const { id, ids } = addReadyDoc(s, 'a', ['one', 'two', 'three']);
  s.putVectors([{ id: ids[1], vector: [0, 1] }]);
  assert.deepEqual(s.unembedded(id).map((c) => c.id), [ids[0], ids[2]]);
});

test('vectors come back only for documents embedded the current way', (t) => {
  const s = tempStore(t);
  const a = addReadyDoc(s, 'a', ['one'], 'nomic');
  const b = addReadyDoc(s, 'b', ['two'], 'bge');
  s.putVectors([{ id: a.ids[0], vector: [0.5, 0.25] }, { id: b.ids[0], vector: [1, 1, 1] }]);
  const got = [...s.vectors('nomic')];
  assert.equal(got.length, 1);
  assert.equal(got[0].id, a.ids[0]);
  assert.deepEqual(Array.from(got[0].vector), [0.5, 0.25]);
  assert.deepEqual(s.staleDocs('nomic').map((d) => d.id), [b.id]);
});

test('keyword search ignores documents that are not ready', (t) => {
  const s = tempStore(t);
  const id = s.addDoc({ sha256: 'x', name: 'x', ext: '.txt', bytes: 1 });
  s.replaceChunks(id, [{ text: 'halfway through ingesting' }]);
  assert.equal(s.keywordSearch('"ingesting"', 5).length, 0);
});
