/* Talking to the engine.
 *
 * The engine writes runtime.json beside this page each time it starts - its
 * address and a fresh token - and removes it when it stops; ter-manager serves
 * it from the plugin folder. A runtime.json left behind by a hard kill names
 * an engine that no longer answers, so "running" means /api/state answered,
 * never that the file exists.
 *
 * Streams come as one JSON object per line (the engine's t-758ad41ba4):
 * readLines() turns a fetch response into those objects as they arrive.
 */

export class EngineDown extends Error {
  constructor(message) { super(message); this.name = 'EngineDown'; }
}

export class EngineRefused extends Error {
  constructor(status, code, message) { super(message); this.name = 'EngineRefused'; this.status = status; this.code = code; }
}

/* Split what has arrived so far into whole lines; the rest waits for more. */
export function splitLines(buffer) {
  const parts = buffer.split('\n');
  const rest = parts.pop();
  const events = [];
  for (const line of parts) {
    const s = line.trim();
    if (!s) continue;
    try { events.push(JSON.parse(s)); } catch (_) { /* a line that is not JSON is skipped */ }
  }
  return { events, rest };
}

export async function* readLines(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = splitLines(buf);
    buf = rest;
    yield* events;
  }
  const { events } = splitLines(buf + '\n');
  yield* events;
}

export class Engine {
  constructor(base = '.') {
    this.base = base;
    this.rt = null;
  }

  get url() { return this.rt ? this.rt.url : null; }

  /* runtime.json, re-read every time: each start writes a new token. */
  async locate() {
    try {
      const r = await fetch(`${this.base}/runtime.json`, { cache: 'no-store' });
      this.rt = r.ok ? await r.json() : null;
    } catch (_) { this.rt = null; }
    return this.rt;
  }

  /* Requests the RAGX tool posted while the engine was stopped - read
   * from the plugin folder, so they show with no engine running. */
  async notifications() {
    try {
      const r = await fetch(`${this.base}/notifications.json`, { cache: 'no-store' });
      return r.ok ? (await r.json()).items || [] : [];
    } catch (_) { return []; }
  }

  async local() {
    try {
      const r = await fetch(`${this.base}/local.json`, { cache: 'no-store' });
      return r.ok ? await r.json() : null;
    } catch (_) { return null; }
  }

  async request(method, path, { body, headers = {}, raw = false, signal, timeoutMs = null } = {}) {
    if (!this.rt) throw new EngineDown('The engine is not running.');
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : null].filter(Boolean);
    let res;
    try {
      res = await fetch(this.rt.url + path, {
        method,
        // 'plugin' files these calls as the user's in the tracker.
        headers: { 'x-rag-token': this.rt.token, 'x-rag-client': 'plugin', ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
        signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
        cache: 'no-store',
      });
    } catch (e) {
      if (e.name === 'AbortError' && signal && signal.aborted) throw e;
      throw new EngineDown(`The engine at ${this.rt.url} is not answering.`);
    }
    if (!res.ok) {
      let err = {};
      try { err = (await res.json()).error || {}; } catch (_) {}
      throw new EngineRefused(res.status, err.code || String(res.status), err.message || `The engine answered ${res.status}.`);
    }
    return res;
  }

  async json(method, path, opts) { return (await this.request(method, path, opts)).json(); }

  /* Running means answering, not runtime.json existing. */
  async state() {
    await this.locate();
    if (!this.rt) return null;
    try { return await this.json('GET', '/api/state', { timeoutMs: 5000 }); } catch (e) {
      if (e instanceof EngineDown) return null;
      throw e;
    }
  }

  upload(file) {
    return this.json('POST', '/api/docs', { raw: true, body: file, headers: { 'x-file-name': encodeURIComponent(file.name) } });
  }

  async *ask(body, signal) {
    const res = await this.request('POST', '/api/ask', { body, signal });
    yield* readLines(res);
  }

  async *events(signal) {
    const res = await this.request('GET', '/api/events', { signal });
    yield* readLines(res);
  }

  /* A figure's image as an object URL: an <img> cannot send the token, so it
   * is fetched like any request; kept per figure for the page's lifetime
   * (t-9bea9e80da). */
  async figureUrl(id) {
    this.figures = this.figures || new Map();
    if (!this.figures.has(id)) {
      this.figures.set(id, this.request('GET', `/api/figures/${id}/image`).then((r) => r.blob()).then((b) => URL.createObjectURL(b))
        .catch((e) => { this.figures.delete(id); throw e; }));
    }
    return this.figures.get(id);
  }
}
