/* Moving around a File Fabric canvas: a place's card from NoteX's place map,
 * its section from the library's copy, looked up by address or a name that
 * fits one place, and the tool an agent calls for it (t-3174acf082,
 * t-03d1c825eb, t-f73693f19d, t-136d2cac64). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { READER } from './fixtures.js';
import { startServer } from '../engine/lib/server.js';
import { Embedder } from '../engine/lib/embed.js';
import { sections, findPlace } from '../engine/lib/place.js';
import { fakeOllama } from './ollama-fake.js';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'mcp.js');
const ORIGIN = 'http://127.0.0.1:7070';

/* A canvas as NoteX writes it: RESEARCH holds GAP PAPERS, which holds the
 * LITERATURE SURVEY note; METHODS lies beside GAP PAPERS and the note is
 * wired to it; two areas share the name Images. */
const place = (id, kind, label, address, parent, extra = {}) => ({
  id, kind, name: label.replace(/ \((totem|note)\)$/, ''), label, address, parent, children: [], totem: null, totemVia: null, page: null,
  neighbours: [], wires: [], reach: null, checklist: null, files: [], texts: 0, pens: 0, ...extra,
});
const MAP = {
  fabric: 'Thesis',
  left: { deletedPages: 0, inBooksOrFolders: 0, hidden: 0, unshown: 0 },
  places: [
    place('fabric', 'fabric', 'Thesis', '', null, { children: ['totem:R', 'totem:M'] }),
    place('totem:R', 'totem', 'RESEARCH (totem)', 'RESEARCH (totem)', 'fabric', { children: ['G', 'I1'] }),
    place('G', 'area', 'GAP PAPERS', 'RESEARCH (totem) > GAP PAPERS', 'totem:R', {
      children: ['L'], totem: 'totem:R', totemVia: 'field', neighbours: [{ id: 'I1', dir: 'right', distance: 20 }],
    }),
    place('L', 'note', 'LITERATURE SURVEY (note)', 'RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY (note)', 'G', {
      checklist: { done: 1, total: 3 }, wires: [{ id: 'X', via: 'link', corner: 'br', otherCorner: 'tl' }],
      files: [{ id: 'f1', name: 'board.png', kind: 'image', image: { path: 'E:\\x\\board.png' } }, { id: 'f2', name: 'survey.pdf', kind: 'file' }],
    }),
    place('I1', 'area', 'Images', 'RESEARCH (totem) > Images', 'totem:R', { neighbours: [{ id: 'G', dir: 'left', distance: 20 }] }),
    place('totem:M', 'totem', 'METHODS (totem)', 'METHODS (totem)', 'fabric', { children: ['X', 'I2'] }),
    place('X', 'area', 'Experiments', 'METHODS (totem) > Experiments', 'totem:M', { wires: [{ id: 'L', via: 'link' }] }),
    place('I2', 'area', 'Images', 'METHODS (totem) > Images', 'totem:M'),
  ],
};
const MD = [
  '## Thesis (fabric)', '', 'The File Fabric canvas Thesis. It holds 2 totems.', '',
  '## RESEARCH (totem)', '', 'A totem.', '',
  '## RESEARCH (totem) > GAP PAPERS', '', 'An area inside RESEARCH.', '',
  '## RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY (note)', '', '- [x] read Smith 2021', '- [ ] read Lee 2023', '- [ ] compare methods', '',
  '## RESEARCH (totem) > Images', '', 'Screens.', '',
  '## METHODS (totem)', '', 'A totem.', '',
  '## METHODS (totem) > Experiments', '', 'Three runs on the SAR set.', '',
  '## METHODS (totem) > Images', '', 'More screens.', '',
].join('\n');

