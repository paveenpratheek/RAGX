import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Engine } from '../engine/lib/engine.js';
import { Embedder, OLLAMA, DEFAULT_MODEL } from '../engine/lib/embed.js';
import { makeDocx, makePdf, w, READER } from './fixtures.js';
import { fakeOllama } from './ollama-fake.js';

function setup(t, ollama = fakeOllama()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-engine-'));
  const docs = path.join(root, "my docs (Paveen's)");
  fs.mkdirSync(docs);
  const open = (o = ollama) => Engine.open(path.join(root, 'data'), { makeEmbedder: (s) => new Embedder({ ...s, fetch: o.fetch, retries: 0 }), readerOptions: READER });
  const engines = [];
  const engine = (o) => { const e = open(o); engines.push(e); return e; };
  const write = (name, data) => { const f = path.join(docs, name); fs.writeFileSync(f, data); return f; };
  t.after(() => { engines.forEach((e) => { try { e.close(); } catch (_) {} }); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, engine, write, ollama };
}

const leaseMd = '# Lease\n\nThe tenancy runs for two years from January.\n\n## Rent\n\nRent of 1,200 is due on the first of each month.\n';
const invoiceTxt = 'Invoice INV-2024-0042 was settled in full by bank transfer on 3 March.\n\nThank you for your business.';

test('every supported type ingests to ready, with page numbers where there are pages', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  const files = [
    write('lease.md', leaseMd),
    write('invoice.txt', invoiceTxt),
    write('policy.docx', makeDocx([w.p('Leave policy', 'Heading1'), w.p('Staff get twenty days of paid leave a year.')])),
    write('manual.pdf', makePdf([[{ text: 'Safety', size: 18, y: 720 }, { text: 'Wear gloves in the workshop.', y: 690 }], [{ text: 'Keep exits clear at all times.', y: 720 }]])),
  ];
  const results = [];
  for (const f of files) results.push(await e.ingest(f));
  assert.deepEqual(results.map((r) => r.status), ['added', 'added', 'added', 'added']);
  assert.ok(results.every((r) => r.doc.status === 'ready' && r.doc.chunks > 0));
  assert.equal(results[3].doc.pages, 2);
  const pdfPassages = (await e.search('exits clear')).passages;
  assert.equal(pdfPassages[0].docName, 'manual.pdf');
  assert.equal(pdfPassages[0].pageFrom, 1);
  assert.equal(pdfPassages[0].pageTo, 2);
});

test('the same bytes are not indexed twice, whatever the file is called', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  await e.ingest(write('a.txt', invoiceTxt));
  const again = await e.ingest(write('copy of a.txt', invoiceTxt));
  assert.equal(again.status, 'exists');
  assert.equal(e.list().length, 1);
});

test('an exact code is found by keyword search, wording by vector search', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  await e.ingest(write('lease.md', leaseMd));
  await e.ingest(write('invoice.txt', invoiceTxt));
  const byCode = (await e.search('INV-2024-0042')).passages;
  assert.equal(byCode[0].docName, 'invoice.txt');
  assert.ok(byCode[0].ranks.keyword);
  const byWords = (await e.search('when is the rent due each month')).passages;
  assert.equal(byWords[0].docName, 'lease.md');
  assert.equal(byWords[0].heading, 'Lease > Rent');
  assert.ok(byWords[0].ranks.vector && byWords[0].ranks.keyword);
});

test('chunks are embedded with their document and heading path, and stored without them', async (t) => {
  const { engine, write, ollama } = setup(t);
  const e = engine();
  await e.ingest(write('lease.md', leaseMd));
  // The default model, embeddinggemma-2, gets its document task line first (t-6297a0cdf3).
  assert.ok(ollama.inputs.includes('title: none | text: lease.md > Lease > Rent\n\nRent of 1,200 is due on the first of each month.'));
  assert.equal((await e.search('rent due')).passages[0].text, 'Rent of 1,200 is due on the first of each month.');
});

