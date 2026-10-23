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
import { chunk, targetFor } from './chunk.js';
import { Embedder, EmbedError, readSettings, writeSettings, signature, chunkInput } from './embed.js';
import { VectorIndex } from './vectors.js';
import { hybridSearch } from './search.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code; // needs-reembed | not-found | stopped
  }
}

/* Chunks start at the size the model's window holds for dense text. When
 * one is still refused as too long, the whole document is chunked again,
 * smaller, rather than one chunk being cut (t-364fe5c674) - a safety net, no
 * longer the usual path (t-f224d18ac0). */
const FALLBACK = [1, 0.7, 0.5];

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
    // An index from before the size was kept per model measured it with the model set then.
    if (this.store.getMeta('embed_dim', null) && !this.store.getMeta('embed_dim_model', null)) {
      this.store.setMeta('embed_dim_model', readSettings(this.store).model);
    }
    this.makeEmbedder = makeEmbedder;
    this.embedder = this.withKnownDim(makeEmbedder(readSettings(this.store)));
    this.index = null;
    this.stopRequested = false; // set by a server stopping; ingest ends at its next step
  }

  close() { this.store.close(); }

  /* The vector size this model was measured to return, kept with the model's
   * name so a vector of another size is still caught after a restart
   * (t-ab9179da22). */
  withKnownDim(embedder) {
    if (this.store.getMeta('embed_dim_model', null) === embedder.model) {
      embedder.dim = Number(this.store.getMeta('embed_dim', 0)) || null;
    }
    return embedder;
  }

  knownDim() {
    return this.store.getMeta('embed_dim_model', null) === this.embedder.model ? Number(this.store.getMeta('embed_dim', 0)) || null : null;
  }

  settings() { return readSettings(this.store); }

  fileOf(doc) { return path.join(this.dir, 'files', doc.sha256 + doc.ext); }

  /* Adds one file. A file already indexed (same bytes, any name) is not added
   * twice; one an earlier run left half-done is finished. Never throws for a
   * bad document - the result says what happened to it. */
  /* name and sourcePath default to the file's own; an upload passes the name
   * it was sent under and no source path, since its file is a temporary. */
  async ingest(filePath, { onProgress = () => {}, name = null, sourcePath } = {}) {
    const abs = path.resolve(filePath);
    const shown = name || path.basename(abs);
    const ext = path.extname(shown).toLowerCase();
    if (!SUPPORTED.includes(ext)) {
      return { status: 'error', name: shown, error: `${ext || 'This file type'} is not supported - use ${SUPPORTED.join(', ')}.` };
    }
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) {
      return { status: 'error', name: shown, error: `Cannot read ${abs}: ${e.code || e.message}` };
    }
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const known = this.store.docBySha(sha256);
    if (known && known.status === STATUS.ready) return { status: 'exists', doc: known };

    let id;
    if (known) id = known.id;
    else {
      const copy = path.join(this.dir, 'files', sha256 + ext);
      if (!fs.existsSync(copy)) fs.writeFileSync(copy, buf);
      id = this.store.addDoc({ sha256, name: shown, ext, sourcePath: sourcePath === undefined ? abs : sourcePath, bytes: buf.length });
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
    const started = Date.now();
    const stats = {}; // embedding time, model load time and tokens, for the tracker
    try {
      /* A run cut short while embedding, with this same model, picks up at
       * the first chunk without a vector. Anything else starts over
       * (t-b1b91e9fd2). */
      const canResume = doc.status === STATUS.embedding && doc.embedded_with === sig && this.store.docChunkIds(id).length > 0;
      let built = { target: null, rechunked: 0 };
      if (canResume) await this.embedMissing(doc, say, stats);
      else built = await this.build(doc, say, stats);
      this.store.setReady(id, sig);
      doc = this.store.doc(id);
      this.indexAdd(id);
      say('ready', doc.chunks, doc.chunks);
      return { status: label, doc, ...built, timings: { ms: Date.now() - started, embedMs: stats.ms || 0, loadMs: stats.loadMs || 0 } };
    } catch (e) {
      /* A document that cannot be read is in error for good. Ollama stopped,
       * or the model not pulled, leaves the status as it was, so the next
       * run resumes instead of starting again. */
      // A stop between steps is not permanent either: the rest resumes.
      const permanent = e instanceof ExtractError || (e instanceof EmbedError && e.code === 'too-long');
      if (permanent) this.store.setStatus(id, STATUS.error, e.message);
      else this.store.setError(id, e.message);
      doc = this.store.doc(id);
      say('error');
      return { status: 'error', doc, error: e.message, code: e.code, timings: { ms: Date.now() - started, embedMs: stats.ms || 0, loadMs: stats.loadMs || 0 } };
    }
  }

  /* The model's context length, asked of Ollama once per model. */
  async windowTokens() {
    if (this.embedder.ctx === undefined) await this.embedder.describe();
    return this.embedder.ctx;
  }

  async build(doc, say, stats = null) {
    this.store.setStatus(doc.id, STATUS.extracting);
    say('extracting');
    const { blocks, pages } = await extract(fs.readFileSync(this.fileOf(doc)), doc.ext);
    this.store.setPages(doc.id, pages);
    const first = targetFor(await this.windowTokens());
    // The "document > heading" line is embedded with every chunk, so it
    // comes out of the same budget.
    const reserve = (heading) => chunkInput(doc.name, heading, '').length;
    let lastError;
    for (const [tries, scale] of FALLBACK.entries()) {
      const target = Math.round(first * scale);
      const chunks = chunk(blocks, { target, reserve });
      if (!chunks.length) throw new ExtractError('empty', 'The document has no text outside its headings.');
      if (this.index) this.index.remove(this.store.docChunkIds(doc.id));
      this.store.replaceChunks(doc.id, chunks);
      this.store.setEmbedding(doc.id, this.embedder.signature);
      try {
        await this.embedMissing(doc, say, stats);
        return { target, rechunked: tries };
      } catch (e) {
        if (!(e instanceof EmbedError && e.code === 'too-long')) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  async embedMissing(doc, say, stats = null) {
    const todo = this.store.unembedded(doc.id);
    const total = this.store.docChunkIds(doc.id).length;
    let done = total - todo.length;
    say('embedding', done, total);
    for (let i = 0; i < todo.length; i += STEP) {
      if (this.stopRequested) throw new EngineError('stopped', 'Stopped; the rest is embedded on the next start.');
      const part = todo.slice(i, i + STEP);
      const vectors = await this.embedder.embedDocuments(part.map((c) => chunkInput(doc.name, c.heading, c.text)), stats);
      this.store.putVectors(part.map((c, j) => ({ id: c.id, vector: vectors[j] })));
      done += part.length;
      say('embedding', done, total);
    }
    if (this.embedder.dim) {
      this.store.setMeta('embed_dim', this.embedder.dim);
      this.store.setMeta('embed_dim_model', this.embedder.model);
    }
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
    const stats = {};
    if (index) {
      try {
        queryVector = await this.embedder.embedQuery(question, stats);
      } catch (e) {
        if (!(e instanceof EmbedError)) throw e;
        warning = `Keyword search only - ${e.message}`;
      }
    }
    const t = Date.now();
    const passages = hybridSearch({ store: this.store, index, question, queryVector, k });
    return { passages, warning, timings: { embedMs: stats.ms || 0, loadMs: stats.loadMs || 0, searchMs: Date.now() - t } };
  }

  /* The model is checked with Ollama before it is saved, so a typo or a chat
   * model never becomes the setting. Changing the model or the document
   * prefix leaves every ready document stale until reembed. */
  async setModel({ model, queryPrefix = '', docPrefix = '' }) {
    const next = this.withKnownDim(this.makeEmbedder({ model, queryPrefix, docPrefix }));
    const info = await next.describe();
    writeSettings(this.store, { model, queryPrefix, docPrefix });
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

  /* Read one document again from its copy: extract, chunk, embed. */
  async reindex(id, { onProgress = () => {} } = {}) {
    if (!this.store.doc(id)) throw new EngineError('not-found', `No document with id ${id}.`);
    return this.process(id, { onProgress, label: 'reindexed' });
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
      dim: this.knownDim(),
      bytes: fs.existsSync(db) ? fs.statSync(db).size : 0,
      dir: this.dir,
    };
  }
}
