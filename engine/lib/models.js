/* Which embedding models Ollama has, and downloading another (t-d71c943186,
 * t-ddf3190c54).
 *
 * The list is Ollama's own (/api/tags), each model checked with /api/show:
 * only those whose capabilities include embedding can be the setting
 * (t-48a192b1e7), so chat models are left out. Beside them are a few
 * embedding models worth suggesting, to download by name.
 *
 * A download is the engine's, not a terminal's (t-116a3144f3): it streams
 * Ollama's /api/pull and keeps the progress, so the page shows it wherever
 * it is hosted and finds the model ready when it finishes.
 */
import { DEFAULT_MODEL } from './embed.js';

export const SUGGESTED = [
  { name: DEFAULT_MODEL, note: 'the default: text and figures in one space' },
  { name: 'embeddinggemma-2:740m', note: 'larger EmbeddingGemma: text and figures' },
  { name: 'nomic-embed-text-v2-moe', note: 'multilingual, text only' },
  { name: 'bge-m3', note: 'multilingual, text only' },
  { name: 'qwen3-embedding:0.6b', note: 'multilingual, text only' },
  { name: 'nomic-embed-text', note: 'English, text only, small' },
  { name: 'mxbai-embed-large', note: 'English, text only' },
];

// Ollama's names: a model, an optional namespace before it and tag after it.
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?(:[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
export const validName = (name) => typeof name === 'string' && name.length <= 200 && NAME.test(name);

// "nomic-embed-text" and "nomic-embed-text:latest" are one model.
export const sameModel = (a, b) => {
  const full = (n) => (String(n).includes(':') ? String(n) : `${n}:latest`);
  return full(a) === full(b);
};

export class ModelError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function call(fetchImpl, host, path, body, ms = 10_000) {
  let res;
  try {
    res = await fetchImpl(host + path, body === undefined ? { signal: AbortSignal.timeout(ms) } : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
  } catch (_) {
    throw new ModelError(503, 'ollama-down', `Ollama is not answering at ${host} - start it with "ollama serve".`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ModelError(502, 'ollama', `Ollama refused ${path} (${res.status}): ${data.error || res.statusText}`);
  return data;
}

/* Every installed model that can embed, with its size and whether it embeds
 * images too. Ollama before capabilities were reported says nothing either
 * way; then every model is listed rather than none. */
export async function listModels({ host, fetch: fetchImpl = globalThis.fetch }) {
  const { models = [] } = await call(fetchImpl, host, '/api/tags');
  const checked = await Promise.all(models.map(async (m) => {
    const name = m.name || m.model;
    try {
      const show = await call(fetchImpl, host, '/api/show', { model: name });
      return { name, size: m.size ?? null, caps: show.capabilities || null };
    } catch (_) { return { name, size: m.size ?? null, caps: null }; }
  }));
  const reported = checked.some((m) => Array.isArray(m.caps));
  return checked
    .filter((m) => !reported || (m.caps || []).includes('embedding'))
    .map((m) => ({ name: m.name, size: m.size, vision: Boolean(m.caps && m.caps.includes('vision')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* Whether a model can embed, as describe() decides it: an empty list of
 * capabilities (an older Ollama) is taken as yes. */
export async function canEmbed({ host, fetch: fetchImpl = globalThis.fetch, model }) {
  const caps = (await call(fetchImpl, host, '/api/show', { model })).capabilities || [];
  return !caps.length || caps.includes('embedding');
}

/* One download at a time. Ollama sends a line per step; a layer being
 * fetched carries its digest with completed and total bytes, and the
 * download's progress is those summed over every layer seen so far. */
export class ModelPull {
  constructor({ host, fetch: fetchImpl = globalThis.fetch, emit = () => {}, check = null, everyMs = 250 }) {
    Object.assign(this, { host, fetchImpl, emit, check, everyMs });
    this.current = null;
    this.ac = null;
  }

  get busy() { return Boolean(this.current && !this.current.done); }

  state() { return this.current ? { ...this.current } : null; }

  start(model) {
    if (!validName(model)) throw new ModelError(400, 'bad-model', `"${model}" is not an Ollama model name, like ${DEFAULT_MODEL}.`);
    if (this.busy) throw new ModelError(409, 'busy', `${this.current.model} is downloading - wait for it, or cancel it first.`);
    this.current = { model, status: 'starting', completed: 0, total: 0, startedAt: Date.now(), done: false, ok: false, error: null, embeds: null };
    this.ac = new AbortController();
    this.finished = this.run(this.current, this.ac.signal);
    return this.state();
  }

  cancel() {
    if (!this.busy) return false;
    this.ac.abort();
    return true;
  }

  async run(p, signal) {
    const layers = new Map();
    let last = 0;
    const tell = (force = false) => {
      if (!force && Date.now() - last < this.everyMs) return;
      last = Date.now();
      this.emit({ type: 'pull', pull: { ...p } });
    };
    try {
      let res;
      try {
        res = await this.fetchImpl(this.host + '/api/pull', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: p.model, stream: true }), signal,
        });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new Error(`Ollama is not answering at ${this.host} - start it with "ollama serve".`);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Ollama refused the download (${res.status}).`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.error) throw new Error(e.error);
          p.status = e.status || p.status;
          if (e.digest && e.total) {
            layers.set(e.digest, { total: e.total, completed: e.completed || 0 });
            p.total = [...layers.values()].reduce((n, l) => n + l.total, 0);
            p.completed = [...layers.values()].reduce((n, l) => n + l.completed, 0);
          }
          if (e.status === 'success') p.ok = true;
          tell();
        }
      }
      if (!p.ok) throw new Error('Ollama ended the download without finishing it.');
      p.completed = p.total;
      // A model that downloaded fine but cannot embed is said plainly.
      if (this.check) p.embeds = await this.check(p.model).catch(() => null);
    } catch (e) {
      p.ok = false;
      p.error = signal.aborted ? 'Cancelled.' : (/file does not exist/i.test(e.message) ? `Ollama has no model called ${p.model}.` : e.message);
    } finally {
      p.done = true;
      p.status = p.ok ? 'done' : 'failed';
      tell(true);
    }
  }
}
