/* The engine as a server for the ter-manager plugin.
 *
 *   node engine/cli.js --data-dir <folder> serve [--port 7780]
 *
 * It listens on loopback only and answers a request only when all three hold
 * (t-849cf3a311):
 *   - X-Rag-Token matches the token written to plugin/runtime.json at start.
 *     A custom header needs a CORS preflight, so another web page open in the
 *     browser cannot send it.
 *   - Origin, when a browser sends one, is ter-manager's own page.
 *   - Host is 127.0.0.1 or localhost on this port, so a hostile page that
 *     re-points its own domain at 127.0.0.1 (DNS rebinding) is refused
 *     (t-c025554671).
 *
 * Streams - an answer, ingest progress - are one JSON object per line, read
 * with fetch: EventSource cannot send the token header (t-758ad41ba4).
 *
 * Closing the plugin never stops it (t-531831588f). It stops on Ctrl+C in its
 * terminal or POST /api/shutdown, gracefully: answers in flight are ended,
 * every open agent closed, an ingest ends at its next step to resume later,
 * the database closed, the lock and runtime.json removed (ter-manager's rule:
 * a forced stop orphans what the server owned) (t-3d3286e9ec).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Engine, EngineError } from './engine.js';
import { EmbedError } from './embed.js';
import { ask, AskError, AGENTS } from './answer.js';
import { AgentError, agentFolder, findExecutable, setTracker } from './agents/runner.js';
import { AgySession } from './agents/agy.js';
import { AgentPool } from './agents/pool.js';
import { takeLock, agentRecord, endOrphans, writeRuntime, writeLocal } from './lifecycle.js';
import { OllamaControl } from './ollama.js';
import { Tracker, modelReader } from './tracker.js';
import { IMAGE_TYPES } from './extract/index.js';
import { notexFolder, notexFile, notexStatus } from './notex.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'package.json'), 'utf8')).version;
export const DEFAULT_PORT = 7780;
export const DEFAULT_ORIGINS = ['http://127.0.0.1:7070', 'http://localhost:7070'];
export const DEFAULT_RUNTIME = path.join(HERE, '..', '..', 'plugin', 'runtime.json');
const MAX_JSON = 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_IMAGE = 30 * 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/* An engine or agent failure, as the HTTP status and code the plugin acts on. */
function statusOf(e) {
  if (e instanceof HttpError) return e.status;
  const code = e && e.code;
  if (code === 'not-found') return 404;
  if (code === 'bad-image') return 400;
  if (code === 'busy' || code === 'wrong-agent' || code === 'needs-reembed' || code === 'pool-full') return 409;
  if (e instanceof EmbedError || e instanceof AgentError) return 503;
  if (e instanceof AskError) return 400;
  return 500;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'too-large', `The request is larger than ${limit} bytes.`)); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw new HttpError(400, 'bad-json', 'The request body is not JSON.'); }
}

/* Uploads stream straight to a file in the data folder, never held whole in
 * memory (t-5bf53eacb5). */
function saveUpload(req, file) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_UPLOAD) { req.destroy(); out.destroy(); fs.rmSync(file, { force: true }); reject(new HttpError(413, 'too-large', `Uploads are limited to ${MAX_UPLOAD / 1024 / 1024} MB.`)); }
    });
    req.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject);
    req.on('error', reject);
  });
}

