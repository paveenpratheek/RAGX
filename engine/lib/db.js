/* The index database: one SQLite file in the data folder.
 *
 * Node's own node:sqlite, not a native module (t-3833b289a0): FTS5, bm25 and
 * BLOB vectors all work in it, and nothing has to be rebuilt when Node moves.
 */
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
create table if not exists meta (
  key   text primary key,
  value text not null
);

create table if not exists documents (
  id            integer primary key,
  sha256        text not null unique,
  name          text not null,
  ext           text not null,
  source_path   text,
  bytes         integer not null,
  status        text not null,
  error         text,
  pages         integer,
  chunks        integer not null default 0,
  embedded_with text,
  added_at      text not null,
  updated_at    text not null
);

create table if not exists chunks (
  id        integer primary key,
  doc_id    integer not null references documents(id) on delete cascade,
  ord       integer not null,
  heading   text not null default '',
  text      text not null,
  lead      integer not null default 0,
  page_from integer,
  page_to   integer,
  unique (doc_id, ord)
);

create table if not exists vectors (
  chunk_id integer primary key references chunks(id) on delete cascade,
  v        blob not null
);

create virtual table if not exists chunks_fts using fts5(
  text, heading,
  content = 'chunks', content_rowid = 'id',
  tokenize = 'porter unicode61'
);

create trigger if not exists chunks_ai after insert on chunks begin
  insert into chunks_fts (rowid, text, heading) values (new.id, new.text, new.heading);
end;

create trigger if not exists chunks_ad after delete on chunks begin
  insert into chunks_fts (chunks_fts, rowid, text, heading) values ('delete', old.id, old.text, old.heading);
end;

create table if not exists conversations (
  id         integer primary key,
  agent      text not null,
  model      text,
  session    text,
  title      text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists messages (
  id              integer primary key,
  conversation_id integer not null references conversations(id) on delete cascade,
  role            text not null,
  text            text not null,
  cited           text,
  unknown         text,
  created_at      text not null
);

create table if not exists sources (
  conversation_id integer not null references conversations(id) on delete cascade,
  n               integer not null,
  chunk_ids       text not null,
  doc_id          integer,
  doc_name        text not null,
  heading         text not null default '',
  page_from       integer,
  page_to         integer,
  text            text not null,
  primary key (conversation_id, n)
);

create table if not exists calls (
  id        integer primary key,
  at        integer not null,
  ms        integer,
  source    text not null,
  client    text,
  kind      text not null,
  question  text,
  agent     text,
  model     text,
  embed_ms  integer,
  load_ms   integer,
  search_ms integer,
  agent_ms  integer,
  results   integer,
  detail    text,
  error     text
);
create index if not exists calls_at on calls (at);

create table if not exists samples (
  at           integer primary key,
  gpu_util     real,
  vram_used    integer,
  vram_total   integer,
  model_loaded integer,
  model_vram   integer
);

create table if not exists samples_min (
  minute         integer primary key,
  n              integer not null,
  gpu_util_sum   real not null default 0,
  gpu_util_max   real,
  vram_used_max  integer,
  vram_total     integer,
  model_loaded_n integer not null default 0,
  model_vram_max integer
);
`;

/* `lead` is how many characters at the start of a chunk repeat the end of the
 * one before it - the overlap. Search joins neighbouring chunks by dropping
 * exactly that much, so a passage built from two chunks never reads a
 * sentence twice.
 *
 * The keyword index stems English (t-eaa5b5169e): a question asking about a
 * "payment" has to find a document that says "Payments". */
export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  const row = db.prepare("select value from meta where key = 'schema_version'").get();
  if (row && Number(row.value) > SCHEMA_VERSION) {
    db.close();
    throw new Error(`The index at ${file} was written by a newer engine (schema ${row.value}, this one knows ${SCHEMA_VERSION}).`);
  }
  /* Every change so far only adds tables, which the schema above creates
   * when missing - so an older index is brought up to date by opening it
   * (t-a8652db0cd). */
  db.prepare("insert into meta (key, value) values ('schema_version', ?) on conflict (key) do update set value = excluded.value")
    .run(String(SCHEMA_VERSION));
  return db;
}

/* node:sqlite has no transaction helper. Every multi-row write goes through
 * this, so a crash or Ctrl+C between batches leaves whole batches or nothing. */
export function transaction(db, fn) {
  db.exec('begin');
  try {
    const out = fn();
    db.exec('commit');
    return out;
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
}
