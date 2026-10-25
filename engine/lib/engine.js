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
import { chunk, chunkApart, targetFor } from './chunk.js';
import { Embedder, EmbedError, readSettings, writeSettings, signature, chunkInput, defaultPrefixes } from './embed.js';
import { VectorIndex } from './vectors.js';
import { hybridSearch, FIGURE_FLOOR } from './search.js';
import { readImage, readingBlocks, imageKey, READ_MODEL, READ_AT_ONCE, gate } from './reader.js';
import { toPng } from './extract/figures.js';
import { agentFolder, AgentError } from './agents/runner.js';

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

/* At most this many images read with new calls in one go, per document; the
 * rest wait for Read figures now (t-472dbed87a). */
export const READ_CAP = 50;

/* How many chunks are embedded and written per step: the most a Ctrl+C can
 * cost, and how often progress is reported. */
const STEP = 32;
const FIGURE_STEP = 4; // images, about 2.5 s each on the MX450 (t-6142c47b80)

export class Engine {
  static open(dataDir, options = {}) {
    if (!dataDir) throw new Error('No data folder given.');
    const dir = path.resolve(dataDir);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    return new Engine(dir, options);
  }

  /* figureFloor: how close a question must come to a figure - measured for
   * embeddinggemma-2 (t-525cbbd9a7); tests with a stand-in model lower it. */
  constructor(dir, { makeEmbedder = (s) => new Embedder(s), figureFloor = FIGURE_FLOOR, readerOptions = {}, readCap = READ_CAP, readAtOnce = READ_AT_ONCE } = {}) {
    this.figureFloor = figureFloor;
    this.readCap = readCap;
    this.readAtOnce = readAtOnce;
    this.readGate = gate(readAtOnce);
    // How Claude is run to read images; tests point it at a stand-in.
    this.readerOptions = readerOptions;
    this.dir = dir;
    this.store = new Store(path.join(dir, 'rag.db'));
    // An index from before the size was kept per model measured it with the model set then.
    if (this.store.getMeta('embed_dim', null) && !this.store.getMeta('embed_dim_model', null)) {
      this.store.setMeta('embed_dim_model', readSettings(this.store).model);
    }
    this.makeEmbedder = makeEmbedder;
    this.embedder = this.withKnownDim(makeEmbedder(readSettings(this.store)));
    this.index = null;
    this.figureIndex = undefined; // built on first search; undefined until then
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

  /* Reading images with Claude: on unless turned off, Haiku unless named
   * (t-d2b967c01a). */
  readingSettings() {
    return { readFigures: this.store.getMeta('read_figures', 'on') !== 'off', readModel: this.store.getMeta('read_model', '') || READ_MODEL };
  }

  /* How chunks are sized for this document: from the model's window, less the
   * "document > heading" line and the document prefix embedded with each. */
  async chunkOptions(doc) {
    const target = targetFor(await this.windowTokens());
    return { target, reserve: (heading) => this.embedder.docPrefix.length + chunkInput(doc.name, heading, '').length };
  }

  fileOf(doc) { return path.join(this.dir, 'files', doc.sha256 + doc.ext); }

  figuresDir(docId) { return path.join(this.dir, 'figures', String(docId)); }

  /* A figure's PNG on disk; null for a figure the store does not know. */
  figurePath(figure) { return figure ? path.join(this.dir, figure.file) : null; }

  /* A document's figures as PNG files under figures/<doc>/ and rows in the
   * store, replacing what an earlier reading left. */
  saveFigures(docId, figures) {
    const dir = this.figuresDir(docId);
    this.figureIndex = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    if (figures.length) fs.mkdirSync(dir, { recursive: true });
    const rows = figures.map((f, i) => {
      const file = path.join('figures', String(docId), `${i + 1}.png`);
      fs.writeFileSync(path.join(this.dir, file), f.png);
      return { ...f, file: file.split(path.sep).join('/') };
    });
    return this.store.replaceFigures(docId, rows);
  }

  /* Adds one file. A file already indexed (same bytes, any name) is not added
   * twice; one an earlier run left half-done is finished. Never throws for a
   * bad document - the result says what happened to it. */
  /* name and sourcePath default to the file's own; an upload passes the name
   * it was sent under and no source path, since its file is a temporary. */
  async ingest(filePath, { onProgress = () => {}, name = null, sourcePath, origin = null } = {}) {
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
    // The same bytes are the same document, whichever way they came in (t-9406918dd3).
    if (known && origin && known.origin !== origin) this.store.setOrigin(known.id, origin);
    if (known && known.status === STATUS.ready) return { status: 'exists', doc: this.store.doc(known.id) };

    let id;
    if (known) id = known.id;
    else {
      const copy = path.join(this.dir, 'files', sha256 + ext);
      if (!fs.existsSync(copy)) fs.writeFileSync(copy, buf);
      id = this.store.addDoc({ sha256, name: shown, ext, sourcePath: sourcePath === undefined ? abs : sourcePath, bytes: buf.length, origin });
    }
    return this.process(id, { onProgress, label: known ? 'resumed' : 'added' });
  }

  async resume({ onProgress = () => {} } = {}) {
    const out = [];
    for (const doc of this.store.pendingDocs()) out.push(await this.process(doc.id, { onProgress, label: 'resumed' }));
    return out;
  }

  /* A new document's figures are read with new calls; a document rebuilt -
   * re-indexed, re-embedded, resumed - takes only readings already kept, so
   * the library is never read again without the user asking (t-072171490b). */
  async process(id, { onProgress = () => {}, label = 'added' } = {}) {
    const readMode = label === 'added' ? 'call' : 'kept';
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
      built = { ...built, ...(await this.readFigures(doc, { mode: readMode, say, stats })) };
      this.store.setReady(id, sig);
      doc = this.store.doc(id);
      this.indexAdd(id);
      say('ready', doc.chunks, doc.chunks);
      return { status: label, doc, ...built, timings: timingsOf(stats, started) };
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
      return { status: 'error', doc, error: e.message, code: e.code, timings: timingsOf(stats, started) };
    }
  }