export async function startServer({
  dataDir, port = DEFAULT_PORT, origins = DEFAULT_ORIGINS, runtimeFile = DEFAULT_RUNTIME,
  engineOptions = {}, agentOptions = {}, openAgy = null, poolOptions = {}, log = console.log, signals = true,
  onStopped = null, manageOllama = true, ollamaOptions = {}, sampleResources = true,
} = {}) {
  const engine = Engine.open(dataDir, engineOptions);
  // Images are read with the same Claude the answers use; tests give it the stand-in.
  if (agentOptions.claude && !engineOptions.readerOptions) engine.readerOptions = agentOptions.claude;
  const dir = engine.dir;
  const instance = crypto.randomBytes(8).toString('hex');
  let releaseLock;
  try { releaseLock = takeLock(dir, { startedAt: new Date().toISOString() }, instance); } catch (e) { engine.close(); throw e; }
  const orphans = endOrphans(dir);
  const record = agentRecord(dir);
  setTracker(record);

  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const emit = (event) => bus.emit('event', event);

  /* Ollama starts with the engine and, if the engine started it, stops with
   * it (t-b2ed74b05c). Recorded like an agent, so a hard kill's orphan is
   * ended on the next start. */
  const ollamaCtl = manageOllama ? new OllamaControl({ host: engine.embedder.host, tracker: record, ...ollamaOptions }) : null;
  let ollamaStart = null; // the ensure() in flight or done

  const pool = new AgentPool({
    open: openAgy || (({ resume, model }) => new AgySession({
      executable: engine.store.getMeta('agy_path', '') || null, resume, model, cwd: agentFolder(dir), ...(agentOptions.agy || {}),
    })),
    ...poolOptions,
  });
  let spareWanted = 0; // when the plugin last asked for a warm agy
  const refill = () => {
    if (Date.now() - spareWanted < pool.idleMs && !pool.hasSpare()) {
      const s = pool.warm({ model: engine.store.getMeta('agy_model', '') || null });
      if (s) emit({ type: 'pool', pool: pool.list() });
    }
  };

  /* Ingest runs one job at a time: Ollama is the bottleneck, and the engine
   * embeds 32 chunks a step either way (t-00a474ee4e). */
  /* Every call is recorded with who made it (t-acd3fa359a): the X-Rag-Client
   * header says - "plugin" for the page, "mcp:<agent>" for the RAGX tool -
   * and a request without one is "other" (t-e5c3b9093f). */
  const tracker = new Tracker(engine.store, { model: modelReader(engine.embedder.host, () => engine.embedder.model) });
  tracker.onLive(emit);
  const whoIs = (req) => {
    const client = String(req.headers['x-rag-client'] || '').slice(0, 300) || null;
    const source = !client ? 'other' : client === 'plugin' ? 'you' : client.startsWith('mcp') ? 'agent' : 'other';
    return { source, client };
  };
  const figureView = (f) => ({ id: f.id, docId: f.doc_id, docName: f.doc_name, kind: f.kind, page: f.page, caption: f.caption,
    heading: f.heading, anchor: f.anchor, width: f.width, height: f.height, read: Boolean(f.read), reading: engine.store.figureReading(f.id) || null });
  const passageDetail = (p) => ({ n: p.n, docName: p.docName, heading: p.heading, pageFrom: p.pageFrom, pageTo: p.pageTo, score: p.score, chunkIds: p.chunkIds, text: p.text,
    figureId: p.figureId ?? undefined, figures: p.figures && p.figures.length ? p.figures : undefined, reading: p.reading || undefined });

  const queue = [];
  let current = null;
  const onProgress = ({ doc, phase, done, total }) => {
    emit({ type: 'ingest', docId: doc && doc.id, name: doc && doc.name, phase, done, total });
    if (current && current.live) {
      tracker.phase(current.live, phase === 'embedding' && total ? `embedding ${done}/${total}` : phase === 'reading' && total ? `reading figures ${done}/${total}` : phase);
    }
  };
  const pump = async () => {
    if (current || !queue.length || stopping) return;
    current = queue.shift();
    emit({ type: 'queue', queue: queue.map((j) => j.label), current: current.label });
    current.live = tracker.begin({ ...current.who, question: current.label, phase: ollamaStart ? 'waiting for Ollama' : 'reading' });
    try {
      if (ollamaStart) await ollamaStart; // the first job after a start waits for Ollama
      const results = [].concat(await current.run());
      for (const [i, r] of results.entries()) {
        emit(r.status === 'error' ? { type: 'ingest-error', name: r.doc ? r.doc.name : r.name, error: r.error } : { type: 'doc', status: r.status, doc: r.doc, replaced: r.replaced || [], reused: r.reused ?? null });
        const t = r.timings || {};
        tracker.record({
          run: i === 0 ? current.live : null, ms: t.ms ?? null, source: current.who.source, client: current.who.client, kind: current.who.kind,
          question: r.doc ? r.doc.name : r.name, timings: t, results: r.doc ? r.doc.chunks : 0,
          detail: { docId: r.doc && r.doc.id, status: r.status, pages: r.doc && r.doc.pages, chunks: r.doc && r.doc.chunks, rechunked: r.rechunked || 0,
            figures: r.figures ?? (r.doc && r.doc.figures) ?? 0, figureError: r.figureError || undefined,
            read: r.read || undefined, unread: r.unread || undefined, readError: r.readError || undefined },
          error: r.status === 'error' ? r.error : null,
        });
      }
    } catch (e) {
      emit({ type: 'ingest-error', name: current.label, error: e.message });
      tracker.record({ run: current.live, source: current.who.source, client: current.who.client, kind: current.who.kind, question: current.label, error: e.message });
    } finally {
      tracker.drop(current.live); // a job that produced no result
      if (current.cleanup) current.cleanup();
      current = null;
      emit({ type: 'queue', queue: queue.map((j) => j.label), current: null });
      pump();
    }
  };
  // Announced on joining, so a job waiting behind another shows (t-770d2af24b).
  // A file added as the new version of the documents with its name; the page hears of each one it replaced.
  const replacing = (file, opts = {}) => engine.ingestReplacing(file, {
    ...opts, onProgress, onRemoved: (old, doc) => emit({ type: 'removed', docId: old.id, name: old.name, replacedBy: doc.id }),
  });
  const enqueue = (label, run, cleanup, who = { source: 'engine', client: null, kind: 'ingest' }) => {
    queue.push({ label, run, cleanup, who });
    emit({ type: 'queue', queue: queue.map((j) => j.label), current: current ? current.label : null });
    pump();
    return queue.length + (current ? 1 : 0);
  };

  let ollama = { at: 0, value: null };
  const ollamaState = async () => {
    if (Date.now() - ollama.at < 10_000 && ollama.value) return ollama.value;
    let value;
    try {
      const info = await engine.embedder.describe();
      value = { state: 'up', model: info.model, dim: info.dim ?? engine.knownDim(), window: info.ctx, vision: Boolean(info.vision) };
    } catch (e) {
      value = { state: e.code === 'model-missing' ? 'model-missing' : e.code === 'ollama-down' ? 'down' : 'error', model: engine.embedder.model, error: e.message };
    }
    value.managed = Boolean(ollamaCtl);
    value.owned = Boolean(ollamaCtl && ollamaCtl.owned);
    if (ollamaCtl && ollamaCtl.startError) value.startError = ollamaCtl.startError;
    ollama = { at: Date.now(), value };
    return value;
  };
  const agentState = () => Object.fromEntries(Object.keys(AGENTS).map((name) => {
    try {
      const override = engine.store.getMeta(`${name}_path`, '') || null;
      const known = name === 'agy' && process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin')] : [];
      return [name, { found: true, path: findExecutable(name, { override, known }) }];
    } catch (e) { return [name, { found: false, error: e.message }]; }
  }));

  /* The folders the page may show linked images from, as the user listed
   * them in Settings. A path written in a document is only the document's
   * word, so nothing outside these is ever opened (t-1cfacc1b16). */
  const imageFolders = () => {
    try { const v = JSON.parse(engine.store.getMeta('image_folders', '[]')); return Array.isArray(v) ? v : []; } catch (_) { return []; }
  };
  const mayShow = (file) => {
    if (!IMAGE_TYPES.includes(path.extname(file).toLowerCase())) return false;
    const abs = path.resolve(file);
    return imageFolders().some((dir) => {
      const rel = path.relative(path.resolve(dir), abs);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  };

  const notexDir = () => notexFolder(dir, engine.store.getMeta('notex_docs', ''));

  /* Which documents a search or question is limited to: a list of document
   * ids, or null (or left out) for all of them (t-c323b2002a). */
  const docList = (docs) => {
    if (docs === null || docs === undefined) return null;
    if (!Array.isArray(docs) || docs.some((d) => !Number.isInteger(Number(d)))) throw new HttpError(400, 'bad-docs', 'docs is a list of document ids, or null for all.');
    return docs.map(Number);
  };

  const settings = () => ({
    ...engine.settings(),
    imageFolders: imageFolders(),
    notexDocs: notexDir(),
    notexDocsSet: engine.store.getMeta('notex_docs', '') || null,
    agent: engine.store.getMeta('agent', 'claude'),
    claudeModel: engine.store.getMeta('claude_model', '') || AGENTS.claude.DEFAULT_MODEL,
    agyModel: engine.store.getMeta('agy_model', '') || null,
    claudePath: engine.store.getMeta('claude_path', '') || null,
    agyPath: engine.store.getMeta('agy_path', '') || null,
    ...engine.readingSettings(),
  });

  const inflight = new Set(); // AbortControllers of answers being streamed
  const streams = new Set();  // open /api/events responses
  let stopping = false;
  let actualPort = port;
  let token = crypto.randomBytes(24).toString('base64url');
  const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);

  const routes = async (req, res, url) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const m = (method, pattern) => {
      if (req.method !== method) return null;
      const r = pattern.exec(url.pathname);
      return r ? r.slice(1) : null;
    };
    let p;

    if (m('GET', /^\/api\/state$/)) {
      return json(200, {
        version: VERSION, pid: process.pid, dataDir: dir, uptimeMs: Math.round(process.uptime() * 1000),
        ollama: await ollamaState(), agents: agentState(), settings: settings(),
        totals: engine.store.totals(), queue: queue.map((j) => j.label), ingesting: current ? current.label : null,
        pool: pool.list(), conversations: engine.store.conversations().length,
        // Documents embedded another way: search refuses them until they are re-embedded.
        stale: engine.store.staleDocs(engine.embedder.signature).length,
      });
    }

    if (m('GET', /^\/api\/docs$/)) {
      const docs = engine.list();
      // The page lists documents all the time; an agent asking is a call worth seeing (t-6df26b68a6).
      const who = whoIs(req);
      if (who.source === 'agent') tracker.record({ ...who, kind: 'documents', ms: 0, results: docs.length, detail: { docs: docs.map((d) => ({ id: d.id, name: d.name, status: d.status, pages: d.pages, chunks: d.chunks })) } });
      return json(200, { docs });
    }

    if (m('GET', /^\/api\/tracker\/summary$/)) {
      const range = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, all: Date.now() }[url.searchParams.get('range') || 'day'] || 86400e3;
      return json(200, tracker.summary(range));
    }
    if (m('GET', /^\/api\/tracker\/calls$/)) {
      const sp = url.searchParams;
      return json(200, { running: tracker.inProgress(), calls: tracker.calls({ limit: sp.get('limit'), before: sp.get('before'), since: sp.get('since'), source: sp.get('source'), kind: sp.get('kind') }) });
    }
    if ((p = m('GET', /^\/api\/tracker\/calls\/(\d+)$/))) {
      const c = tracker.call(Number(p[0]));
      if (!c) throw new HttpError(404, 'not-found', 'No such call.');
      return json(200, c);
    }
    if (m('DELETE', /^\/api\/tracker\/calls$/)) { tracker.clear(); return json(200, { cleared: true }); }
    if (m('GET', /^\/api\/tracker\/samples$/)) {
      const range = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[url.searchParams.get('range') || 'hour'] || 3600e3;
      return json(200, { samples: tracker.samples(range), now: tracker.last });
    }

    /* X-Replace: 1 (an upload) or replace: true (a path) adds the file as the
     * new version of the documents with its name - asked of the user by the
     * page first (t-b2385584f0). */
    if (m('POST', /^\/api\/docs$/)) {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || '')).trim();
      const replace = req.headers['x-replace'] === '1';
      if (!name || /[\\/]/.test(name)) throw new HttpError(400, 'bad-name', 'Send the file name in X-File-Name, without a folder.');
      fs.mkdirSync(path.join(dir, 'incoming'), { recursive: true });
      const tmp = path.join(dir, 'incoming', crypto.randomBytes(8).toString('hex') + path.extname(name).toLowerCase());
      const bytes = await saveUpload(req, tmp);
      const position = enqueue(name, () => (replace ? replacing(tmp, { name, sourcePath: null }) : engine.ingest(tmp, { name, sourcePath: null, onProgress })),
        () => fs.rmSync(tmp, { force: true }), { ...whoIs(req), kind: 'ingest' });
      return json(202, { queued: name, bytes, position, replace });
    }

    /* NoteX's documents: each File Fabric canvas NoteX wrote, and where it
     * stands in the library (t-c30c32cbe2). Adding one marks it as NoteX's;
     * a changed one replaces its old version once ready (t-086ad99f31). */
    if (m('GET', /^\/api\/notex$/)) return json(200, notexStatus(engine.store, notexDir()));
    if (m('POST', /^\/api\/notex\/add$/)) {
      const { names } = await readJson(req);
      const st = notexStatus(engine.store, notexDir());
      const want = Array.isArray(names) ? names : st.files.filter((f) => f.status !== 'added').map((f) => f.name);
      const queued = [];
      for (const name of want) {
        const entry = st.files.find((f) => f.name === name);
        const file = notexFile(st.folder, String(name));
        if (!entry || !file) throw new HttpError(404, 'not-found', `No ${name} in ${st.folder}.`);
        if (entry.status === 'added') continue;
        enqueue(name, () => replacing(file, { origin: 'notex' }), null, { ...whoIs(req), kind: 'ingest' });
        queued.push(name);
      }
      return json(202, { queued });
    }

    if (m('POST', /^\/api\/docs\/path$/)) {
      const { path: file, replace = false } = await readJson(req);
      if (!file || !path.isAbsolute(String(file))) throw new HttpError(400, 'bad-path', 'Give the full path of a file on this machine.');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not-found', `No file at ${file}.`);
      const position = enqueue(path.basename(file), () => (replace === true ? replacing(String(file)) : engine.ingest(String(file), { onProgress })), null, { ...whoIs(req), kind: 'ingest' });
      return json(202, { queued: path.basename(file), position, replace: replace === true });
    }

    if ((p = m('DELETE', /^\/api\/docs\/(\d+)$/))) {
      const doc = engine.remove(Number(p[0]));
      emit({ type: 'removed', docId: doc.id });
      return json(200, { removed: doc.id });
    }

    if ((p = m('POST', /^\/api\/docs\/(\d+)\/reindex$/))) {
      const id = Number(p[0]);
      const doc = engine.store.doc(id);
      if (!doc) throw new HttpError(404, 'not-found', `No document with id ${id}.`);
      return json(202, { queued: doc.name, position: enqueue(doc.name, () => engine.reindex(id, { onProgress }), null, { ...whoIs(req), kind: 'reindex' }) });
    }

    if ((p = m('GET', /^\/api\/chunks\/(\d+)$/))) {
      const c = engine.store.chunk(Number(p[0]));
      if (!c) throw new HttpError(404, 'not-found', 'No such passage.');
      const before = engine.store.chunkAt(c.doc_id, c.ord - 1);
      const after = engine.store.chunkAt(c.doc_id, c.ord + 1);
      const view = (x) => x && { id: x.id, ord: x.ord, heading: x.heading, text: x.text, pageFrom: x.page_from, pageTo: x.page_to };
      const out = { docId: c.doc_id, docName: c.doc_name, chunk: view(c), before: view(before), after: view(after) };
      tracker.record({ ...whoIs(req), kind: 'passage', question: `${c.doc_name} #${c.id}`, ms: 0, results: 1, detail: out });
      return json(200, out);
    }

    /* A figure: what it is and where it sits, and its image. The page fetches
     * images with the token like any request and shows them as blobs; an
     * agent fetching one is a call worth tracking (t-9bea9e80da). */
    if ((p = m('GET', /^\/api\/figures\/(\d+)$/))) {
      const f = engine.store.figure(Number(p[0]));
      if (!f) throw new HttpError(404, 'not-found', 'No such figure.');
      return json(200, figureView(f));
    }
    if ((p = m('GET', /^\/api\/figures\/(\d+)\/image$/))) {
      const f = engine.store.figure(Number(p[0]));
      const file = f && engine.figurePath(f);
      if (!f || !fs.existsSync(file)) throw new HttpError(404, 'not-found', 'No such figure.');
      const who = whoIs(req);
      if (who.source === 'agent') tracker.record({ ...who, kind: 'figure', question: `${f.doc_name} figure ${f.id}`, ms: 0, results: 1, detail: figureView(f) });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
      res.end(fs.readFileSync(file));
      return;
    }
    /* A linked image, opened where it is - only inside a folder listed in
     * Settings, and only an image file (t-1cfacc1b16). */
    if ((p = m('GET', /^\/api\/linked\/(\d+)\/image$/))) {
      const l = engine.store.linkedImage(Number(p[0]));
      if (!l) throw new HttpError(404, 'not-found', 'No such image.');
      if (!mayShow(l.path)) throw new HttpError(403, 'not-allowed', `${l.path} is not in a folder RAGX may show images from - add its folder in Settings.`);
      let buf;
      try { buf = fs.readFileSync(l.path); } catch (e) { throw new HttpError(404, 'not-found', `${l.path} is not there any more (${e.code || e.message}).`); }
      res.writeHead(200, { 'content-type': IMAGE_MIME[path.extname(l.path).toLowerCase()], 'cache-control': 'private, max-age=600' });
      res.end(buf);
      return;
    }

    /* One image read on its own - for NoteX, which writes the reading into
     * its document beside the image's path; nothing but the reading is kept
     * (t-2a6293f2b7). Readings share the engine's four slots (t-a5d9223798). */
    if (m('POST', /^\/api\/read-image$/)) {
      const name = decodeURIComponent(String(req.headers['x-file-name'] || 'image'));
      const buf = await readBody(req, MAX_IMAGE);
      const who = whoIs(req);
      const started = Date.now();
      const stats = {};
      let r;
      // X-Read-Ahead: how many more images NoteX will send after this one.
      const ahead = Math.max(0, Number(req.headers['x-read-ahead']) || 0);
      try { r = await engine.readOne(buf, { stats, ahead }); } catch (e) {
        tracker.record({ ...who, kind: 'read', question: name, ms: Date.now() - started, error: e.message });
        throw e;
      }
      tracker.record({ ...who, kind: 'read', question: name, ms: Date.now() - started, results: 1,
        timings: { readMs: stats.readMs || 0, reads: stats.reads || 0, readCached: r.cached ? 1 : 0 }, detail: { model: r.model, cached: Boolean(r.cached), kind: r.kind, warm: Boolean(stats.warm) } });
      return json(200, { kind: r.kind, text: r.text, description: r.description, parsed: r.parsed, model: r.model, cached: Boolean(r.cached), ms: r.ms ?? null, warm: Boolean(stats.warm) });
    }

    if ((p = m('GET', /^\/api\/docs\/(\d+)\/figures$/))) {
      if (!engine.store.doc(Number(p[0]))) throw new HttpError(404, 'not-found', 'No such document.');
      return json(200, { figures: engine.store.docFigures(Number(p[0])).map(figureView) });
    }

    if (m('POST', /^\/api\/search$/)) {
      const { q, k, docs } = await readJson(req);
      if (!q) throw new HttpError(400, 'no-question', 'Give the search in q.');
      const docIds = docList(docs);
      const started = Date.now();
      const who = whoIs(req);
      const run = tracker.begin({ ...who, kind: 'search', question: String(q), phase: 'searching' });
      let r;
      try { r = await engine.search(String(q), { k: Number(k) || 8, docIds }); } catch (e) {
        tracker.record({ ...who, run, kind: 'search', question: String(q), ms: Date.now() - started, error: e.message });
        throw e;
      }
      tracker.record({ ...who, run, kind: 'search', question: String(q), ms: Date.now() - started, timings: r.timings,
        results: r.passages.length, detail: { passages: r.passages.map(passageDetail), warning: r.warning } });
      return json(200, r);
    }

    if (m('POST', /^\/api\/ask$/)) {
      const body = await readJson(req);
      const question = String(body.question || '').trim();
      if (!question) throw new HttpError(400, 'no-question', 'Give the question.');
      const conversationId = body.conversationId ? Number(body.conversationId) : null;
      if (conversationId) {
        const open = pool.live().get(conversationId);
        if (open && open.busy) throw new HttpError(409, 'busy', 'This conversation is still answering its last question.');
      }
      const ac = new AbortController();
      inflight.add(ac);
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const send = (e) => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n'); };
      const started = Date.now();
      const who = whoIs(req);
      const run = tracker.begin({ ...who, kind: 'ask', question, agent: body.agent || null, model: body.model || null, phase: 'searching' });
      let shown = [];
      try {
        if (ollamaStart) await ollamaStart; // a question right after a start waits for Ollama
        const name = body.agent || null;
        const r = await ask(engine, {
          question, agent: name, model: body.model || null, conversationId, k: Number(body.k) || 8,
          // Left out, a conversation keeps its own choice; null searches all documents.
          docs: body.docs === undefined ? undefined : docList(body.docs),
          signal: ac.signal, pool, agentOptions: (name && agentOptions[name]) || (!name && agentOptions[engine.store.getMeta('agent', 'claude')]) || {},
          // First, before the agent's wait (t-3569a2ad7e).
          onSources: ({ sources, fresh }) => { shown = sources; tracker.phase(run, 'agent answering'); send({ type: 'sources', sources: sources.map((s) => ({ ...s, fresh: fresh.includes(s.n) })) }); },
          onDelta: (text) => send({ type: 'delta', text }),
        });
        send({ type: 'done', conversationId: r.conversationId, answer: r.answer, cited: r.cited.map((s) => s.n), unknown: r.unknown,
          warnings: r.warnings, agent: r.agent, model: r.model, ms: r.ms ?? null, asked: r.asked, scope: r.scope ?? null });
        tracker.record({ ...who, run, kind: 'ask', question, agent: r.agent, model: r.model, ms: Date.now() - started, timings: r.timings,
          results: r.sources.length, detail: { conversationId: r.conversationId, passages: r.sources.map(passageDetail), answer: r.answer,
            cited: r.cited.map((s) => s.n), unknown: r.unknown, warnings: r.warnings } });
        if (r.agent === 'agy') { refill(); emit({ type: 'pool', pool: pool.list() }); }
      } catch (e) {
        send({ type: 'error', code: e.code || 'failed', message: e.message, status: statusOf(e) });
        tracker.record({ ...who, run, kind: 'ask', question, agent: body.agent || null, model: body.model || null, ms: Date.now() - started,
          results: shown.length, detail: { conversationId, passages: shown.map(passageDetail) }, error: e.message });
      } finally {
        inflight.delete(ac);
        res.end();
      }
      return;
    }

    if (m('GET', /^\/api\/conversations$/)) return json(200, { conversations: engine.store.conversations() });

    if ((p = m('GET', /^\/api\/conversations\/(\d+)$/))) {
      const id = Number(p[0]);
      const c = engine.store.conversation(id);
      if (!c) throw new HttpError(404, 'not-found', `No conversation ${id}.`);
      return json(200, { conversation: c, messages: engine.store.messages(id), sources: engine.store.sources(id), open: pool.live().has(id) });
    }

    if ((p = m('DELETE', /^\/api\/conversations\/(\d+)$/))) {
      const id = Number(p[0]);
      if (!engine.store.conversation(id)) throw new HttpError(404, 'not-found', `No conversation ${id}.`);
      const open = pool.live().get(id);
      if (open) { if (open.busy) throw new HttpError(409, 'busy', 'This conversation is still answering.'); pool.sessions.delete(id); await open.close(); }
      engine.store.deleteConversation(id);
      emit({ type: 'pool', pool: pool.list() });
      return json(200, { removed: id });
    }

    if (m('GET', /^\/api\/settings$/)) return json(200, settings());

    if (m('PUT', /^\/api\/settings$/)) {
      const b = await readJson(req);
      if (b.agent !== undefined && !AGENTS[b.agent]) throw new HttpError(400, 'bad-agent', `agent must be ${Object.keys(AGENTS).join(' or ')}.`);
      const metaKeys = { agent: 'agent', claudeModel: 'claude_model', agyModel: 'agy_model', claudePath: 'claude_path', agyPath: 'agy_path', readModel: 'read_model' };
      if (b.readFigures !== undefined) engine.store.setMeta('read_figures', b.readFigures ? 'on' : 'off');
      if (b.notexDocs !== undefined) {
        const folder = String(b.notexDocs || '').trim().replace(/^"(.*)"$/, '$1');
        if (folder && !path.isAbsolute(folder)) throw new HttpError(400, 'bad-folder', `"${folder}" is not a full path.`);
        engine.store.setMeta('notex_docs', folder ? path.resolve(folder) : '');
      }
      if (b.imageFolders !== undefined) {
        const list = (Array.isArray(b.imageFolders) ? b.imageFolders : []).map((d) => String(d).trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
        const bad = list.find((d) => !path.isAbsolute(d));
        if (bad) throw new HttpError(400, 'bad-folder', `"${bad}" is not a full path - give folders like E:\\FILES\\workspace.`);
        engine.store.setMeta('image_folders', JSON.stringify([...new Set(list.map((d) => path.resolve(d)))]));
      }
      for (const [k, meta] of Object.entries(metaKeys)) if (b[k] !== undefined) engine.store.setMeta(meta, b[k] ?? '');
      let stale = 0;
      if (b.embedModel !== undefined || b.queryPrefix !== undefined || b.docPrefix !== undefined) {
        const s = engine.settings();
        const model = b.embedModel ?? s.model;
        // A new model brings its own prefixes unless the request names some (t-64e566c572).
        const keep = model === s.model;
        const r = await engine.setModel({ model, queryPrefix: b.queryPrefix ?? (keep ? s.queryPrefix : undefined), docPrefix: b.docPrefix ?? (keep ? s.docPrefix : undefined) });
        stale = r.stale;
        ollama = { at: 0, value: null };
      }
      return json(200, { settings: settings(), stale });
    }

    /* Read figures now: a document's figures not read yet, or every
     * document's, each as a job of its own (t-f0fbeabf6b). */
    if ((p = m('POST', /^\/api\/docs\/(\d+)\/read$/))) {
      const id = Number(p[0]);
      const doc = engine.store.doc(id);
      if (!doc) throw new HttpError(404, 'not-found', `No document with id ${id}.`);
      return json(202, { queued: doc.name, position: enqueue(`Reading figures in ${doc.name}`, () => engine.readNow(id, { onProgress }), null, { ...whoIs(req), kind: 'read' }) });
    }
    if (m('POST', /^\/api\/read$/)) {
      const docs = engine.store.unreadDocs();
      for (const d of docs) enqueue(`Reading figures in ${d.name}`, () => engine.readNow(d.id, { onProgress }), null, { ...whoIs(req), kind: 'read' });
      return json(202, { queued: docs.map((d) => d.name) });
    }

    if (m('POST', /^\/api\/reembed$/)) {
      return json(202, { queued: 'reembed', position: enqueue('reembed', () => engine.reembed({ onProgress }), null, { ...whoIs(req), kind: 'reembed' }) });
    }

    if (m('POST', /^\/api\/agents\/warm$/)) {
      spareWanted = Date.now();
      const s = pool.warm({ model: engine.store.getMeta('agy_model', '') || null });
      emit({ type: 'pool', pool: pool.list() });
      return json(200, { warming: Boolean(s), pool: pool.list() });
    }

    if (m('GET', /^\/api\/events$/)) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const send = (e) => { if (!res.writableEnded) res.write(JSON.stringify(e) + '\n'); };
      send({ type: 'hello', queue: queue.map((j) => j.label), ingesting: current ? current.label : null, pool: pool.list() });
      bus.on('event', send);
      const ping = setInterval(() => send({ type: 'ping' }), 15_000);
      streams.add(res);
      res.on('close', () => { bus.off('event', send); clearInterval(ping); streams.delete(res); });
      return;
    }

    if (m('POST', /^\/api\/shutdown$/)) {
      json(202, { stopping: true });
      setImmediate(() => stop('requested by the plugin').then(() => onStopped && onStopped()));
      return;
    }

    throw new HttpError(404, 'no-route', `No ${req.method} ${url.pathname}.`);
  };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowedOrigin = origin && origins.includes(origin) ? origin : null;
    if (allowedOrigin) { res.setHeader('access-control-allow-origin', allowedOrigin); res.setHeader('vary', 'Origin'); }
    const refuse = (status, code, message) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { code, message } }));
    };
    if (!allowedHosts().has(String(req.headers.host || '').toLowerCase())) return refuse(421, 'bad-host', 'This engine answers only on 127.0.0.1 or localhost.');
    if (origin && !allowedOrigin) return refuse(403, 'bad-origin', `Requests from ${origin} are not accepted.`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': 'X-Rag-Token, Content-Type, X-File-Name, X-Rag-Client, X-Replace',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    const given = Buffer.from(String(req.headers['x-rag-token'] || ''));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return refuse(401, 'bad-token', 'Missing or wrong X-Rag-Token.');
    if (stopping) return refuse(503, 'stopping', 'The engine is stopping.');
    try {
      await routes(req, res, new URL(req.url, `http://${req.headers.host}`));
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch (_) {} return; }
      refuse(statusOf(e), e.code || 'failed', e.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use - stop what holds it, or start with --port <another>.`) : e));
    server.listen(port, '127.0.0.1', resolve);
  });
  actualPort = server.address().port;
  const url = `http://127.0.0.1:${actualPort}`;
  const removeRuntime = writeRuntime(runtimeFile, { url, port: actualPort, token, pid: process.pid, dataDir: dir, version: VERSION, startedAt: new Date().toISOString() });
  writeLocal(path.join(path.dirname(runtimeFile), 'local.json'));
  takeLock(dir, { url, startedAt: new Date().toISOString() }, instance);

  if (sampleResources) tracker.start();

  /* Ollama starts after the engine is listening, so the plugin sees the
   * engine at once; the first embedding waits for Ollama if it must
   * (t-f8b37daa55). */
  if (ollamaCtl) {
    ollamaStart = ollamaCtl.ensure().then((r) => {
      log(r.owned ? `Ollama started (pid ${r.pid}); it stops with the engine.`
        : 'Ollama was already running; it is left running when the engine stops, and only the embedding model is unloaded.');
      ollama = { at: 0, value: null };
      emit({ type: 'ollama' });
      return r;
    }, (e) => {
      ollamaCtl.startError = e.message;
      log(`Ollama could not be started: ${e.message}`);
      return { owned: false, error: e.message };
    });
  }

  /* Documents an earlier run left half-done are finished first. */
  if (engine.store.pendingDocs().length) enqueue('resume', async () => { if (ollamaStart) await ollamaStart; return engine.resume({ onProgress }); }, null, { source: 'engine', client: null, kind: 'resume' });

  let stopped = null;
  async function stop(reason = 'stopped') {
    if (stopped) return stopped;
    stopping = true;
    stopped = (async () => {
      log(`Stopping (${reason})...`);
      engine.stopRequested = true;
      tracker.stop();
      queue.length = 0;
      for (const ac of inflight) ac.abort();
      await pool.closeAll();
      // An ingest step in flight finishes; the next one throws 'stopped'.
      for (let i = 0; current && i < 600; i++) await new Promise((r) => setTimeout(r, 100));
      for (const res of streams) { try { res.end(); } catch (_) {} }
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      if (ollamaCtl) {
        if (ollamaStart) await ollamaStart;
        const o = await ollamaCtl.stop(engine.embedder.model);
        log(o.stopped ? 'Ollama stopped.' : o.unloaded ? `Unloaded ${engine.embedder.model} from Ollama; Ollama itself was already running and is left running.` : 'Ollama left as it was.');
      }
      engine.close();
      record.clear();
      removeRuntime();
      releaseLock();
      setTracker({ add() {}, remove() {} });
      log('Stopped.');
    })();
    return stopped;
  }

  if (signals) {
    let presses = 0;
    const onSignal = () => {
      if (++presses > 1) { log('Stopping now.'); process.exit(130); }
      stop('Ctrl+C - press it again to stop at once').then(() => process.exit(0));
    };
    for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(s, onSignal);
  }

  return { url, port: actualPort, token, engine, pool, stop, orphans, runtimeFile, ollama: ollamaCtl, ollamaReady: ollamaStart, tracker };
}

export { EngineError };
