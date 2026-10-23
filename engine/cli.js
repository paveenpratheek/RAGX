#!/usr/bin/env node
/* The engine from a terminal.
 *
 *   node engine/cli.js --data-dir <folder> <command> [...]
 *
 * --data-dir is required and has no default: where the index lives is the
 * caller's decision - the plugin will pass the folder ter-manager hands it -
 * and a guessed default is where data goes that nobody backs up (t-1c2944e8bf).
 */
import path from 'node:path';
import { Engine, EngineError } from './lib/engine.js';
import { EmbedError } from './lib/embed.js';
import { ask, label, AskError, AgentError, AGENTS } from './lib/answer.js';
import { startServer } from './lib/server.js';
import { Tracker } from './lib/tracker.js';
import { LockError, writeLocal, REPO } from './lib/lifecycle.js';

/* config set keys and the meta entries they write. */
const SETTINGS = {
  agent: { meta: 'agent', check: (v) => (AGENTS[v] ? null : `agent must be ${Object.keys(AGENTS).join(' or ')}`) },
  'claude-model': { meta: 'claude_model' },
  'agy-model': { meta: 'agy_model' },
  'claude-path': { meta: 'claude_path' },
  'agy-path': { meta: 'agy_path' },
};

const USAGE = `usage: node engine/cli.js --data-dir <folder> <command>
       node engine/cli.js plugin-setup     (once: tells the plugin where the engine is)

  ingest <file>...        add documents (one already indexed is skipped)
  resume                  finish documents an interrupted run left half-done
  search <question>       best passages for a question  [--k 8] [--json]
  ask <question>          a cited answer from Claude or agy
                          [--agent claude|agy] [--model <name>] [--conversation <id>] [--json]
  conversations [<id>]    past conversations, or one in full
  serve                   run as the plugin's server on 127.0.0.1  [--port 7780]
                          [--origin <url,url>]  (Ctrl+C stops it)
  list                    every document and its status
  remove <id>             forget a document and its copy
  stats                   counts, model and index size
  config                  show the embedding settings
  config set-model <name> [--query-prefix <text>] [--doc-prefix <text>]
                          use another Ollama embedding model (then: reembed)
  config set <key> <value>  agent (claude|agy), claude-model, agy-model,
                          claude-path, agy-path
  reembed                 rebuild every vector with the current model`;

function parse(argv) {
  const opts = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'json' || key === 'help') opts[key] = true;
      else if (i + 1 < argv.length) opts[key] = argv[++i];
      else throw new UsageError(`${a} needs a value.`);
    } else args.push(a);
  }
  return { opts, args };
}

class UsageError extends Error {}

/* One line per document as it moves through the pipeline; embedding progress
 * every tenth of the way, so a long PDF shows it is alive without flooding a
 * terminal pane. */
function progress() {
  const last = new Map();
  return ({ doc, phase, done, total }) => {
    if (phase === 'embedding') {
      const step = Math.max(1, Math.ceil(total / 10));
      const prev = last.get(doc.id) ?? -1;
      if (done !== total && Math.floor(done / step) === Math.floor(prev / step) && prev !== -1) return;
      last.set(doc.id, done);
      console.log(`  ${doc.name}: embedding ${done}/${total}`);
    } else if (phase === 'extracting') console.log(`  ${doc.name}: reading`);
  };
}

function report(r) {
  const name = r.doc ? r.doc.name : r.name;
  if (r.status === 'error') console.log(`✗ ${name}: ${r.error}`);
  else if (r.status === 'exists') console.log(`= ${name}: already indexed (id ${r.doc.id})`);
  else {
    const pages = r.doc.pages ? `, ${r.doc.pages} pages` : '';
    const again = r.rechunked ? ` - chunked again at ${r.target} characters, too dense for the model` : '';
    const figures = r.figures ? `, ${r.figures} figure${r.figures === 1 ? '' : 's'}` : '';
    console.log(`✓ ${name}: ${r.status}, ${r.doc.chunks} chunks${figures}${pages} (id ${r.doc.id})${again}`);
    if (r.figureError) console.log(`  figures could not be read: ${r.figureError}`);
  }
}

function where(p) {
  if (p.pageFrom == null) return '';
  return p.pageFrom === p.pageTo ? ` p.${p.pageFrom}` : ` pp.${p.pageFrom}-${p.pageTo}`;
}