  /* Read a ready document's figures that are not read yet, now: up to
   * READ_CAP with new calls, the rest on the next press, even with reading
   * off since the user asked (t-a800ea33b6). Only their readings are
   * embedded - nothing else of the document is touched. */
  async readNow(id, { onProgress = () => {} } = {}) {
    let doc = this.store.doc(id);
    if (!doc) throw new EngineError('not-found', `No document with id ${id}.`);
    if (doc.status !== STATUS.ready) throw new EngineError('not-ready', `${doc.name} is not ready yet.`);
    const say = (phase, done, total) => onProgress({ doc, phase, done, total });
    const started = Date.now();
    const stats = {};
    const r = await this.readFigures(doc, { mode: 'call', say, stats, asked: true });
    this.store.setReady(id, this.embedder.signature);
    doc = this.store.doc(id);
    this.indexAdd(id);
    say('ready', doc.chunks, doc.chunks);
    return { status: 'read', doc, ...r, timings: timingsOf(stats, started) };
  }

  /* A document's figures not read yet: each from its kept reading - used even
   * with reading off, since it costs nothing (t-e5f5f1e696) - or, in 'call'
   * mode with reading on, read now with Claude - at most READ_CAP of them. Readings are appended as chunks of their own and embedded. A
   * failed reading - Claude not logged in, at its limit, timing out - stops
   * the reading but never fails the document; its figures stay not read
   * (t-64a996ef5a). Stop is honoured between readings. */
  async readFigures(doc, { mode = 'kept', say = () => {}, stats = {}, asked = false } = {}) {
    const todo = this.store.docFigures(doc.id).filter((f) => !f.read);
    if (!todo.length) return { read: 0, unread: 0, readError: null };
    const { readFigures: on, readModel } = this.readingSettings();
    const calling = mode === 'call' && (on || asked);
    const exe = this.store.getMeta('claude_path', '') || null;
    const readings = new Array(todo.length).fill(null);
    let calls = 0;
    let readError = null;
    let done = 0;
    let next = 0;
    say('reading', 0, todo.length);
    /* Up to READ_AT_ONCE workers take the figures in turn; the gate is the
     * engine's, so readings for NoteX share the same slots (t-a5d9223798).
     * A call is counted before it starts, so the cap holds with several in
     * flight. */
    const worker = async () => {
      while (next < todo.length) {
        const i = next++;
        if (this.stopRequested) throw new EngineError('stopped', 'Stopped; figures not read yet wait for Read figures now.');
        const png = fs.readFileSync(path.join(this.dir, todo[i].file));
        let reading = this.store.reading(imageKey(png), readModel);
        if (reading) stats.readCached = (stats.readCached || 0) + 1;
        else if (calling && !readError && calls < this.readCap) {
          calls++;
          try {
            reading = await this.readGate.run(() => readImage(png, { store: this.store, model: readModel, cwd: agentFolder(this.dir), executable: exe, agentOptions: this.readerOptions, stats }));
          } catch (e) {
            if (!(e instanceof AgentError)) throw e;
            readError = readError || e.message;
          }
        }
        if (reading) { readings[i] = reading; done++; }
        say('reading', done, todo.length);
      }
    };
    const runs = await Promise.allSettled(Array.from({ length: Math.min(this.readAtOnce, todo.length) }, worker));
    const failed = runs.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;

    // In figure order, whichever finished first.
    const items = [];
    const readIds = [];
    for (const [i, f] of todo.entries()) {
      const reading = readings[i];
      if (!reading) continue;
      const scan = f.kind === 'page';
      const heading = scan ? `Scanned page ${f.page}` : `${f.caption || (f.page ? `Figure on page ${f.page}` : 'Figure')} (read from the image)`;
      const blocks = readingBlocks(reading, { page: f.page, scan });
      if (blocks.length) items.push({ heading: f.heading && !scan ? `${f.heading} > ${heading}` : heading, figureId: f.id, blocks });
      readIds.push(f.id);
    }
    if (items.length) {
      const chunks = chunkApart(items, await this.chunkOptions(doc));
      this.store.appendChunks(doc.id, chunks);
      this.store.setEmbedding(doc.id, this.embedder.signature);
    }
    // Marked read only once its reading is in the document's chunks.
    for (const id of readIds) this.store.setFigureRead(id);
    if (items.length) await this.embedMissing(doc, say, stats);
    return { read: done, unread: todo.length - done, readError };
  }