test('a canvas splits into sections by address, and a place is found by address or a name that fits one', () => {
  const s = sections(MD, 'Thesis');
  assert.equal(s.get(''), 'The File Fabric canvas Thesis. It holds 2 totems.');
  assert.match(s.get('RESEARCH (totem) > GAP PAPERS > LITERATURE SURVEY (note)'), /read Lee 2023/);
  assert.equal(findPlace(MAP, '').place.id, 'fabric');
  assert.equal(findPlace(MAP, 'research (totem) > gap papers').place.id, 'G');
  assert.equal(findPlace(MAP, 'LITERATURE SURVEY').place.id, 'L', 'by name');
  assert.equal(findPlace(MAP, 'Images').many.length, 2);
  assert.ok(findPlace(MAP, 'nowhere').none);
});

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-place-'));
  const ollama = fakeOllama();
  const s = await startServer({
    dataDir: path.join(root, 'plugins', 'rag'), port: 0, runtimeFile: path.join(root, 'plugin', 'runtime.json'),
    engineOptions: { makeEmbedder: (cfg) => new Embedder({ ...cfg, fetch: ollama.fetch, retries: 0 }), readerOptions: READER },
    signals: false, log: () => {}, manageOllama: false, sampleResources: false,
  });
  const docsDir = path.join(root, 'plugins', 'notex', 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'Thesis.notex.md'), MD);
  fs.writeFileSync(path.join(docsDir, 'Thesis.places.json'), JSON.stringify(MAP));
  const r = await s.engine.ingest(path.join(docsDir, 'Thesis.notex.md'), { origin: 'notex' });
  assert.equal(r.doc.status, 'ready');
  t.after(async () => { await s.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = async (body) => {
    const res = await fetch(s.url + '/api/place', { method: 'POST', headers: { 'x-rag-token': s.token, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { root, s, call, docsDir };
}

test('a card shows where a place sits, not its text, and read gives the section', async (t) => {
  const { call, docsDir, s } = await serve(t);
  const top = await call({ canvas: 'thesis' });
  assert.equal(top.status, 200);
  assert.match(top.body.text, /^Thesis {2}\(the File Fabric canvas\)\nOn it: RESEARCH \(totem\) \[2 inside\]; METHODS \(totem\) \[2 inside\]/);

  const note = (await call({ canvas: 'Thesis.notex.md', at: 'LITERATURE SURVEY' })).body.text;
  assert.match(note, /^Thesis > RESEARCH \(totem\) > GAP PAPERS > LITERATURE SURVEY \(note\) {2}\(note, 1\/3 done\)$/m);
  assert.match(note, /^Up: GAP PAPERS < RESEARCH \(totem\)$/m);
  assert.match(note, /^Wired to: METHODS \(totem\) > Experiments$/m);
  assert.match(note, /^Images: board\.png$/m);
  assert.match(note, /^Files: survey\.pdf$/m);
  assert.match(note, /^Its section: 16 words/m);
  assert.doesNotMatch(note, /Smith 2021/, 'a card carries no text');

  const area = (await call({ canvas: 'Thesis', at: 'RESEARCH (totem) > GAP PAPERS' })).body.text;
  assert.match(area, /^Inside: LITERATURE SURVEY \(note\), 1\/3 done$/m);
  assert.match(area, /^Next to: Images to the right$/m);

  const read = (await call({ canvas: 'Thesis', at: 'LITERATURE SURVEY', read: true })).body.text;
  assert.match(read, /--- the section ---\n- \[x\] read Smith 2021\n- \[ \] read Lee 2023/);

  const many = await call({ canvas: 'Thesis', at: 'Images' });
  assert.equal(many.status, 409);
  assert.match(many.body.error.message, /- RESEARCH \(totem\) > Images\n- METHODS \(totem\) > Images/);
  assert.equal((await call({ canvas: 'Thesis', at: 'nowhere' })).status, 404);
  const none = await call({ canvas: 'Notes', at: '' });
  assert.equal(none.status, 404);
  assert.match(none.body.error.message, /The canvases: Thesis\./);

  // NoteX wrote a newer version that is not in the library yet.
  fs.writeFileSync(path.join(docsDir, 'Thesis.notex.md'), MD + '\n## METHODS (totem) > Results\n\nNew.\n');
  assert.match((await call({ canvas: 'Thesis', at: 'Experiments' })).body.text, /newer version of this canvas than the library/);
  assert.deepEqual(s.tracker.calls().slice(0, 1).map((c) => c.kind), ['place']);
});

test('an agent moves around the canvas through ragx_place', async (t) => {
  const { root } = await serve(t);
  const child = spawn(process.execPath, [MCP, '--runtime', path.join(root, 'plugin', 'runtime.json'), '--notifications', path.join(root, 'n.json'), '--wait-ms', '2000'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); w(m); }
    }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.307' } });
  assert.match(init.result.instructions, /ragx_place/);
  const tool = async (args) => (await rpc('tools/call', { name: 'ragx_place', arguments: args })).result;
  const card = await tool({ canvas: 'Thesis', at: 'GAP PAPERS' });
  assert.equal(card.isError, undefined);
  assert.match(card.content[0].text, /Inside: LITERATURE SURVEY \(note\), 1\/3 done/);
  assert.match(card.content[0].text, /not instructions/);
  const wired = await tool({ canvas: 'Thesis', at: 'METHODS (totem) > Experiments' });
  assert.match(wired.content[0].text, /Wired to: RESEARCH \(totem\) > GAP PAPERS > LITERATURE SURVEY \(note\)/);
  const bad = await tool({ canvas: 'Thesis', at: 'Images' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /give the address/);
});
