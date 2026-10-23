/* Embeddings from a local Ollama model (t-01e6275492).
 *
 * The model is a setting kept in the index, embeddinggemma-2:440m until
 * someone names another (t-ba2cbf35c7, t-ada6e7d458, t-8e7cd345f4). It embeds
 * text and images into one space, so a question finds passages and figures
 * alike. Nothing about a model is hard-coded: its context length and whether
 * it can see images are read from /api/show, its vector size from the first
 * vector it returns.
 *
 * Every request sends truncate:false (t-90f5b67324). Ollama's default is to
 * cut an over-long input without saying so - the vector then describes only
 * the start of the chunk - so a chunk too long for the model fails here, by
 * name, and the caller can chunk smaller.
 */

export const DEFAULT_MODEL = 'embeddinggemma-2:440m';

/* EmbeddingGemma expects a task line before each input; with these, search on
 * the user's documents put the answer first 8 times in 12 against 6 without
 * (t-6297a0cdf3). Other models get none unless they are set. */
export function defaultPrefixes(model) {
  return /^embeddinggemma/i.test(String(model))
    ? { queryPrefix: 'task: search result | query: ', docPrefix: 'title: none | text: ' }
    : { queryPrefix: '', docPrefix: '' };
}

// Images are slow to embed (about 2.5 s each on the MX450), so fewer go per request.
const IMAGE_BATCH = 4;
export const OLLAMA = 'http://127.0.0.1:11434';

export class EmbedError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmbedError';
    this.code = code; // ollama-down | model-missing | not-embedding | too-long | ollama
  }
}

/* The settings live in the index's meta table, so the index always knows
 * how its vectors were made. */
export function readSettings(store) {
  const model = store.getMeta('embed_model', DEFAULT_MODEL);
  const d = defaultPrefixes(model);
  return {
    model,
    queryPrefix: store.getMeta('query_prefix', d.queryPrefix),
    docPrefix: store.getMeta('doc_prefix', d.docPrefix),
  };
}

export function writeSettings(store, { model, queryPrefix = '', docPrefix = '' }) {
  store.setMeta('embed_model', model);
  store.setMeta('query_prefix', queryPrefix);
  store.setMeta('doc_prefix', docPrefix);
}

/* Two documents' vectors are comparable only if the same model embedded the
 * same kind of input. The document prefix changes that input; the query
 * prefix does not touch stored vectors, so it is not part of this. */
export function signature({ model, docPrefix = '' }) {
  return docPrefix ? `${model}|doc:${docPrefix}` : model;
}

/* What a chunk is embedded as: where it sits, then what it says. The heading
 * path tells the model what the passage is about when the passage itself
 * does not say; the stored text stays the document's own words (t-263f8fc7aa). */
