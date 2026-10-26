import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../engine/lib/store.js';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-ids-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'rag.db');
};
const fig = { kind: 'chart', file: 'f.png', width: 1, height: 1 };
const doc = (store, name, chunks = ['one', 'two']) => {
  const id = store.addDoc({ sha256: name, name, ext: '.md', bytes: 1 });
  const out = { id, chunks: store.replaceChunks(id, chunks.map((text) => ({ text }))), figures: store.replaceFigures(id, [fig]).map((f) => f.id) };
  store.setReady(id, 'm');
  return out;
};

test('removing the newest document never hands its ids, or its chunks\' and figures\', to the next one', (t) => {
  const store = new Store(temp(t));
  doc(store, 'a.md');
  const b = doc(store, 'b.md');
  store.removeDoc(b.id);
  const c = doc(store, 'c.md');
  assert.ok(c.id > b.id);
  assert.ok(Math.min(...c.chunks) > Math.max(...b.chunks));
  assert.ok(c.figures[0] > b.figures[0]);
  store.close();
});

/* An index as it was before AUTOINCREMENT: the same tables with plain keys. */
function makeOld(file) {
  const store = new Store(file);
  const a = doc(store, 'a.md', ['rent is due monthly', 'late fees apply']);
  const b = doc(store, 'b.md');
  const conv = store.addConversation({ agent: 'claude', model: 'sonnet', title: 'q' });
  store.addSources(conv, [{ n: 1, chunkIds: [b.chunks[1] + 5], docId: b.id + 1, docName: 'gone.md', text: 'x', figures: [{ figureId: b.figures[0] + 3 }] }]);
  store.removeDoc(b.id);
  store.close();
  const db = new DatabaseSync(file);
  db.exec('pragma foreign_keys = off; begin');
  for (const t of ['documents', 'chunks', 'figures', 'linked_images']) {
    const sql = db.prepare("select sql from sqlite_master where name = ?").get(t).sql;
    const cols = db.prepare(`pragma table_info(${t})`).all().map((c) => c.name).join(', ');
    db.exec(`${sql.replace(/^create table\s+(if not exists\s+)?\w+/i, `create table ${t}_old`).replace(/ autoincrement/i, '')};
      insert into ${t}_old (${cols}) select ${cols} from ${t}; drop table ${t}; alter table ${t}_old rename to ${t};`);
  }
  db.exec("delete from sqlite_sequence where name in ('documents', 'chunks', 'figures', 'linked_images'); update meta set value = '5' where key = 'schema_version'; commit");
  db.close();
  return { a, b };
}

test('an older index is upgraded once: every id kept, and none given out again that anything still names', (t) => {
  const file = temp(t);
  const { a, b } = makeOld(file);
  const store = new Store(file);
  for (const name of ['documents', 'chunks', 'figures', 'linked_images']) {
    assert.match(store.db.prepare('select sql from sqlite_master where name = ?').get(name).sql, /autoincrement/i, name);
  }
  assert.equal(store.getMeta('schema_version'), '7');
  assert.equal(store.doc(a.id).name, 'a.md');
  assert.deepEqual(store.docChunkIds(a.id), a.chunks);
  assert.equal(store.figure(a.figures[0]).doc_id, a.id);
  // The keyword index and its triggers came through the copy.
  assert.deepEqual(store.keywordSearch('rent', 5).map((r) => r.id), [a.chunks[0]]);
  // Above what the conversation still names: document b.id + 1, chunk b's last + 5, figure b's + 3.
  const c = doc(store, 'c.md', ['late rent']);
  assert.equal(c.id, b.id + 2);
  assert.equal(c.chunks[0], b.chunks[1] + 6);
  assert.equal(c.figures[0], b.figures[0] + 4);
  assert.deepEqual(store.keywordSearch('late', 5).map((r) => r.id).sort((x, y) => x - y), [a.chunks[1], c.chunks[0]]);
  store.close();
  // Opening it again changes nothing more.
  const again = new Store(file);
  assert.equal(again.doc(c.id).name, 'c.md');
  again.close();
});
