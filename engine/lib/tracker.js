/* The tracker: every call made to Harness, and what the machine was doing.
 *
 * A call is recorded whoever made it - the user from the plugin page, an
 * agent through the Harness tool, or the command line - with its question,
 * what came back, and how long each part took: embedding (and how much of
 * that was Ollama loading the model), search, and the answering agent
 * (t-acd3fa359a).
 *
 * While the engine runs, the GPU and the embedding model are sampled every
 * 5 seconds: GPU use and memory from nvidia-smi, and from Ollama whether the
 * model is loaded and how much VRAM it holds. Samples are kept at that
 * detail for 24 hours and as per-minute averages for 30 days
 * (t-cdaac97481, t-61e101305a). Calls are kept until the user clears them.
 */
import { execFile } from 'node:child_process';
import { transaction } from './db.js';

export const SAMPLE_MS = 5000;
const DAY = 24 * 3600 * 1000;
const KEEP_RAW = DAY;
const KEEP_MINUTES = 30 * DAY;

/* nvidia-smi's own numbers, or null where there is no NVIDIA GPU. */
export function readNvidia() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const [util, used, total] = String(out).split('\n')[0].split(',').map((x) => Number(x.trim()));
        resolve(Number.isFinite(util) ? { util, usedMb: used, totalMb: total } : null);
      });
  });
}

