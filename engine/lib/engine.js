/* The engine: one data folder, everything the pipeline does to it.
 *
 *   ingest   file -> copy -> extract -> chunk -> embed -> ready
 *   resume   finish what an interrupted run left half-done
 *   search   question -> hybrid search -> passages
 *   setModel / reembed   change the embedding model, then rebuild every vector
 *
 * The pipeline is written out here rather than assembled from a framework
 * (t-cc3952e29f).
 *
 * The data folder is given, never guessed. It holds rag.db and files/, a copy
 * of every document under its SHA-256, so re-extracting never depends on the
 * original still being where it was (t-8af248a304).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store, STATUS } from './store.js';
import { extract, ExtractError, SUPPORTED } from './extract/index.js';
import { chunk, TARGET } from './chunk.js';
import { Embedder, EmbedError, readSettings, writeSettings, signature, chunkInput } from './embed.js';
import { VectorIndex } from './vectors.js';
import { hybridSearch } from './search.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code; // needs-reembed | not-found
  }
}

/* When a chunk is too long for the model - dense tables and numbers cost
 * more tokens per character than prose - the whole document is chunked
 * again, smaller, rather than one chunk being cut (t-364fe5c674). */
const CHUNK_TARGETS = [TARGET, Math.round(TARGET * 0.7), Math.round(TARGET * 0.5)];

/* How many chunks are embedded and written per step: the most a Ctrl+C can
 * cost, and how often progress is reported. */
const STEP = 32;

export class Engine {
  static open(dataDir, options = {}) {
    if (!dataDir) throw new Error('No data folder given.');
    const dir = path.resolve(dataDir);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    return new Engine(dir, options);
  }

  constructor(dir, { makeEmbedder = (s) => new Embedder(s) } = {}) {
    this.dir = dir;
    this.store = new Store(path.join(dir, 'rag.db'));
    this.makeEmbedder = makeEmbedder;
    this.embedder = makeEmbedder(readSettings(this.store));
    this.index = null;
  }

  close() { this.store.close(); }

  settings() { return readSettings(this.store); }

  fileOf(doc) { return path.join(this.dir, 'files', doc.sha256 + doc.ext); }

  /* Adds one file. A file already indexed (same bytes, any name) is not added
   * twice; one an earlier run left half-done is finished. Never throws for a
   * bad document - the result says what happened to it. */
  async ingest(filePath, { onProgress = () => {} } = {}) {
    const abs = path.resolve(filePath);
    const ext = path.extname(abs).toLowerCase();
    if (!SUPPORTED.includes(ext)) {
      return { status: 'error', name: path.basename(abs), error: `${ext || 'This file type'} is not supported - use ${SUPPORTED.join(', ')}.` };
    }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) {
      return { status: 'error', name: path.basename(abs), error: `Cannot read ${abs}: ${e.code || e.message}` };
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const known = this.store.docBySha(sha256);
    if (known && known.status === STATUS.ready) return { status: 'exists', doc: known };

    let id;
    if (known) id = known.id;
    else {
      const copy = path.join(this.dir, 'files', sha256 + ext);
      if (!fs.existsSync(copy)) fs.writeFileSync(copy, buf);
      id = this.store.addDoc({ sha256, name: path.basename(abs), ext, sourcePath: abs, bytes: buf.length });
    }
    return this.process(id, { onProgress, label: known ? 'resumed' : 'added' });
  }

  async resume({ onProgress = () => {} } = {}) {
    const out = [];
    for (const doc of this.store.pendingDocs()) out.push(await this.process(doc.id, { onProgress, label: 'resumed' }));
    return out;
  }

  async process(id, { onProgress = () => {}, label = 'added' } = {}) {
    let doc = this.store.doc(id);
    const sig = this.embedder.signature;
    const say = (phase, done, total) => onProgress({ doc, phase, done, total });
    try {
      /* A run cut short while embedding, with this same model, picks up at
       * the first chunk without a vector. Anything else starts over
       * (t-b1b91e9fd2). */
      const canResume = doc.status === STATUS.embedding && doc.embedded_with === sig && this.store.docChunkIds(id).length > 0;
      if (canResume) await this.embedMissing(doc, say);
      else await this.build(doc, say);
      this.store.setReady(id, sig);
      doc = this.store.doc(id);
      this.indexAdd(id);
      say('ready', doc.chunks, doc.chunks);
      return { status: label, doc };
    } catch (e) {
      /* A document that cannot be read is in error for good. Ollama stopped,
       * or the model not pulled, leaves the status as it was, so the next
       * run resumes instead of starting again. */
      const permanent = e instanceof ExtractError || (e instanceof EmbedError && e.code === 'too-long');
      if (permanent) this.store.setStatus(id, STATUS.error, e.message);
      else this.store.setError(id, e.message);
      doc = this.store.doc(id);
      say('error');
      return { status: 'error', doc, error: e.message, code: e.code };
    }
  }