  /* One image sent on its own - NoteX's, from a File Fabric canvas - read
   * with the reading settings and kept by its content like any reading. It
   * is asked for, so it is read even with reading off, and nothing of it is
   * stored but the reading (t-2a6293f2b7, t-1729ca9023). */
  async readOne(buf, { stats = {} } = {}) {
    const img = await toPng(buf);
    if (!img) throw new EngineError('bad-image', 'The image could not be read - send a PNG, JPEG, WebP or GIF file.');
    const { readModel } = this.readingSettings();
    const exe = this.store.getMeta('claude_path', '') || null;
    const kept = this.store.reading(imageKey(img.png), readModel);
    if (kept) return { ...kept, model: readModel, cached: true };
    const r = await this.readGate.run(() => readImage(img.png, { store: this.store, model: readModel, cwd: agentFolder(this.dir), executable: exe, agentOptions: this.readerOptions, stats }));
    return { ...r, model: readModel };
  }

  /* The model's context length, asked of Ollama once per model. */
  async windowTokens() {
    if (this.embedder.ctx === undefined) await this.embedder.describe();
    return this.embedder.ctx;
  }

  async build(doc, say, stats = null) {
    this.store.setStatus(doc.id, STATUS.extracting);
    say('extracting');
    const { blocks, pages, figures, figureError, links } = await extract(fs.readFileSync(this.fileOf(doc)), doc.ext);
    this.store.replaceLinked(doc.id, links);
    this.store.setPages(doc.id, pages);
    const saved = this.saveFigures(doc.id, figures);
    const found = { figures: saved.length, figureError: figureError || null };
    // A document of figures alone - an image file, a scan - has no text to chunk.
    if (!blocks.some((b) => b.text.trim())) {
      if (this.index) this.index.remove(this.store.docChunkIds(doc.id));
      this.store.replaceChunks(doc.id, []);
      this.store.setEmbedding(doc.id, this.embedder.signature);
      await this.embedMissing(doc, say, stats);
      return { target: null, rechunked: 0, ...found };
    }
    // The "document > heading" line and the model's document prefix are
    // embedded with every chunk, so they come out of the same budget (t-2717ac3c99).
    const { target: first, reserve } = await this.chunkOptions(doc);
    let lastError;
    for (const [tries, scale] of FALLBACK.entries()) {
      const target = Math.round(first * scale);
      const chunks = chunk(blocks, { target, reserve });
      if (!chunks.length && !saved.length) throw new ExtractError('empty', 'The document has no text outside its headings.');
      if (this.index) this.index.remove(this.store.docChunkIds(doc.id));
      this.store.replaceChunks(doc.id, chunks);
      this.store.setEmbedding(doc.id, this.embedder.signature);
      try {
        await this.embedMissing(doc, say, stats);
        return { target, rechunked: tries, ...found };
      } catch (e) {
        if (!(e instanceof EmbedError && e.code === 'too-long')) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  /* Whether the model can embed images, asked of Ollama once per model. */
  async canSee() {
    if (this.embedder.vision === undefined) await this.embedder.describe();
    return this.embedder.vision;
  }

  /* Chunks first, then figures, each picked up where an interrupted run left
   * off. A model that cannot see images leaves figures stored but without
   * vectors, so they are not searched until a model that can embeds them
   * (t-99e7177c73). */
  async embedMissing(doc, say, stats = null) {
    const todo = this.store.unembedded(doc.id);
    const figures = (await this.canSee()) ? this.store.unembeddedFigures(doc.id) : [];
    const chunkTotal = this.store.docChunkIds(doc.id).length;
    const figureTotal = figures.length ? this.store.docFigureIds(doc.id).length : 0;
    const total = chunkTotal + figureTotal;
    let done = total - todo.length - figures.length;
    say('embedding', done, total);
    const stop = () => { if (this.stopRequested) throw new EngineError('stopped', 'Stopped; the rest is embedded on the next start.'); };
    for (let i = 0; i < todo.length; i += STEP) {
      stop();
      const part = todo.slice(i, i + STEP);
      const vectors = await this.embedder.embedDocuments(part.map((c) => chunkInput(doc.name, c.heading, c.text)), stats);
      this.store.putVectors(part.map((c, j) => ({ id: c.id, vector: vectors[j] })));
      done += part.length;
      say('embedding', done, total);
    }
    for (let i = 0; i < figures.length; i += FIGURE_STEP) {
      stop();
      const part = figures.slice(i, i + FIGURE_STEP);
      const vectors = await this.embedder.embedImages(part.map((f) => fs.readFileSync(path.join(this.dir, f.file))), stats);
      this.store.putFigureVectors(part.map((f, j) => ({ id: f.id, vector: vectors[j] })));
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

  /* Figures are few beside chunks, so their index is simply built again on
   * the next search whenever any document's figures change. */
  loadFigureIndex() {
    if (this.figureIndex !== undefined) return this.figureIndex;
    let index = null;
    for (const { id, vector } of this.store.figureVectors(this.embedder.signature)) {
      if (!index) index = new VectorIndex(vector.length);
      index.add(id, vector);
    }
    this.figureIndex = index;
    return index;
  }

  indexAdd(docId) {
    this.figureIndex = undefined;
    if (!this.index) return;
    for (const { id, vector } of this.store.docVectors(docId)) this.index.add(id, vector);
  }

  /* Search refuses to mix vectors from two models: after the setting changes
   * every document must be re-embedded first (t-8e7cd345f4). If Ollama is not
   * answering, keyword search still runs, and the result says so
   * (t-e5bb354516). */
  /* docIds: only these documents, or null for all. Ids of documents since
   * removed simply drop out; none left means nothing is searched, never
   * everything (t-6fbca7a8a6). */
  async search(question, { k = 8, docIds = null } = {}) {
    if (docIds) {
      docIds = [...new Set(docIds.map(Number))].filter((id) => this.store.doc(id));
      if (!docIds.length) return { passages: [], warning: null, timings: { embedMs: 0, loadMs: 0, searchMs: 0 } };
    }
    const stale = this.store.staleDocs(this.embedder.signature);
    if (stale.length) {
      throw new EngineError('needs-reembed',
        `${stale.length} document(s) were embedded with ${stale[0].embedded_with}, not ${this.embedder.signature} - run "reembed" first.`);
    }
    const index = this.loadIndex();
    const figureIndex = this.loadFigureIndex();
    let queryVector = null;
    let warning = null;
    const stats = {};
    if (index || figureIndex) {
      try {
        queryVector = await this.embedder.embedQuery(question, stats);
      } catch (e) {
        if (!(e instanceof EmbedError)) throw e;
        warning = `Keyword search only - ${e.message}`;
      }
    }
    const t = Date.now();
    const passages = hybridSearch({ store: this.store, index, figureIndex, question, queryVector, k, figureFloor: this.figureFloor, docIds });
    return { passages, warning, timings: { embedMs: stats.ms || 0, loadMs: stats.loadMs || 0, searchMs: Date.now() - t } };
  }

  /* The model is checked with Ollama before it is saved, so a typo or a chat
   * model never becomes the setting. Changing the model or the document
   * prefix leaves every ready document stale until reembed. */
  async setModel({ model, queryPrefix, docPrefix }) {
    // Prefixes not given are the model's own (t-64e566c572).
    const d = defaultPrefixes(model);
    queryPrefix ??= d.queryPrefix;
    docPrefix ??= d.docPrefix;
    const next = this.withKnownDim(this.makeEmbedder({ model, queryPrefix, docPrefix }));
    const info = await next.describe();
    writeSettings(this.store, { model, queryPrefix, docPrefix });
    this.embedder = next;
    this.index = null;
    this.figureIndex = undefined;
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
    fs.rmSync(this.figuresDir(id), { recursive: true, force: true });
    this.figureIndex = undefined;
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

/* A run's timings, for the result and the tracker. */
function timingsOf(stats, started) {
  return {
    ms: Date.now() - started, embedMs: stats.ms || 0, imageMs: stats.imageMs || 0, images: stats.images || 0, loadMs: stats.loadMs || 0,
    readMs: stats.readMs || 0, reads: stats.reads || 0, readCached: stats.readCached || 0,
  };
}