async function main(argv) {
  const { opts, args } = parse(argv);
  const [command, ...rest] = args;
  if (opts.help || !command) { console.log(USAGE); return command ? 0 : 2; }

  if (command === 'plugin-setup') {
    const info = writeLocal(path.join(REPO, 'plugin', 'local.json'));
    console.log(`Wrote plugin/local.json: the plugin will start ${info.cli} with ${info.node}.`);
    console.log(`Install the plugin in ter-manager by pointing it at ${path.join(REPO, 'plugin')}.`);
    return 0;
  }
  if (!opts['data-dir']) throw new UsageError('Give the folder the index lives in: --data-dir <folder>');

  /* The server owns its engine for as long as it runs, so it starts before
   * the open-and-close every other command does. */
  if (command === 'serve') {
    const s = await startServer({
      dataDir: opts['data-dir'],
      port: opts.port ? Number(opts.port) : undefined,
      origins: opts.origin ? opts.origin.split(',').map((o) => o.trim()) : undefined,
      onStopped: () => process.exit(0),
    });
    for (const o of s.orphans) console.log(`Ended ${o.image} (pid ${o.pid}), left running by an earlier engine.`);
    console.log(`RAG engine ready at ${s.url}`);
    console.log(`  data     ${s.engine.dir}`);
    console.log(`  runtime  ${s.runtimeFile}`);
    console.log('  Ctrl+C stops it; closing the plugin does not.');
    return null;
  }

  const engine = Engine.open(opts['data-dir']);
  try {
    switch (command) {
      case 'ingest': {
        if (!rest.length) throw new UsageError('ingest needs at least one file.');
        const on = progress();
        let failed = 0;
        for (const file of rest) {
          const r = await engine.ingest(file, { onProgress: on });
          report(r);
          if (r.status === 'error') failed++;
        }
        return failed ? 1 : 0;
      }
      case 'resume': {
        const done = await engine.resume({ onProgress: progress() });
        if (!done.length) console.log('Nothing to resume.');
        done.forEach(report);
        return done.some((r) => r.status === 'error') ? 1 : 0;
      }
      case 'search': {
        const question = rest.join(' ').trim();
        if (!question) throw new UsageError('search needs a question.');
        const started = Date.now();
        const { passages, warning, timings } = await engine.search(question, { k: Number(opts.k) || 8 });
        new Tracker(engine.store).record({ source: 'cli', client: 'cli', kind: 'search', question, ms: Date.now() - started, timings,
          results: passages.length, detail: { passages: passages.map((p) => ({ docName: p.docName, heading: p.heading, pageFrom: p.pageFrom, pageTo: p.pageTo, score: p.score, chunkIds: p.chunkIds, text: p.text })), warning } });
        if (opts.json) { console.log(JSON.stringify({ passages, warning }, null, 2)); return 0; }
        if (warning) console.log(`! ${warning}\n`);
        if (!passages.length) console.log('No passages found.');
        passages.forEach((p, i) => {
          const why = [p.ranks.vector && `vector #${p.ranks.vector}`, p.ranks.keyword && `keyword #${p.ranks.keyword}`].filter(Boolean).join(', ');
          console.log(`[${i + 1}] ${p.docName}${where(p)}${p.heading ? ' - ' + p.heading : ''}  (${why})`);
          const text = p.text.replace(/\s+/g, ' ');
          console.log('    ' + (text.length > 400 ? text.slice(0, 400) + '...' : text) + '\n');
        });
        return 0;
      }
      case 'ask': {
        const question = rest.join(' ').trim();
        if (!question) throw new UsageError('ask needs a question.');
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.once('SIGINT', stop);
        let r;
        try {
          r = await ask(engine, {
            question, agent: opts.agent || null, model: opts.model || null,
            conversationId: opts.conversation ? Number(opts.conversation) : null,
            k: Number(opts.k) || 8, signal: ac.signal,
            onDelta: opts.json ? () => {} : (d) => process.stdout.write(d),
          });
        } finally { process.off('SIGINT', stop); }
        new Tracker(engine.store).record({ source: 'cli', client: 'cli', kind: 'ask', question, agent: r.agent, model: r.model,
          ms: r.timings ? (r.timings.embedMs + r.timings.searchMs + r.timings.agentMs) : null, timings: r.timings, results: r.sources.length,
          detail: { conversationId: r.conversationId, answer: r.answer, cited: r.cited.map((s) => s.n), unknown: r.unknown } });
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
        if (!r.asked) console.log(r.answer);
        console.log('');
        for (const w of r.warnings) console.log(`! ${w}`);
        if (r.unknown.length) console.log(`! The answer cites ${r.unknown.map((n) => `[${n}]`).join(' ')}, which no source has that number - treat it with care.`);
        if (r.cited.length) {
          console.log('\nSources:');
          for (const s of r.cited) console.log('  ' + label(s));
        } else if (r.asked) console.log('\n(The answer cites no source.)');
        if (r.conversationId) console.log(`\n${r.agent}${r.model ? ' ' + r.model : ''} · conversation ${r.conversationId} - follow up with --conversation ${r.conversationId}`);
        return 0;
      }
      case 'conversations': {
        if (rest[0]) {
          const id = Number(rest[0]);
          const c = engine.store.conversation(id);
          if (!c) throw new UsageError(`No conversation ${rest[0]}.`);
          console.log(`Conversation ${c.id} with ${c.agent}${c.model ? ' ' + c.model : ''}, session ${c.session || '-'}\n`);
          const sources = new Map(engine.store.sources(id).map((s) => [s.n, s]));
          for (const m of engine.store.messages(id)) {
            console.log(m.role === 'user' ? `> ${m.text}` : m.text);
            if (m.role === 'assistant' && m.cited.length) console.log(m.cited.map((n) => '  ' + label(sources.get(n))).join('\n'));
            console.log('');
          }
          return 0;
        }
        const all = engine.store.conversations();
        if (!all.length) console.log('No conversations yet.');
        for (const c of all) console.log(`${String(c.id).padStart(4)}  ${c.agent.padEnd(6)} ${String(c.questions).padStart(3)} questions  ${c.title}`);
        return 0;
      }
      case 'list': {
        const docs = engine.list();
        if (!docs.length) console.log('No documents yet.');
        for (const d of docs) {
          console.log(`${String(d.id).padStart(4)}  ${d.status.padEnd(10)} ${String(d.chunks).padStart(5)} chunks ${String(d.figures || 0).padStart(3)} figures  ${d.name}${d.error ? '  - ' + d.error : ''}`);
        }
        return 0;
      }
      case 'remove': {
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) throw new UsageError('remove needs a document id (see list).');
        const doc = engine.remove(id);
        console.log(`Removed ${doc.name}.`);
        return 0;
      }
      case 'stats': {
        const s = engine.stats();
        console.log(`documents ${s.docs}, chunks ${s.chunks}, vectors ${s.vectors}`);
        console.log(`model ${s.model}${s.dim ? ` (${s.dim} dimensions)` : ''}`);
        console.log(`index ${(s.bytes / 1024 / 1024).toFixed(1)} MB in ${path.join(s.dir, 'rag.db')}`);
        return 0;
      }
      case 'config': {
        if (rest[0] === 'set-model') {
          if (!rest[1]) throw new UsageError('config set-model needs a model name.');
          // Prefixes not given are the model's own; --query-prefix "" sets none.
          const r = await engine.setModel({ model: rest[1], queryPrefix: opts['query-prefix'], docPrefix: opts['doc-prefix'] });
          console.log(`Embedding with ${r.model}: ${r.dim ? `${r.dim} dimensions` : 'dimensions measured on the first embedding'}, ${r.ctx}-token window.`);
          if (r.stale) console.log(`${r.stale} document(s) were embedded another way - run "reembed" before searching.`);
          return 0;
        }
        if (rest[0] === 'set') {
          const [, key, ...value] = rest;
          const def = SETTINGS[key];
          if (!def) throw new UsageError(`config set takes ${Object.keys(SETTINGS).join(', ')}.`);
          const v = value.join(' ').trim();
          const bad = def.check && def.check(v);
          if (bad) throw new UsageError(bad);
          engine.store.setMeta(def.meta, v);
          console.log(v ? `${key} = ${v}` : `${key} cleared`);
          return 0;
        }
        if (rest.length) throw new UsageError(`Unknown config command: ${rest[0]}`);
        const s = engine.settings();
        const m = (k, d = '-') => engine.store.getMeta(k, '') || d;
        console.log(`embedding     ${s.model}\nquery prefix  ${JSON.stringify(s.queryPrefix)}\ndoc prefix    ${JSON.stringify(s.docPrefix)}`);
        console.log(`agent         ${m('agent', 'claude')}\nclaude model  ${m('claude_model', AGENTS.claude.DEFAULT_MODEL)}\nagy model     ${m('agy_model', "agy's default")}`);
        console.log(`claude path   ${m('claude_path', 'from PATH')}\nagy path      ${m('agy_path', 'from PATH')}`);
        return 0;
      }
      case 'reembed': {
        const done = await engine.reembed({ onProgress: progress() });
        if (!done.length) console.log('Every document is already embedded with the current model.');
        done.forEach(report);
        return done.some((r) => r.status === 'error') ? 1 : 0;
      }
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } finally {
    engine.close();
  }
}

main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { console.error(e.message + '\n\n' + USAGE); process.exitCode = 2; return; }
  if (e instanceof EngineError || e instanceof EmbedError || e instanceof AskError || e instanceof AgentError || e instanceof LockError) {
    console.error(e.message);
    process.exitCode = e.code === 'cancelled' ? 130 : 1;
    return;
  }
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
