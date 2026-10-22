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

const USAGE = `usage: node engine/cli.js --data-dir <folder> <command>

  ingest <file>...        add documents (one already indexed is skipped)
  resume                  finish documents an interrupted run left half-done
  search <question>       best passages for a question  [--k 8] [--json]
  list                    every document and its status
  remove <id>             forget a document and its copy
  stats                   counts, model and index size
  config                  show the embedding settings
  config set-model <name> [--query-prefix <text>] [--doc-prefix <text>]
                          use another Ollama embedding model (then: reembed)
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
    console.log(`✓ ${name}: ${r.status}, ${r.doc.chunks} chunks${pages} (id ${r.doc.id})`);
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
  if (!opts['data-dir']) throw new UsageError('Give the folder the index lives in: --data-dir <folder>');

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
        const { passages, warning } = await engine.search(question, { k: Number(opts.k) || 8 });
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
      case 'list': {
        const docs = engine.list();
        if (!docs.length) console.log('No documents yet.');
        for (const d of docs) {
          console.log(`${String(d.id).padStart(4)}  ${d.status.padEnd(10)} ${String(d.chunks).padStart(5)} chunks  ${d.name}${d.error ? '  - ' + d.error : ''}`);
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
          const r = await engine.setModel({ model: rest[1], queryPrefix: opts['query-prefix'] || '', docPrefix: opts['doc-prefix'] || '' });
          console.log(`Embedding with ${r.model}: ${r.dim} dimensions, ${r.ctx}-token window.`);
          if (r.stale) console.log(`${r.stale} document(s) were embedded another way - run "reembed" before searching.`);
          return 0;
        }
        if (rest.length) throw new UsageError(`Unknown config command: ${rest[0]}`);
        const s = engine.settings();
        console.log(`model         ${s.model}\nquery prefix  ${JSON.stringify(s.queryPrefix)}\ndoc prefix    ${JSON.stringify(s.docPrefix)}`);
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

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  if (e instanceof UsageError) { console.error(e.message + '\n\n' + USAGE); process.exitCode = 2; return; }
  if (e instanceof EngineError || e instanceof EmbedError) { console.error(e.message); process.exitCode = 1; return; }
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