/* Whether Ollama holds the model, and how much VRAM it takes there. */
export function modelReader(host, model) {
  return async () => {
    try {
      const r = await fetch(host + '/api/ps', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return { up: true, loaded: false, vramMb: 0 };
      const { models = [] } = await r.json();
      const want = model().includes(':') ? model() : `${model()}:latest`;
      const m = models.find((x) => x.name === want || x.model === want);
      return { up: true, loaded: Boolean(m), vramMb: m ? Math.round((m.size_vram || 0) / 1048576) : 0 };
    } catch (_) { return { up: false, loaded: false, vramMb: 0 }; }
  };
}

const json = (v) => (v == null ? null : JSON.stringify(v));

export class Tracker {
  constructor(store, { gpu = readNvidia, model = null, now = () => Date.now(), sampleMs = SAMPLE_MS } = {}) {
    this.db = store.db;
    this.gpu = gpu;
    this.model = model;
    this.now = now;
    this.sampleMs = sampleMs;
    this.timer = null;
    this.last = null;
    this.listeners = new Set();
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      add: p(`insert into calls (at, ms, source, client, kind, question, agent, model, embed_ms, load_ms, search_ms, agent_ms, results, detail, error)
              values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      call: p('select * from calls where id = ?'),
      sample: p('insert or replace into samples (at, gpu_util, vram_used, vram_total, model_loaded, model_vram) values (?, ?, ?, ?, ?, ?)'),
      minute: p(`insert into samples_min (minute, n, gpu_util_sum, gpu_util_max, vram_used_max, vram_total, model_loaded_n, model_vram_max)
                 values (?, 1, ?, ?, ?, ?, ?, ?)
                 on conflict (minute) do update set n = n + 1, gpu_util_sum = gpu_util_sum + excluded.gpu_util_sum,
                   gpu_util_max = max(coalesce(gpu_util_max, 0), coalesce(excluded.gpu_util_max, 0)),
                   vram_used_max = max(coalesce(vram_used_max, 0), coalesce(excluded.vram_used_max, 0)),
                   vram_total = coalesce(excluded.vram_total, vram_total),
                   model_loaded_n = model_loaded_n + excluded.model_loaded_n,
                   model_vram_max = max(coalesce(model_vram_max, 0), coalesce(excluded.model_vram_max, 0))`),
      pruneRaw: p('delete from samples where at < ?'),
      pruneMin: p('delete from samples_min where minute < ?'),
      raw: p('select * from samples where at >= ? order by at'),
      mins: p('select * from samples_min where minute >= ? order by minute'),
      loadedSeconds: p('select coalesce(sum(model_loaded_n), 0) n from samples_min where minute >= ?'),
      bySource: p(`select source, kind, count(*) calls, avg(ms) avg_ms, max(ms) max_ms, sum(coalesce(embed_ms, 0)) embed_ms,
                     sum(coalesce(load_ms, 0)) load_ms,
                     -- over half a second loading means the call woke the model (t-c4370709ad)
                     sum(case when load_ms > 500 then 1 else 0 end) loads,
                     sum(case when error is not null then 1 else 0 end) errors
                   from calls where at >= ? group by source, kind`),
      clear: p('delete from calls'),
    };
  }

  onCall(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /* One call, as it ended. detail carries what came back: passages, an
   * answer and its citations, a document. */
  record({ at = this.now(), ms = null, source, client = null, kind, question = null, agent = null, model = null,
    timings = {}, results = null, detail = null, error = null }) {
    const id = Number(this.q.add.run(at, ms, source, client, kind, question, agent, model,
      timings.embedMs ?? null, timings.loadMs ?? null, timings.searchMs ?? null, timings.agentMs ?? null,
      results, json(detail), error).lastInsertRowid);
    const row = this.call(id);
    for (const fn of this.listeners) { try { fn(row); } catch (_) { /* a listener's problem */ } }
    return row;
  }

  call(id) {
    const r = this.q.call.get(id);
    return r ? { ...r, detail: r.detail ? JSON.parse(r.detail) : null } : null;
  }

  /* Newest first; the list leaves out the bulky detail. */
  calls({ limit = 50, before = null, source = null, kind = null } = {}) {
    const where = [];
    const args = [];
    if (before) { where.push('id < ?'); args.push(Number(before)); }
    if (source) { where.push('source = ?'); args.push(source); }
    if (kind) { where.push('kind = ?'); args.push(kind); }
    const sql = `select id, at, ms, source, client, kind, question, agent, model, embed_ms, load_ms, search_ms, agent_ms, results, error
                 from calls ${where.length ? 'where ' + where.join(' and ') : ''} order by id desc limit ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500));
  }

  clear() { this.q.clear.run(); }

  async sample() {
    const at = this.now();
    const [g, m] = await Promise.all([this.gpu(), this.model ? this.model() : Promise.resolve(null)]);
    const s = {
      at,
      gpuUtil: g ? g.util : null, vramUsed: g ? g.usedMb : null, vramTotal: g ? g.totalMb : null,
      modelLoaded: m ? (m.loaded ? 1 : 0) : null, modelVram: m ? m.vramMb : null, ollamaUp: m ? m.up : null,
    };
    transaction(this.db, () => {
      this.q.sample.run(at, s.gpuUtil, s.vramUsed, s.vramTotal, s.modelLoaded, s.modelVram);
      this.q.minute.run(Math.floor(at / 60000) * 60000, s.gpuUtil ?? 0, s.gpuUtil, s.vramUsed, s.vramTotal, s.modelLoaded ? 1 : 0, s.modelVram);
    });
    this.last = s;
    return s;
  }

  prune(now = this.now()) {
    this.q.pruneRaw.run(now - KEEP_RAW);
    this.q.pruneMin.run(now - KEEP_MINUTES);
  }

  start() {
    if (this.timer) return;
    let n = 0;
    const tick = async () => {
      try { await this.sample(); } catch (_) { /* a missed sample is only a gap */ }
      if (++n % 120 === 0) this.prune(); // every ten minutes
    };
    tick();
    this.timer = setInterval(tick, this.sampleMs);
    this.timer.unref();
    this.prune();
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /* The last hour at 5-second detail; longer ranges as per-minute averages. */
  samples(rangeMs = 3600 * 1000) {
    const since = this.now() - rangeMs;
    if (rangeMs <= 3600 * 1000) {
      return this.q.raw.all(since).map((r) => ({ at: r.at, gpuUtil: r.gpu_util, vramUsed: r.vram_used, vramTotal: r.vram_total, modelLoaded: r.model_loaded, modelVram: r.model_vram }));
    }
    return this.q.mins.all(since).map((r) => ({
      at: r.minute, gpuUtil: r.n ? r.gpu_util_sum / r.n : null, gpuUtilMax: r.gpu_util_max, vramUsed: r.vram_used_max,
      vramTotal: r.vram_total, modelLoaded: r.n ? r.model_loaded_n / r.n : 0, modelVram: r.model_vram_max,
    }));
  }

  summary(rangeMs = DAY) {
    const since = this.now() - rangeMs;
    const rows = this.q.bySource.all(since);
    const by = (key) => {
      const out = {};
      for (const r of rows) {
        const k = r[key];
        const o = out[k] || (out[k] = { calls: 0, totalMs: 0, maxMs: 0, embedMs: 0, loadMs: 0, loads: 0, errors: 0 });
        o.calls += r.calls; o.totalMs += (r.avg_ms || 0) * r.calls; o.maxMs = Math.max(o.maxMs, r.max_ms || 0);
        o.embedMs += r.embed_ms; o.loadMs += r.load_ms; o.loads += r.loads; o.errors += r.errors;
      }
      for (const o of Object.values(out)) { o.avgMs = o.calls ? Math.round(o.totalMs / o.calls) : 0; delete o.totalMs; }
      return out;
    };
    const all = rows.reduce((a, r) => ({ calls: a.calls + r.calls, embedMs: a.embedMs + r.embed_ms, loadMs: a.loadMs + r.load_ms, loads: a.loads + r.loads }),
      { calls: 0, embedMs: 0, loadMs: 0, loads: 0 });
    const loadedSamples = this.q.loadedSeconds.get(Math.floor(since / 60000) * 60000).n;
    return {
      since, ...all,
      bySource: by('source'), byKind: by('kind'),
      modelLoadedSeconds: Math.round(loadedSamples * (this.sampleMs / 1000)),
      now: this.last,
    };
  }
}
