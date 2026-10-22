/* Open agy sessions, one per conversation, while the engine runs as a server
 * (t-53c25eef6e).
 *
 * A session idle for 10 minutes is closed, and at most 2 are open at once
 * (t-405a57d387): this laptop has 8 GB of RAM with little free, and every
 * open agy holds a process and its own session. When a third is needed the
 * one idle longest is closed first; if every open one is mid-answer the
 * question is refused rather than a third started.
 *
 * A session that dies - time-out, cancel, crash - leaves the pool, and the
 * conversation's next question opens a fresh one resumed by its id.
 *
 * One spare may wait ready: agy does its ~67 s of startup at launch, so a
 * process started ahead of the question answers in about 44 s instead of
 * 109 (t-23f56c6806). A spare has no conversation yet, so it can only serve
 * a new one with the same model; it counts toward the limit and closes when
 * idle like any other.
 */
import { AgentError } from './runner.js';

const SPARE = Symbol('spare');

export class AgentPool {
  constructor({ open, max = 2, idleMs = 10 * 60_000, sweepMs = 30_000 }) {
    this.open = open;           // ({ resume, model }) => a session with ask/close/kill/busy/alive/lastUsed
    this.max = max;
    this.idleMs = idleMs;
    this.sessions = new Map();  // conversation id -> session
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref();
  }

  live() {
    for (const [key, s] of this.sessions) if (!s.alive) this.sessions.delete(key);
    return this.sessions;
  }

  /* The open session for a conversation, or a new one. key null means a
   * conversation not created yet - the caller adopts it once it has an id. */
  async session(key, { resume = null, model = null } = {}) {
    const live = this.live();
    const existing = key != null ? live.get(key) : null;
    if (existing) {
      if (existing.busy) throw new AgentError('busy', 'agy is still answering the last question in this conversation.');
      return existing;
    }
    // A new conversation takes the warm spare when it matches.
    const spare = live.get(SPARE);
    if (key == null && !resume && spare && !spare.busy && (spare.model || null) === (model || null)) {
      live.delete(SPARE);
      live.set(Symbol('new'), spare);
      return spare;
    }
    if (live.size >= this.max) {
      // The spare goes first when room is needed; then the one idle longest
      // (t-b0de20d6cc). Both answering: refused, not a third (t-42ffc1b3f8).
      const idle = [...live.entries()].filter(([, s]) => !s.busy)
        .sort((a, b) => (b[0] === SPARE) - (a[0] === SPARE) || a[1].lastUsed - b[1].lastUsed);
      if (!idle.length) {
        throw new AgentError('pool-full', `${this.max} agy conversations are already answering; ask again when one has finished.`);
      }
      const [oldKey, oldest] = idle[0];
      live.delete(oldKey);
      await oldest.close();
    }
    const s = this.open({ resume, model });
    /* A new conversation has no id until its first answer is stored; it is
     * held under a key of its own meanwhile, so it counts toward the limit
     * and a stop still finds it (t-d43c8cb45c). */
    live.set(key != null ? key : Symbol('new'), s);
    return s;
  }

  keyOf(session) {
    for (const [k, s] of this.sessions) if (s === session) return k;
    return undefined;
  }

  adopt(key, session) {
    const old = this.keyOf(session);
    if (old !== undefined) this.sessions.delete(old);
    if (session.alive) this.sessions.set(key, session);
  }

  /* Start the spare if there is none and there is room for it. Never closes a
   * conversation's session to make room: a spare is worth less than one in
   * use. */
  warm({ model = null } = {}) {
    const live = this.live();
    const spare = live.get(SPARE);
    if (spare && (spare.model || null) === (model || null)) return spare;
    if (spare) { live.delete(SPARE); spare.close(); }
    if (live.size >= this.max) return null;
    const s = this.open({ resume: null, model });
    live.set(SPARE, s);
    return s;
  }

  hasSpare() { return this.live().has(SPARE); }

  /* A session that failed mid-turn may still be writing that turn's output:
   * end it, so it never answers the next question (t-cbaceb1b84). */
  discard(key, session) {
    const k = this.keyOf(session);
    if (k !== undefined) this.sessions.delete(k);
    session.kill();
  }

  async sweep(now = Date.now()) {
    for (const [key, s] of this.live()) {
      if (!s.busy && now - s.lastUsed >= this.idleMs) {
        this.sessions.delete(key);
        await s.close();
      }
    }
  }

  list() {
    return [...this.live().entries()].map(([key, s]) => ({
      conversationId: typeof key === 'symbol' ? null : key, spare: key === SPARE, pid: s.pid, busy: s.busy, idleMs: Date.now() - s.lastUsed,
    }));
  }

  async closeAll() {
    clearInterval(this.sweeper);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => (s.busy ? Promise.resolve(s.kill()) : s.close())));
  }
}