test('an ingest cut short while embedding resumes at the first chunk without a vector', async (t) => {
  // Long enough for more than one step of 32 chunks; Ollama stops after the
  // first step's two batches of 16.
  const long = Array.from({ length: 1500 }, (_, i) => `Clause ${i} sets out obligation number ${i} of the parties.`).join(' ');
  const failing = fakeOllama({ failAfter: 2 });
  const { engine, write } = setup(t, failing);
  const file = write('contract.txt', long);

  const first = await engine(failing).ingest(file);
  assert.equal(first.status, 'error');
  assert.match(first.error, /ollama serve/);
  assert.equal(first.doc.status, 'embedding', 'Ollama stopping does not put the document in error for good');
  const total = first.doc && engine(failing).store.docChunkIds(first.doc.id).length;
  assert.ok(total > 32);

  const working = fakeOllama();
  const e = engine(working);
  const done = await e.resume();
  assert.deepEqual(done.map((r) => r.status), ['resumed']);
  assert.equal(done[0].doc.status, 'ready');
  assert.equal(working.inputs.length, total - 32, 'only the chunks still owed a vector were embedded');
  assert.equal(e.stats().vectors, total);
});

const ledger = Array.from({ length: 200 }, (_, i) => `Row ${i} holds value ${i * 37} for account ${1000 + i}.`).join(' ');

test('the first chunk size comes from the model window, so a dense document is embedded once', async (t) => {
  // 256 tokens of window: inputs up to 640 characters, and the stand-in
  // refuses anything longer - as nomic would refuse a chunk sized for prose.
  const ollama = fakeOllama({ ctx: 256, maxChars: 640 });
  const { engine, write } = setup(t, ollama);
  const r = await engine().ingest(write('ledger.txt', ledger));
  assert.equal(r.status, 'added');
  assert.deepEqual([r.target, r.rechunked, ollama.refusals], [640, 0, 0]);
  assert.ok(ollama.inputs.every((s) => s.length <= 640), 'the document > heading line counts against the size');
});

test('a document denser than the window allows is still chunked again, smaller', async (t) => {
  const ollama = fakeOllama({ ctx: 512, maxChars: 1000 });
  const { engine, write } = setup(t, ollama);
  const r = await engine().ingest(write('ledger.txt', ledger));
  assert.equal(r.status, 'added');
  assert.ok(r.rechunked >= 1 && r.target < 1280);
  assert.ok(ollama.inputs.every((s) => s.length <= 1000));
});

test('a model with a large window keeps chunks at the 1800-character ceiling', async (t) => {
  const { engine, write } = setup(t, fakeOllama({ ctx: 8192 }));
  const r = await engine().ingest(write('ledger.txt', ledger));
  assert.equal(r.target, 1800);
});

test('changing the model blocks search until every document is re-embedded', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  await e.ingest(write('lease.md', leaseMd));
  await assert.rejects(e.setModel({ model: 'missing-model' }), (err) => err.code === 'model-missing');
  assert.equal(e.settings().model, DEFAULT_MODEL, 'a model Ollama does not have never becomes the setting');

  const info = await e.setModel({ model: 'other' });
  assert.deepEqual([info.dim, info.reportedDim, info.stale], [null, 32, 1], 'the size is known only once the model has returned a vector');
  await assert.rejects(e.search('rent'), (err) => err.code === 'needs-reembed' && /reembed/.test(err.message));
  const done = await e.reembed();
  assert.deepEqual(done.map((r) => r.status), ['reembedded']);
  const { passages } = await e.search('when is rent due');
  assert.equal(passages[0].docName, 'lease.md');
  assert.equal(e.stats().dim, 32);

  // The setting persists with the index.
  assert.equal(engine().settings().model, 'other');
});

test("a model whose reported size is not the size it returns still embeds, and the measured size is kept for it", async (t) => {
  // embeddinggemma-2 reports 512 in /api/show and returns 768 (t-064b29db7b).
  const ollama = fakeOllama({ models: { gemma: 48 }, reported: { gemma: 16 } });
  const { engine, write } = setup(t, ollama);
  const e = engine();
  await e.setModel({ model: 'gemma' });
  const r = await e.ingest(write('lease.md', leaseMd));
  assert.equal(r.status, 'added', r.error);
  assert.equal(e.stats().dim, 48);
  assert.equal((await e.search('when is rent due')).passages[0].docName, 'lease.md');
  // Reopened, the engine still knows the size, so a vector of another size is refused.
  const again = engine(fakeOllama({ models: { gemma: 24 } }));
  assert.equal(again.embedder.dim, 48);
  await assert.rejects(again.embedder.embedQuery('rent'), /24 dimensions, expected 48/);
});