  async build(doc, say) {
    this.store.setStatus(doc.id, STATUS.extracting);
    say('extracting');
    const { blocks, pages } = await extract(fs.readFileSync(this.fileOf(doc)), doc.ext);
    this.store.setPages(doc.id, pages);
    let lastError;
    for (const target of CHUNK_TARGETS) {
      const chunks = chunk(blocks, { target });
      if (!chunks.length) throw new ExtractError('empty', 'The document has no text outside its headings.');
      if (this.index) this.index.remove(this.store.docChunkIds(doc.id));
      this.store.replaceChunks(doc.id, chunks);
      this.store.setEmbedding(doc.id, this.embedder.signature);
      try {
        await this.embedMissing(doc, say);
        return;
      } catch (e) {
        if (!(e instanceof EmbedError && e.code === 'too-long')) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  async embedMissing(doc, say) {
    const todo = this.store.unembedded(doc.id);
    const total = this.store.docChunkIds(doc.id).length;
    let done = total - todo.length;
    say('embedding', done, total);
    for (let i = 0; i < todo.length; i += STEP) {
      const part = todo.slice(i, i + STEP);
      const vectors = await this.embedder.embedDocuments(part.map((c) => chunkInput(doc.name, c.heading, c.text)));
      this.store.putVectors(part.map((c, j) => ({ id: c.id, vector: vectors[j] })));
      done += part.length;
      say('embedding', done, total);
    }
    if (this.embedder.dim) this.store.setMeta('embed_dim', this.embedder.dim);
  }

  /* The vector index is built on first search from every vector the current
   * signature made, and kept up to date as documents come and go. */
  loadIndex() {
    if (this.index) return this.index;
    const sig = this.embedder.signature;
    let index = null;
    for (const { id, vector } of this.store.vectors(sig)) {
      if (!index) index = new VectorIndex(vector.length);
      index.add(id, vector);
    }
    this.index = index;
    return index;
  }

  indexAdd(docId) {
    if (!this.index) return;
    for (const { id, vector } of this.store.docVectors(docId)) this.index.add(id, vector);
  }

  /* Search refuses to mix vectors from two models: after the setting changes
   * every document must be re-embedded first (t-8e7cd345f4). If Ollama is not
   * answering, keyword search still runs, and the result says so
   * (t-e5bb354516). */
  async search(question, { k = 8 } = {}) {
    const stale = this.store.staleDocs(this.embedder.signature);
    if (stale.length) {
      throw new EngineError('needs-reembed',
        `${stale.length} document(s) were embedded with ${stale[0].embedded_with}, not ${this.embedder.signature} - run "reembed" first.`);
    }
    const index = this.loadIndex();
    let queryVector = null;
    let warning = null;
    if (index) {
      try {
        queryVector = await this.embedder.embedQuery(question);
      } catch (e) {
        if (!(e instanceof EmbedError)) throw e;
        warning = `Keyword search only - ${e.message}`;
      }
    }
    const passages = hybridSearch({ store: this.store, index, question, queryVector, k });
    return { passages, warning };
  }

  /* The model is checked with Ollama before it is saved, so a typo or a chat
   * model never becomes the setting. Changing the model or the document
   * prefix leaves every ready document stale until reembed. */
  async setModel({ model, queryPrefix = '', docPrefix = '' }) {
    const next = this.makeEmbedder({ model, queryPrefix, docPrefix });
    const info = await next.describe();
    writeSettings(this.store, { model, queryPrefix, docPrefix });
    if (info.dim) this.store.setMeta('embed_dim', info.dim);
    this.embedder = next;
    this.index = null;
    return { ...info, stale: this.store.staleDocs(signature({ model, docPrefix })).length };
  }

  async reembed({ onProgress = () => {} } = {}) {
    const out = [];
    for (const doc of this.store.staleDocs(this.embedder.signature)) {
      out.push(await this.process(doc.id, { onProgress, label: 'reembedded' }));
    }
    return out;
  }

  remove(id) {
    const doc = this.store.doc(id);
    if (!doc) throw new EngineError('not-found', `No document with id ${id}.`);
    const chunkIds = this.store.docChunkIds(id);
    this.store.removeDoc(id);
    if (this.index) this.index.remove(chunkIds);
    fs.rmSync(this.fileOf(doc), { force: true });
    return doc;
  }

  list() { return this.store.docs(); }

  stats() {
    const db = path.join(this.dir, 'rag.db');
    return {
      ...this.store.totals(),
      ...this.settings(),
      signature: this.embedder.signature,
      dim: Number(this.store.getMeta('embed_dim', 0)) || null,
      bytes: fs.existsSync(db) ? fs.statSync(db).size : 0,
      dir: this.dir,
    };
  }
}
