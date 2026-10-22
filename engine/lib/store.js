/* Everything the engine keeps, behind one object: documents, their chunks,
 * the chunks' vectors and the keyword index over them. Callers never write
 * SQL; the statements are prepared once here.
 */
import { openDb, transaction } from './db.js';
import { toBlob, fromBlob } from './vectors.js';

export const STATUS = Object.freeze({
  queued: 'queued',
  extracting: 'extracting',
  embedding: 'embedding',
  ready: 'ready',
  error: 'error',
});

const now = () => new Date().toISOString();

export class Store {
  constructor(file) {
    this.db = openDb(file);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      getMeta: p('select value from meta where key = ?'),
      setMeta: p('insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value'),
      docBySha: p('select * from documents where sha256 = ?'),
      doc: p('select * from documents where id = ?'),
      docs: p('select * from documents order by id'),
      addDoc: p(`insert into documents (sha256, name, ext, source_path, bytes, status, added_at, updated_at)
                 values (?, ?, ?, ?, ?, 'queued', ?, ?)`),
      setStatus: p('update documents set status = ?, error = ?, updated_at = ? where id = ?'),
      setReady: p(`update documents set status = 'ready', error = null, embedded_with = ?, chunks = ?, updated_at = ?
                   where id = ?`),
      setPages: p('update documents set pages = ?, updated_at = ? where id = ?'),
      setEmbedding: p(`update documents set status = 'embedding', error = null, embedded_with = ?, updated_at = ?
                       where id = ?`),
      setError: p('update documents set error = ?, updated_at = ? where id = ?'),
      docVectors: p('select v.chunk_id id, v.v from vectors v join chunks c on c.id = v.chunk_id where c.doc_id = ?'),
      docChunkIds: p('select id from chunks where doc_id = ?'),
      removeDoc: p('delete from documents where id = ?'),
      deleteChunks: p('delete from chunks where doc_id = ?'),
      addChunk: p(`insert into chunks (doc_id, ord, heading, text, lead, page_from, page_to)
                   values (?, ?, ?, ?, ?, ?, ?)`),
      chunkCount: p('select count(*) n from chunks where doc_id = ?'),
      unembedded: p(`select c.id, c.heading, c.text from chunks c left join vectors v on v.chunk_id = c.id
                     where c.doc_id = ? and v.chunk_id is null order by c.ord`),
      putVector: p('insert or replace into vectors (chunk_id, v) values (?, ?)'),
      clearVectors: p('delete from vectors where chunk_id in (select id from chunks where doc_id = ?)'),
      vectorsFor: p(`select v.chunk_id id, v.v from vectors v join chunks c on c.id = v.chunk_id
                     join documents d on d.id = c.doc_id
                     where d.status = 'ready' and d.embedded_with = ?`),
      chunk: p(`select c.*, d.name doc_name from chunks c join documents d on d.id = c.doc_id where c.id = ?`),
      chunkAt: p(`select c.*, d.name doc_name from chunks c join documents d on d.id = c.doc_id
                  where c.doc_id = ? and c.ord = ?`),
      fts: p(`select f.rowid id, bm25(chunks_fts) score from chunks_fts f
              join chunks c on c.id = f.rowid join documents d on d.id = c.doc_id
              where chunks_fts match ? and d.status = 'ready'
              order by bm25(chunks_fts) limit ?`),
      stale: p(`select * from documents where status = 'ready' and (embedded_with is null or embedded_with <> ?)`),
      pending: p(`select * from documents where status in ('queued', 'extracting', 'embedding') order by id`),
      totals: p(`select (select count(*) from documents) docs, (select count(*) from chunks) chunks,
                        (select count(*) from vectors) vectors`),
      addConversation: p('insert into conversations (agent, model, title, created_at, updated_at) values (?, ?, ?, ?, ?)'),
      conversation: p('select * from conversations where id = ?'),
      conversations: p(`select c.*, (select count(*) from messages m where m.conversation_id = c.id and m.role = 'user') questions
                        from conversations c order by c.updated_at desc`),
      setSession: p('update conversations set session = ?, model = coalesce(?, model), updated_at = ? where id = ?'),
      addMessage: p('insert into messages (conversation_id, role, text, cited, unknown, created_at) values (?, ?, ?, ?, ?, ?)'),
      messages: p('select * from messages where conversation_id = ? order by id'),
      addSource: p(`insert into sources (conversation_id, n, chunk_ids, doc_id, doc_name, heading, page_from, page_to, text)
                    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      sources: p('select * from sources where conversation_id = ? order by n'),
    };
  }

  close() { this.db.close(); }

  getMeta(key, fallback = null) {
    const row = this.q.getMeta.get(key);
    return row ? row.value : fallback;
  }

  setMeta(key, value) { this.q.setMeta.run(key, String(value)); }

  docBySha(sha) { return this.q.docBySha.get(sha) || null; }
  doc(id) { return this.q.doc.get(id) || null; }
  docs() { return this.q.docs.all(); }

  addDoc({ sha256, name, ext, sourcePath = null, bytes }) {
    const t = now();
    return Number(this.q.addDoc.run(sha256, name, ext, sourcePath, bytes, t, t).lastInsertRowid);
  }

  setStatus(id, status, error = null) { this.q.setStatus.run(status, error, now(), id); }
  setPages(id, pages) { this.q.setPages.run(pages ?? null, now(), id); }

  /* Embedding starts by recording what it embeds with, so a run cut short
   * can be resumed only by the same model - another would mix spaces. */
  setEmbedding(id, embeddedWith) { this.q.setEmbedding.run(embeddedWith, now(), id); }

  /* An error that leaves the status alone: the work can be resumed once its
   * cause - Ollama stopped, the model not pulled - is put right. */
  setError(id, error) { this.q.setError.run(error, now(), id); }

  docVectors(docId) { return this.q.docVectors.all(docId).map((r) => ({ id: r.id, vector: fromBlob(r.v) })); }
  docChunkIds(docId) { return this.q.docChunkIds.all(docId).map((r) => r.id); }

  setReady(id, embeddedWith) {
    const { n } = this.q.chunkCount.get(id);
    this.q.setReady.run(embeddedWith, n, now(), id);
  }

  /* Chunks cascade to their vectors and, through the trigger, out of the
   * keyword index. */
  removeDoc(id) { this.q.removeDoc.run(id); }

  replaceChunks(docId, chunks) {
    return transaction(this.db, () => {
      this.q.deleteChunks.run(docId);
      return chunks.map((c, i) => Number(this.q.addChunk.run(
        docId, i, c.heading || '', c.text, c.lead || 0, c.pageFrom ?? null, c.pageTo ?? null,
      ).lastInsertRowid));
    });
  }

  /* What an interrupted embed still owes: chunks with no vector yet. */
  unembedded(docId) { return this.q.unembedded.all(docId); }

  putVectors(pairs) {
    transaction(this.db, () => {
      for (const { id, vector } of pairs) this.q.putVector.run(id, toBlob(vector));
    });
  }

  clearVectors(docId) { this.q.clearVectors.run(docId); }

  /* Only vectors from documents embedded the way the index is set up now -
   * a vector from another model lives in another space and must not be
   * compared with these. */
  *vectors(embeddedWith) {
    for (const row of this.q.vectorsFor.iterate(embeddedWith)) yield { id: row.id, vector: fromBlob(row.v) };
  }

  chunk(id) { return this.q.chunk.get(id) || null; }
  chunkAt(docId, ord) { return this.q.chunkAt.get(docId, ord) || null; }

  /* bm25() is lower-is-better; the sign is flipped so every score the store
   * returns is higher-is-better. */
  keywordSearch(match, limit) {
    return this.q.fts.all(match, limit).map((r) => ({ id: r.id, score: -r.score }));
  }

  /* A conversation holds its agent's session and its own numbering of
   * sources, so [3] means the same passage for as long as it runs. A source
   * keeps its text: the agent was shown it, and a document removed later
   * must not change what an old answer cited. */
  addConversation({ agent, model, title }) {
    const t = now();
    return Number(this.q.addConversation.run(agent, model ?? null, title, t, t).lastInsertRowid);
  }

  conversation(id) { return this.q.conversation.get(id) || null; }
  conversations() { return this.q.conversations.all(); }
  setSession(id, session, model = null) { this.q.setSession.run(session, model, now(), id); }

  addMessage(conversationId, { role, text, cited = null, unknown = null }) {
    this.q.addMessage.run(conversationId, role, text,
      cited ? JSON.stringify(cited) : null, unknown ? JSON.stringify(unknown) : null, now());
  }

  messages(conversationId) {
    return this.q.messages.all(conversationId).map((m) => ({
      ...m, cited: m.cited ? JSON.parse(m.cited) : [], unknown: m.unknown ? JSON.parse(m.unknown) : [],
    }));
  }

  addSources(conversationId, sources) {
    transaction(this.db, () => {
      for (const s of sources) {
        this.q.addSource.run(conversationId, s.n, JSON.stringify(s.chunkIds), s.docId ?? null, s.docName,
          s.heading || '', s.pageFrom ?? null, s.pageTo ?? null, s.text);
      }
    });
  }

  sources(conversationId) {
    return this.q.sources.all(conversationId).map((s) => ({
      n: s.n, chunkIds: JSON.parse(s.chunk_ids), docId: s.doc_id, docName: s.doc_name,
      heading: s.heading, pageFrom: s.page_from, pageTo: s.page_to, text: s.text,
    }));
  }

  staleDocs(embeddedWith) { return this.q.stale.all(embeddedWith); }
  pendingDocs() { return this.q.pending.all(); }
  totals() { return this.q.totals.get(); }
}