test('a query prefix alone does not make documents stale; a document prefix does', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  await e.ingest(write('lease.md', leaseMd));
  assert.equal((await e.setModel({ model: DEFAULT_MODEL, queryPrefix: 'search_query: ' })).stale, 0);
  assert.equal((await e.setModel({ model: DEFAULT_MODEL, docPrefix: 'search_document: ' })).stale, 1);
});

test('a scanned PDF is an error for good, with the reason', async (t) => {
  const { engine, write } = setup(t);
  const r = await engine().ingest(write('scan.pdf', makePdf([[]])));
  assert.equal(r.status, 'error');
  assert.equal(r.doc.status, 'error');
  assert.match(r.error, /scanned/);
});

test('unsupported and unreadable files are reported without being added', async (t) => {
  const { engine, write, root } = setup(t);
  const e = engine();
  assert.match((await e.ingest(write('notes.rtf', 'x'))).error, /not supported/);
  assert.match((await e.ingest(path.join(root, 'nope.txt'))).error, /Cannot read/);
  assert.equal(e.list().length, 0);
});

test('removing a document forgets it and deletes its copy', async (t) => {
  const { engine, write } = setup(t);
  const e = engine();
  const r = await e.ingest(write('invoice.txt', invoiceTxt));
  await e.search('invoice');
  const copy = e.fileOf(r.doc);
  assert.ok(fs.existsSync(copy));
  e.remove(r.doc.id);
  assert.ok(!fs.existsSync(copy));
  assert.deepEqual((await e.search('INV-2024-0042')).passages, []);
});

test('with Ollama down, search falls back to keywords and says so', async (t) => {
  const { engine, write } = setup(t);
  await engine().ingest(write('invoice.txt', invoiceTxt));
  const down = fakeOllama({ failAfter: 0 });
  const { passages, warning } = await engine(down).search('INV-2024-0042');
  assert.equal(passages[0].docName, 'invoice.txt');
  assert.match(warning, /Keyword search only/);
});

/* The command-line tool's refusals, which need no Ollama. */
const cli = (...args) => spawnSync(process.execPath, ['engine/cli.js', ...args], { encoding: 'utf8' });

test('the CLI insists on a data folder and names unknown commands', () => {
  const none = cli('list');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--data-dir/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-cli-'));
  try {
    const bad = cli('--data-dir', dir, 'frobnicate');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown command: frobnicate/);
    const list = cli('--data-dir', dir, 'list');
    assert.equal(list.status, 0);
    assert.match(list.stdout, /No documents yet/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* Meaning, not words: against the real model, when Ollama is running. */
const hasNomic = await fetch(OLLAMA + '/api/show', { method: 'POST', body: JSON.stringify({ model: DEFAULT_MODEL }) }).then((r) => r.ok).catch(() => false);

test('live: a question worded differently from the document finds it by meaning', { skip: !hasNomic && 'Ollama or nomic is not available' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-live-'));
  const e = Engine.open(path.join(root, 'data'), { readerOptions: READER });
  t.after(() => { e.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (name, text) => { const f = path.join(root, name); fs.writeFileSync(f, text); return e.ingest(f); };
  await add('leave.txt', 'Employees are entitled to twenty days of paid annual leave.');
  await add('parking.txt', 'Visitor parking is available behind the main building.');
  await add('expenses.txt', 'Travel expenses are reimbursed within thirty days of a claim.');
  const { passages } = await e.search('How much holiday do workers get?');
  assert.equal(passages[0].docName, 'leave.txt');
  assert.equal(passages[0].ranks.keyword, null, 'no word of the question is in the document - found by meaning alone');
});