export function chunkInput(docName, heading, text) {
  const where = heading ? `${docName} > ${heading}` : docName;
  return `${where}\n\n${text}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Embedder {
  constructor({ model = DEFAULT_MODEL, queryPrefix = '', docPrefix = '', host = OLLAMA, batch = 16,
    retries = 2, fetch: fetchImpl = globalThis.fetch } = {}) {
    Object.assign(this, { model, queryPrefix, docPrefix, host, batch, retries, fetchImpl });
    this.dim = null;
  }

  get signature() { return signature(this); }

  /* Each failure by name, with the command that fixes it; network errors and
   * 5xx are retried, a refusal never is (t-aaa8fd29fd). */
  async post(path, body) {
    let last;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await sleep(500 * 3 ** (attempt - 1));
      let res;
      try {
        res = await this.fetchImpl(this.host + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        last = new EmbedError('ollama-down', `Ollama is not answering at ${this.host} - start it with "ollama serve".`);
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const msg = String(data.error || res.statusText || res.status);
      if (/not found/i.test(msg) || res.status === 404) {
        throw new EmbedError('model-missing', `The embedding model ${this.model} is not downloaded - run "ollama pull ${this.model}".`);
      }
      if (/context length|too long/i.test(msg)) throw new EmbedError('too-long', `An input is longer than ${this.model} can embed: ${msg}`);
      last = new EmbedError('ollama', `Ollama refused the request (${res.status}): ${msg}`);
      if (res.status < 500) throw last;
    }
    throw last;
  }

  /* The model's own numbers, and a refusal if it cannot embed at all - a
   * chat model named here by mistake would otherwise fail on every chunk
   * (t-48a192b1e7).
   *
   * The vector size is not taken from here: /api/show's embedding_length can
   * be an inner layer's width - embeddinggemma-2 reports 512 and returns 768
   * (t-064b29db7b) - so it is only reportedDim, and dim is learned from the
   * first vector the model returns (t-ab9179da22). A probe embedding here
   * would load the model on every status check. */
  async describe() {
    const show = await this.post('/api/show', { model: this.model });
    const caps = show.capabilities || [];
    if (caps.length && !caps.includes('embedding')) {
      throw new EmbedError('not-embedding', `${this.model} is not an embedding model (it can: ${caps.join(', ')}).`);
    }
    const info = show.model_info || {};
    const arch = info['general.architecture'];
    const pick = (suffix) => {
      if (arch && info[`${arch}.${suffix}`] !== undefined) return Number(info[`${arch}.${suffix}`]);
      const k = Object.keys(info).find((key) => key.endsWith('.' + suffix));
      return k ? Number(info[k]) : null;
    };
    this.reportedDim = pick('embedding_length');
    this.ctx = pick('context_length');
    // Whether the model can embed images: Ollama lists 'vision' for those.
    this.vision = caps.includes('vision');
    return { model: this.model, dim: this.dim, reportedDim: this.reportedDim, ctx: this.ctx, vision: this.vision };
  }

  async embed(inputs, stats = null, { batch = this.batch, timeKey = 'ms' } = {}) {
    const out = [];
    for (let i = 0; i < inputs.length; i += batch) {
      const part = inputs.slice(i, i + batch);
      const started = Date.now();
      const data = await this.post('/api/embed', { model: this.model, input: part, truncate: false });
      /* Ollama times its own work in nanoseconds, and load_duration is the
       * part spent loading the model - how a call that woke the GPU shows up
       * in the tracker (t-acd3fa359a). Images are timed apart from text. */
      if (stats) {
        stats[timeKey] = (stats[timeKey] || 0) + (Date.now() - started);
        stats.loadMs = (stats.loadMs || 0) + Math.round((data.load_duration || 0) / 1e6);
        stats.tokens = (stats.tokens || 0) + (data.prompt_eval_count || 0);
      }
      const vecs = data.embeddings || [];
      if (vecs.length !== part.length) throw new EmbedError('ollama', `Ollama returned ${vecs.length} embeddings for ${part.length} inputs.`);
      for (const v of vecs) {
        if (this.dim === null) this.dim = v.length;
        if (v.length !== this.dim) throw new EmbedError('ollama', `${this.model} returned ${v.length} dimensions, expected ${this.dim}.`);
        out.push(Float32Array.from(v));
      }
    }
    return out;
  }

  /* The prefixes are empty unless set (t-28f8b58f1a): on a small test nomic
   * did no better with its search_query / search_document prefixes. */
  embedDocuments(texts, stats) { return this.embed(texts.map((t) => this.docPrefix + t), stats); }

  async embedQuery(text, stats) { return (await this.embed([this.queryPrefix + text], stats))[0]; }

  /* Figures, each a PNG, into the same space as the text. Ollama takes an
   * image as an input object with the field image, singular, in base64; an
   * images field is silently ignored (t-a8dc8ee656). No prefix: the task
   * line is for text. */
  async embedImages(pngs, stats) {
    const vecs = await this.embed(pngs.map((b) => ({ image: Buffer.from(b).toString('base64') })), stats, { batch: IMAGE_BATCH, timeKey: 'imageMs' });
    if (stats) stats.images = (stats.images || 0) + pngs.length;
    return vecs;
  }
}
