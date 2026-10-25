/* The RAGX plugin: the page ter-manager shows for the RAG engine.
 *
 * It never reaches into ter-manager: everything it asks of the host goes
 * through plugin-host.js messages - open a terminal, remember a preference,
 * follow the theme, ask for its data folder. Everything about documents and
 * answers is the engine's, over loopback HTTP.
 *
 * Names and text from documents are only ever set with textContent, never
 * written into HTML or inline handlers: a file called "Paveen's notes.pdf"
 * must not break a button, and a passage holding <script> must show as text
 * (t-1c6e343d0e).
 */
import { Engine, EngineDown, EngineRefused } from './api.js';
import { parse, toDom } from './md.js';
import { followWallpaper } from './wallpaper.js';

const TM = window.TerManager;
const engine = new Engine('.');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const S = {
  up: false, checked: false, state: null, local: null, dataDir: null, repo: null,
  tab: 'ask', agent: 'claude', model: 'sonnet',
  conv: null, convAgent: null, sources: new Map(), asking: null,
  docs: new Map(), progress: new Map(), events: null, startedAt: 0,
  libFilter: 'all', notex: null, scope: null,
};

/* ------------------------------------------------------------ the host */

/* host.dataDir is on the host API but plugin-host.js has no helper for it,
 * so it is asked with the same message shape the helpers use. */
let seq = 1_000_000;
const waiting = new Map();
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  const m = e.data;
  if (!m || m.__tm !== 1 || typeof m.id !== 'number' || !waiting.has(m.id)) return;
  const w = waiting.get(m.id);
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error || 'refused'));
});
function hostCall(method, params = {}) {
  if (!TM || !TM.isHosted) return Promise.reject(new Error('not inside ter-manager'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    window.parent.postMessage({ __tm: 1, id, method, params }, location.origin);
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('ter-manager did not answer')); }, 10_000);
  });
}
const remember = (key, value) => TM && TM.storage.set(key, value).catch(() => {});
const recall = async (key, fallback) => { try { const v = TM && await TM.storage.get(key); return v ?? fallback; } catch (_) { return fallback; } };

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
}

/* ------------------------------------------------------- engine status */

function startCommand() {
  const node = S.local && S.local.node ? `"${S.local.node}"` : 'node';
  const cli = S.repo ? `"${S.repo.replace(/[\\/]+$/, '')}\\engine\\cli.js"` : '"<engine folder>\\engine\\cli.js"';
  return `${node} ${cli} --data-dir "${S.dataDir || '<data folder>'}" serve`;
}

function setStatus(kind, text) {
  $('dot').className = 'dot' + (kind === 'up' ? ' up' : kind === 'wait' ? ' wait' : '');
  $('status').textContent = text;
}

/* Notifications stay open with the engine stopped - that is when agents'
 * requests arrive; every other tab needs the engine (t-37579410a9). */
function showOffline() {
  const notes = S.tab === 'notifications';
  $('offline').hidden = notes;
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = !(notes && p.dataset.panel === 'notifications'); });
  $('ollama').hidden = true;
  $('stale').hidden = true;
  $('start-cmd').textContent = startCommand();
  $('data-dir').textContent = S.dataDir || 'not given yet';
  $('repo-form').hidden = Boolean(S.repo);
  $('start-btn').disabled = !S.repo || !S.dataDir;
}

function showOnline() {
  $('offline').hidden = true;
  showTab(S.tab);
}

async function refresh() {
  let st = null;
  try { st = await engine.state(); } catch (e) { toast(e.message, true); }
  const was = S.up;
  S.up = Boolean(st);
  S.checked = true;
  S.state = st;
  if (S.up !== was) renderNotes();
  if (!st) {
    stopEvents();
    renderPool([]); // a stopped engine holds no agents
    S.progress.clear();
    const starting = Date.now() - S.startedAt < 90_000;
    setStatus(starting ? 'wait' : 'down', starting ? 'Starting the engine…' : 'Engine stopped');
    showOffline();
    return;
  }
  setStatus('up', `Engine running · ${st.totals.docs} documents`);
  if (S.dataDir && st.dataDir && st.dataDir.toLowerCase() !== S.dataDir.toLowerCase()) {
    toast(`This engine keeps its data in ${st.dataDir}, not ${S.dataDir}.`, true);
  }
  showOnline();
  showOllama(st.ollama);
  showStale(st);
  renderSettings();
  renderPool(st.pool);
  if (!was) {
    startEvents();
    await Promise.all([loadDocs(), loadConversations()]);
    if (S.agent === 'agy') warm();
  }
}

/* Documents embedded with another model are refused by search until they are
 * embedded again - after the switch to embeddinggemma-2 that is every one
 * (t-5dbc6f6669) - so the page says so where it is seen and offers the fix. */
function showStale(st) {
  const n = st.stale || 0;
  $('stale').hidden = !n;
  if (!n) return;
  $('stale-msg').textContent = `${n} document${n === 1 ? ' was' : 's were'} embedded with another model. Questions cannot be searched until ${n === 1 ? 'it is' : 'they are'} embedded again with ${st.settings.model}.`;
  $('stale-reembed').disabled = Boolean(st.queue && st.queue.length) || Boolean(st.ingesting);
}

function showOllama(o) {
  const box = $('ollama');
  if (!o || o.state === 'up') { box.hidden = true; return; }
  box.hidden = false;
  $('ollama-start').hidden = o.state !== 'down';
  $('ollama-pull').hidden = o.state !== 'model-missing';
  $('ollama-msg').textContent = o.state === 'down' ? (o.startError ? `The engine could not start Ollama: ${o.startError}` : 'Ollama is not running - documents cannot be read and questions are searched by keyword only.')
    : o.state === 'model-missing' ? `The embedding model ${o.model} is not downloaded.` : `Ollama: ${o.error || o.state}`;
}

function openTerminal(cmd, title) {
  if (!TM || !TM.isHosted) { toast(`Run in a terminal: ${cmd}`); return Promise.resolve(); }
  return TM.terminal.open({ cwd: S.repo || undefined, cmd, title }).catch((e) => toast(`Could not open a terminal: ${e.message}`, true));
}

/* The fast checks after Start, slower ones while stopped, a slow heartbeat
 * while running - the event stream carries everything else. */
function schedule() {
  clearTimeout(schedule.timer);
  const ms = !S.up ? (Date.now() - S.startedAt < 90_000 ? 1500 : 4000) : 20_000;
  schedule.timer = setTimeout(async () => { await refresh(); schedule(); }, ms);
}

/* The Start button and Approve in Notifications share this one path: the
 * engine runs in a terminal the user can see and stop (t-c47fb21612). */
async function startEngine() {
  if (!S.repo || !S.dataDir) { showTab('ask'); toast('Say where the engine is first, then start it.', true); return; }
  S.startedAt = Date.now();
  setStatus('wait', 'Starting the engine…');
  $('start-msg').textContent = TM && TM.isHosted
    ? 'Started in a terminal - ter-manager switched to it. Come back here from the sidebar; this page notices when the engine answers.'
    : 'Open a terminal and run the command above.';
  if (S.tab === 'notifications') toast('Starting the engine - the waiting agent goes ahead once it answers.');
  await openTerminal(startCommand(), 'RAGX engine');
  schedule();
}

/* ---------------------------------------------------------- the events */

function stopEvents() { if (S.events) { S.events.abort(); S.events = null; } }

async function startEvents() {
  stopEvents();
  const ac = new AbortController();
  S.events = ac;
  try {
    for await (const e of engine.events(ac.signal)) onEvent(e);
  } catch (_) { /* ended or engine gone */ }
  if (S.events === ac) { S.events = null; refresh().then(schedule); }
}

function onEvent(e) {
  switch (e.type) {
    case 'hello':
    case 'queue':
      $('queue').textContent = [e.current || e.ingesting ? `Reading ${e.current || e.ingesting}` : '', e.queue && e.queue.length ? `waiting: ${e.queue.join(', ')}` : ''].filter(Boolean).join(' · ');
      if (e.pool) renderPool(e.pool);
      break;
    case 'ingest':
      if (!e.docId) break;
      S.progress.set(e.docId, e);
      // A document being read for the first time gets its row now, not when
      // it is done (t-770d2af24b).
      if (!S.docs.has(e.docId)) {
        // A canvas being added from NoteX shows under From File Fabric while it is read.
        const fromNotex = S.notex && S.notex.files && S.notex.files.some((f) => f.name === e.name && f.status !== 'added');
        S.docs.set(e.docId, { id: e.docId, name: e.name, status: e.phase, chunks: 0, pages: null, origin: fromNotex ? 'notex' : null });
        renderDocs();
      }
      else renderDoc(e.docId);
      break;
    case 'doc':
      S.progress.delete(e.doc.id);
      S.docs.set(e.doc.id, e.doc);
      renderDocs();
      toast(e.status === 'exists' ? `${e.doc.name} is already in the library.`
        : `${e.doc.name} is ready - ${e.doc.chunks} passages${e.doc.figures ? `, ${e.doc.figures} figure${e.doc.figures === 1 ? '' : 's'}` : ''}.`);
      if (e.status === 'reembedded') refresh(); // the stale count has changed
      setStatus('up', `Engine running · ${S.docs.size} documents`);
      loadNotexSoon(); // it may be a canvas from NoteX, now marked
      break;
    case 'ingest-error':
      toast(`${e.name}: ${e.error}`, true);
      loadDocs();
      break;
    case 'removed':
      S.docs.delete(e.docId);
      renderDocs();
      loadNotexSoon();
      break;
    case 'pool':
      renderPool(e.pool);
      break;
    case 'ollama': // the engine finished starting (or finding) Ollama
      refresh();
      break;
    case 'call':
    case 'call-start':
    case 'call-phase':
    case 'call-drop':
    case 'sample':
      trackerEvent(e);
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------- library */

async function loadDocs() {
  try {
    const { docs } = await engine.json('GET', '/api/docs');
    S.docs = new Map(docs.map((d) => [d.id, d]));
    renderDocs();
  } catch (e) { if (!(e instanceof EngineDown)) toast(e.message, true); }
  loadNotex();
}

function statusCell(d) {
  const td = el('td');
  const p = S.progress.get(d.id);
  if (p && p.phase !== 'ready' && p.phase !== 'error') {
    if (p.phase === 'embedding' && p.total) {
      td.appendChild(el('span', 'state', `embedding ${p.done}/${p.total} `));
      const bar = el('progress'); bar.max = p.total; bar.value = p.done; td.appendChild(bar);
    } else if (p.phase === 'reading' && p.total) td.appendChild(el('span', 'state', `Claude reading figures ${p.done}/${p.total}`));
    else td.appendChild(el('span', 'state', p.phase === 'extracting' ? 'reading…' : `${p.phase}…`));
    return td;
  }
  td.appendChild(el('span', 'state ' + d.status, d.status));
  if (d.error) td.appendChild(el('div', 'err', d.error));
  return td;
}

function docRow(d) {
  const tr = el('tr');
  tr.dataset.id = String(d.id);
  const name = el('td', 'name', d.name);
  if (d.source_path) name.title = d.source_path;
  // Taken from NoteX: a File Fabric canvas, not a file the user added (t-c30c32cbe2).
  if (d.origin === 'notex') { const b = el('span', 'origin', 'NoteX'); b.title = 'A File Fabric canvas, written by NoteX'; name.appendChild(b); }
  // Figures, and how many Claude has read: "14/16 read" (t-79cb1dcd37).
  const unread = (d.figures || 0) - (d.figures_read || 0);
  const figs = el('td', 'num', d.figures ? (unread ? `${d.figures_read || 0}/${d.figures} read` : String(d.figures)) : '');
  if (unread) figs.title = `${unread} figure${unread === 1 ? '' : 's'} not read by Claude yet`;
  tr.append(name, statusCell(d), el('td', 'num', String(d.chunks || '')), figs, el('td', 'num', d.pages ? String(d.pages) : ''));
  const acts = el('td', 'acts');
  if (unread && d.status === 'ready') { const rd = el('button', null, 'Read figures'); rd.dataset.act = 'read'; acts.appendChild(rd); }
  const re = el('button', null, 'Re-index'); re.dataset.act = 'reindex';
  const rm = el('button', 'danger', 'Remove'); rm.dataset.act = 'remove';
  acts.append(re, rm);
  tr.appendChild(acts);
  return tr;
}

/* Under the drop zone: what reading images means, while it is on; and when
 * any document has figures not read yet, a bar to read them (t-d2b967c01a,
 * t-f0fbeabf6b). */
function renderReading() {
  const on = !S.state || !S.state.settings || S.state.settings.readFigures !== false;
  $('read-notice').textContent = on
    ? 'Figures and scanned pages in new documents are read by Claude - each image is sent to Anthropic once. Turn this off in Settings.'
    : 'Claude does not read figures in new documents; turn it on in Settings.';
  const unread = [...S.docs.values()].reduce((n, d) => n + Math.max(0, (d.figures || 0) - (d.figures_read || 0)), 0);
  $('unread').hidden = !unread;
  $('unread-msg').textContent = `${unread} figure${unread === 1 ? ' is' : 's are'} not read by Claude yet, so the words and numbers in ${unread === 1 ? 'it' : 'them'} cannot be searched.`;
}

/* The filter: all documents, the ones the user added, or File Fabric's
 * canvases - which also lists what NoteX has written and is not in the
 * library yet (t-c30c32cbe2). */
const shownBy = (d) => S.libFilter === 'all' || (S.libFilter === 'notex' ? d.origin === 'notex' : d.origin !== 'notex');

function renderDocs() {
  const body = $('doc-list');
  const docs = [...S.docs.values()].filter(shownBy);
  body.replaceChildren(...docs.sort((a, b) => b.id - a.id).map(docRow));
  $('docs-empty').hidden = docs.length > 0;
  $('docs-empty').textContent = !S.docs.size ? 'No documents yet.' : S.libFilter === 'notex' ? 'No File Fabric canvas is in the library yet.' : 'No document added by you yet.';
  document.querySelectorAll('#lib-filter button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.filter === S.libFilter)));
  renderReading();
  renderNotex();
  renderScope();
}

async function loadNotex() {
  try { S.notex = await engine.json('GET', '/api/notex'); } catch (e) { S.notex = null; if (!(e instanceof EngineDown)) toast(e.message, true); }
  // Listing marks a library document that is a NoteX canvas by its bytes; show it at once.
  let marked = false;
  for (const f of (S.notex && S.notex.files) || []) {
    const d = f.status === 'added' && S.docs.get(f.docId);
    if (d && d.origin !== 'notex') { d.origin = 'notex'; marked = true; }
  }
  if (marked) renderDocs(); else renderNotex();
}
// Several documents finishing together ask once.
function loadNotexSoon() { clearTimeout(loadNotexSoon.t); loadNotexSoon.t = setTimeout(loadNotex, 400); }

const NOTEX_STATE = { new: 'Not in RAGX yet', changed: 'Changed since it was added', added: 'In the library' };

function renderNotex() {
  const n = S.notex;
  const waiting = n && n.exists ? n.files.filter((f) => f.status !== 'added') : [];
  $('notex-hint').textContent = S.libFilter !== 'notex' && waiting.length
    ? `${waiting.length} File Fabric canvas${waiting.length === 1 ? ' is' : 'es are'} ready to add or update - see From File Fabric.` : '';
  $('notex-box').hidden = S.libFilter !== 'notex';
  if (S.libFilter !== 'notex') return;
  $('notex-folder').textContent = n ? n.folder : '';
  $('notex-add-all').disabled = !waiting.length;
  const files = n && n.exists ? n.files : [];
  $('notex-list').replaceChildren(...files.map((f) => {
    const tr = el('tr');
    tr.dataset.name = f.name;
    const name = el('td', 'name', f.fabric);
    name.title = f.name;
    const stat = el('td');
    stat.appendChild(el('span', `state ${f.status}`, NOTEX_STATE[f.status]));
    if (f.docStatus && f.docStatus !== 'ready') stat.appendChild(el('div', 'note', f.docStatus));
    const acts = el('td', 'acts');
    if (f.status !== 'added') { const b = el('button', f.status === 'new' ? 'primary' : null, f.status === 'new' ? 'Add' : 'Update'); b.dataset.act = 'notex-add'; acts.appendChild(b); }
    tr.append(name, el('td', null, new Date(f.modified).toLocaleString()), stat, acts);
    return tr;
  }));
  $('notex-empty').hidden = files.length > 0;
  $('notex-empty').textContent = !n ? '' : !n.exists
    ? `No NoteX documents folder at ${n.folder}. Open a fabric on the NoteX page to write one, or set the folder in Settings.`
    : 'NoteX has not written any canvas yet - open a fabric on the NoteX page.';
}

async function addNotex(names) {
  try {
    const r = await engine.json('POST', '/api/notex/add', { body: names ? { names } : {} });
    toast(r.queued.length ? `Adding ${r.queued.length} canvas${r.queued.length === 1 ? '' : 'es'} from NoteX.` : 'Nothing new to add.');
  } catch (e) { toast(e.message, true); }
}

function renderDoc(id) {
  const d = S.docs.get(id);
  if (!d) return;
  const row = $('doc-list').querySelector(`tr[data-id="${id}"]`);
  if (row) row.replaceWith(docRow(d)); else renderDocs();
}

async function uploadFiles(files) {
  for (const f of files) {
    try {
      await engine.upload(f);
      toast(`${f.name} is queued.`);
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
}

/* ----------------------------------------------------------------- ask */

const MODELS = { claude: ['sonnet', 'haiku', 'opus'], agy: [] };

function renderAgent() {
  document.querySelectorAll('#agent-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.agent === S.agent)));
  const sel = $('model');
  const st = S.state && S.state.settings;
  const opts = S.agent === 'claude' ? MODELS.claude : [st && st.agyModel ? st.agyModel : ''];
  sel.replaceChildren(...opts.map((m) => { const o = el('option', null, m || "agy's default"); o.value = m; return o; }));
  if (opts.includes(S.model)) sel.value = S.model;
  else { S.model = S.agent === 'claude' ? ((st && st.claudeModel) || 'sonnet') : (opts[0] || ''); sel.value = S.model; }
  sel.disabled = S.agent === 'agy' && opts.length < 2;
}

function renderPool(pool) {
  const chip = $('warm');
  const list = pool || [];
  const spare = list.some((p) => p.spare);
  const open = list.filter((p) => !p.spare).length;
  chip.hidden = !spare && !open;
  chip.textContent = [spare ? 'agy warm' : '', open ? `${open} agy open` : ''].filter(Boolean).join(' · ');
}

async function warm() {
  if (!S.up) return;
  try { const r = await engine.json('POST', '/api/agents/warm'); renderPool(r.pool); } catch (_) { /* not worth a toast */ }
}

function sourceLabel(s) {
  const pages = s.pageFrom == null ? '' : s.pageFrom === s.pageTo ? `, p.${s.pageFrom}` : `, pp.${s.pageFrom}-${s.pageTo}`;
  if (s.figureId) return `[${s.n}] ${s.docName}${pages} - figure`;
  return `[${s.n}] ${s.docName}${pages}${s.heading ? ' - ' + s.heading : ''}${s.figures && s.figures.length ? ' + figure' : ''}`;
}

/* A figure in a panel: its image, fetched with the token, and its caption.
 * The caption is set as text, like every word from a document (t-1c6e343d0e). */
function figureBox(id, caption, n = null, reading = null) {
  const box = el('figure', 'fig');
  const img = el('img');
  img.alt = caption || 'Figure';
  img.title = 'Open full size';
  img.addEventListener('click', () => openFigure(id, caption, n));
  box.appendChild(img);
  if (caption) box.appendChild(el('figcaption', null, caption));
  // What Claude read in it, under the image and marked as such - the image is the authority (t-8be56aa93b).
  if (reading) {
    const r = el('div', 'reading');
    r.append(el('div', 'reading-label', 'Read from the image by Claude - machine-read, may contain errors'), el('div', 'reading-text', reading));
    box.appendChild(r);
  }
  engine.figureUrl(id).then((url) => { img.src = url; }).catch(() => box.replaceChildren(el('div', 'note', 'The figure could not be loaded - its document may have been removed.')));
  return box;
}

function citeButton(n) {
  const b = el('button', 'cite', String(n));
  b.type = 'button';
  b.dataset.n = String(n);
  if (!S.sources.has(n)) { b.classList.add('unknown'); b.title = 'No source has this number'; }
  else b.title = sourceLabel(S.sources.get(n));
  return b;
}

function renderAnswer(bubble, text) {
  const body = bubble.querySelector('.body');
  body.replaceChildren(toDom(parse(text), document, { cite: citeButton }));
}

function addMessage(role, text = '') {
  $('thread-empty').hidden = true;
  const m = el('div', 'msg ' + role);
  if (role === 'user') m.textContent = text;
  else { m.appendChild(el('div', 'body')); if (text) renderAnswer(m, text); }
  $('thread').appendChild(m);
  m.scrollIntoView({ block: 'end' });
  return m;
}

/* The figures an answer cites: a figure that is itself a cited source, then
 * the figures beside cited passages, each once (t-cfd255ac87) - and the
 * images a cited place links, opened where they are (t-d112dfa471). */
const MAX_THUMBS = 6;
const imageKey = (f) => (f.linkedId ? `l${f.linkedId}` : `f${f.figureId}`);
function citedFigures(cited) {
  const out = [];
  for (const n of cited) {
    const s = S.sources.get(n);
    if (!s) continue;
    const figs = s.figureId ? [{ figureId: s.figureId, caption: s.text }] : (s.figures || []);
    const linked = (s.images || []).map((im) => ({ linkedId: im.linkedId, caption: im.name, path: im.path }));
    for (const f of [...figs, ...linked]) if (!out.some((x) => imageKey(x) === imageKey(f))) out.push({ ...f, n });
  }
  return out.slice(0, MAX_THUMBS);
}

/* A figure is RAGX's own; a linked image is fetched from where it is, and
 * is refused when its folder is not listed in Settings. */
const imageUrl = (f) => (f.linkedId ? engine.linkedUrl(f.linkedId) : engine.figureUrl(f.figureId));
const notShown = (e) => (e && e.status === 403 ? 'Not shown - add its folder in Settings → Folders RAGX may show images from.' : 'The image could not be loaded.');

/* A row of thumbnails under an answer, so a question about a chart is
 * answered with the chart in view; each opens full size. */
function thumbs(figures) {
  const row = el('div', 'thumbs');
  for (const f of figures) {
    const b = el('button', 'thumb');
    b.type = 'button';
    b.title = `[${f.n}] ${f.caption || 'Figure'} - open full size`;
    const img = el('img');
    img.alt = f.caption || 'Figure';
    b.append(img, el('span', 'n', `[${f.n}]`));
    // Not opened: say why in the thumbnail itself, not only in a tooltip - the
    // image's name alone reads like a broken picture.
    imageUrl(f).then((url) => { img.src = url; }).catch((e) => {
      b.disabled = true;
      b.title = notShown(e);
      b.replaceChildren(el('span', 'thumb-msg', e && e.status === 403 ? 'Not shown - add its folder in Settings' : 'Could not be loaded'), el('span', 'n', `[${f.n}]`));
    });
    // Its own handler: the thread's would open the passage, not the figure.
    b.addEventListener('click', (e) => { e.stopPropagation(); openFigure(f, f.caption, f.n); });
    row.appendChild(b);
  }
  return row;
}

/* One figure or linked image over the page, as large as the window allows.
 * ref is a figure id, or { figureId } / { linkedId, path }. */
let lightboxSource = null;
function openFigure(ref, caption, n = null) {
  const f = typeof ref === 'object' ? ref : { figureId: ref };
  lightboxSource = n;
  const img = $('lightbox-img');
  img.removeAttribute('src');
  img.alt = caption || 'Figure';
  $('lightbox-cap').textContent = `${n ? `[${n}] ` : ''}${caption || 'Figure with no caption'}${f.path ? ` - ${f.path}` : ''}`;
  $('lightbox-source').hidden = n == null;
  $('lightbox').hidden = false;
  imageUrl(f).then((url) => { img.src = url; }).catch((e) => { $('lightbox-cap').textContent = notShown(e); });
  $('lightbox-close').focus();
}

/* A linked image in the source panel: the picture, its name and where it is. */
function linkedBox(im, n) {
  const box = el('figure', 'fig');
  const img = el('img');
  img.alt = im.name;
  img.title = 'Open full size';
  const f = { linkedId: im.linkedId, path: im.path };
  img.addEventListener('click', () => openFigure(f, im.name, n));
  box.append(img, el('figcaption', null, `${im.name} - ${im.path}`));
  imageUrl(f).then((url) => { img.src = url; }).catch((e) => box.replaceChildren(el('div', 'note', `${im.name}: ${notShown(e)}`)));
  return box;
}
function closeFigure() { $('lightbox').hidden = true; lightboxSource = null; }

function addMeta(bubble, cited, unknown, warnings) {
  const meta = el('div', 'meta');
  for (const n of cited) {
    const s = S.sources.get(n);
    if (!s) continue;
    const ref = el('button', 'srcref', sourceLabel(s));
    ref.type = 'button';
    ref.dataset.n = String(n);
    meta.appendChild(ref);
  }
  if (!cited.length) meta.appendChild(el('span', null, 'No source was cited.'));
  bubble.appendChild(meta);
  const figures = citedFigures(cited);
  if (figures.length) bubble.appendChild(thumbs(figures));
  if (unknown.length) bubble.appendChild(el('div', 'warn', `Cites ${unknown.map((n) => `[${n}]`).join(' ')}, which no source has - treat that part with care.`));
  for (const w of warnings || []) bubble.appendChild(el('div', 'warn', w));
}

async function ask(question) {
  if (S.asking) return;
  // A session belongs to one agent: switching starts a new conversation (t-854123b1ec).
  if (S.conv && S.convAgent && S.convAgent !== S.agent) {
    toast(`That conversation is with ${S.convAgent === 'agy' ? 'Antigravity' : 'Claude'}; starting a new one with ${S.agent === 'agy' ? 'Antigravity' : 'Claude'}.`);
    newConversation();
  }
  addMessage('user', question);
  const bubble = addMessage('bot');
  const working = el('div', 'working', 'Searching your documents…');
  bubble.querySelector('.body').appendChild(working);
  const ac = new AbortController();
  S.asking = ac;
  $('cancel').hidden = false;
  $('send').disabled = true;
  const started = Date.now();
  let text = '';
  let pending = false;
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $('ask-note').textContent = S.agent === 'agy' ? `Antigravity is working - ${s} s (it usually takes 40-50 s)` : `${s} s`;
  }, 1000);
  try {
    const body = { question, agent: S.agent, conversationId: S.conv, docs: S.scope };
    if (S.model) body.model = S.model;
    for await (const e of engine.ask(body, ac.signal)) {
      if (e.type === 'sources') {
        for (const s of e.sources) S.sources.set(s.n, s);
        const fresh = e.sources.filter((s) => s.fresh).length;
        working.textContent = `Reading ${e.sources.length} passages${fresh < e.sources.length ? ` (${fresh} new)` : ''}…`;
      } else if (e.type === 'delta') {
        text += e.text;
        if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderAnswer(bubble, text); bubble.scrollIntoView({ block: 'end' }); }); }
      } else if (e.type === 'done') {
        renderAnswer(bubble, e.answer);
        addMeta(bubble, e.cited || [], e.unknown || [], e.warnings);
        if (e.conversationId) { S.conv = e.conversationId; S.convAgent = e.agent; remember('conv', S.conv); }
        // The engine's word on the choice: documents removed since have dropped out.
        if (e.scope !== undefined) { S.scope = e.scope; renderScope(); }
        loadConversations();
      } else if (e.type === 'error') {
        throw new EngineRefused(e.status || 500, e.code, e.message);
      }
    }
  } catch (e) {
    bubble.classList.add('error');
    const msg = e.name === 'AbortError' || e.code === 'cancelled' ? 'Cancelled.'
      : e.code === 'busy' ? 'This conversation is still answering its last question.' : e.message;
    bubble.querySelector('.body').replaceChildren(el('p', null, msg));
  } finally {
    clearInterval(tick);
    S.asking = null;
    $('cancel').hidden = true;
    renderScope(); // enables Ask again, unless no document is ticked
    $('ask-note').textContent = '';
    if (S.agent === 'agy') renderPool(S.state && S.state.pool);
  }
}

async function loadConversations() {
  try {
    const { conversations } = await engine.json('GET', '/api/conversations');
    const list = $('conv-list');
    list.replaceChildren(...conversations.map((c) => {
      const li = el('li', c.id === S.conv ? 'on' : null);
      li.dataset.id = String(c.id);
      li.append(el('span', 'title', c.title), el('span', 'who', c.agent === 'agy' ? 'agy' : 'claude'));
      const del = el('button', 'icon del', '×'); del.title = 'Delete this conversation'; del.dataset.act = 'delete';
      li.appendChild(del);
      return li;
    }));
  } catch (_) { /* shown by the status */ }
}

/* ---------------------------------------------- which documents to ask */

/* A conversation searches all documents, or the ones ticked here; the
 * choice goes with every question and is kept with the conversation, and
 * search itself is limited to them (t-c323b2002a). */
const readyDocs = () => [...S.docs.values()].filter((d) => d.status === 'ready').sort((a, b) => a.name.localeCompare(b.name));

function renderScope() {
  const docs = readyDocs();
  const btn = $('scope-btn');
  const chosen = S.scope ? docs.filter((d) => S.scope.includes(d.id)) : null;
  btn.classList.toggle('narrowed', Boolean(chosen));
  btn.textContent = !chosen ? 'Searching: all documents'
    : chosen.length === 1 ? `Searching: ${chosen[0].name}` : `Searching: ${chosen.length} of ${docs.length} documents`;
  btn.title = chosen ? chosen.map((d) => d.name).join('\n') : 'Every document in the library - click to choose';
  $('send').disabled = Boolean(S.asking) || Boolean(chosen && !chosen.length);
  const pop = $('scope-pop');
  if (pop.hidden) return;
  const box = (d) => {
    const l = el('label');
    const c = el('input');
    c.type = 'checkbox';
    c.dataset.id = String(d.id);
    c.checked = !S.scope || S.scope.includes(d.id);
    l.append(c, el('span', null, d.name));
    return l;
  };
  const all = el('label', 'all');
  const ca = el('input');
  ca.type = 'checkbox';
  ca.dataset.all = '1';
  ca.checked = !S.scope;
  all.append(ca, el('span', null, 'All documents - including ones added later'));
  const mine = docs.filter((d) => d.origin !== 'notex');
  const canvases = docs.filter((d) => d.origin === 'notex');
  pop.replaceChildren(all,
    ...(mine.length ? [el('div', 'group', 'Added by you'), ...mine.map(box)] : []),
    ...(canvases.length ? [el('div', 'group', 'From File Fabric'), ...canvases.map(box)] : []),
    ...(!docs.length ? [el('div', 'note', 'No documents are ready yet.')] : []),
    ...(chosen && !chosen.length ? [el('div', 'note', 'Tick at least one document to ask.')] : []));
}

function onScopeChange(e) {
  const c = e.target;
  if (c.type !== 'checkbox') return;
  const ids = readyDocs().map((d) => d.id);
  if (c.dataset.all) S.scope = c.checked ? null : [];
  else {
    const now = new Set(S.scope || ids);
    if (c.checked) now.add(Number(c.dataset.id)); else now.delete(Number(c.dataset.id));
    // Every document ticked is the same as all of them, which also takes in ones added later.
    S.scope = ids.every((id) => now.has(id)) ? null : ids.filter((id) => now.has(id));
  }
  renderScope();
}

function newConversation() {
  S.conv = null; S.convAgent = null; S.sources = new Map();
  S.scope = null;
  renderScope();
  remember('conv', null);
  $('thread').replaceChildren($('thread-empty'));
  $('thread-empty').hidden = false;
  closeSource();
  document.querySelectorAll('#conv-list li').forEach((li) => li.classList.remove('on'));
}

async function openConversation(id) {
  try {
    const { conversation, messages, sources } = await engine.json('GET', `/api/conversations/${id}`);
    S.conv = conversation.id;
    S.convAgent = conversation.agent;
    S.sources = new Map(sources.map((s) => [s.n, s]));
    S.scope = conversation.scope || null;
    renderScope();
    remember('conv', S.conv);
    $('thread').replaceChildren($('thread-empty'));
    $('thread-empty').hidden = true;
    for (const m of messages) {
      if (m.role === 'user') addMessage('user', m.text);
      else { const b = addMessage('bot', m.text); addMeta(b, m.cited, m.unknown, []); }
    }
    if (conversation.agent !== S.agent) { S.agent = conversation.agent; renderAgent(); remember('agent', S.agent); }
    document.querySelectorAll('#conv-list li').forEach((li) => li.classList.toggle('on', Number(li.dataset.id) === S.conv));
  } catch (e) {
    if (e.status === 404) newConversation(); else toast(e.message, true);
  }
}

/* ---------------------------------------------------- the source panel */

let shown = null;
function openSource(n) {
  const s = S.sources.get(n);
  if (!s) { toast(`No source has the number ${n}.`, true); return; }
  shown = s;
  $('source').hidden = false;
  $('source-title').textContent = `[${s.n}] ${s.docName}`;
  $('source-where').textContent = [s.pageFrom == null ? '' : s.pageFrom === s.pageTo ? `page ${s.pageFrom}` : `pages ${s.pageFrom}-${s.pageTo}`, s.heading].filter(Boolean).join(' · ');
  // A figure shows as its image; a passage shows its text, then the figures beside it.
  if (s.figureId) $('source-body').replaceChildren(figureBox(s.figureId, s.text, s.n, s.reading));
  else $('source-body').replaceChildren(el('mark', null, s.text), ...(s.figures || []).map((f) => figureBox(f.figureId, f.caption, s.n, f.reading)),
    ...(s.images || []).map((im) => linkedBox(im, s.n)));
  // A figure found by its reading has chunks, but the text around them is only more of the reading.
  $('source-more').hidden = Boolean(s.figureId) || !s.chunkIds || !s.chunkIds.length;
}

function closeSource() { $('source').hidden = true; shown = null; }

async function moreContext() {
  if (!shown) return;
  const s = shown;
  try {
    const first = await engine.json('GET', `/api/chunks/${s.chunkIds[0]}`);
    const last = s.chunkIds.length > 1 ? await engine.json('GET', `/api/chunks/${s.chunkIds[s.chunkIds.length - 1]}`) : first;
    const parts = [];
    if (first.before) parts.push(el('div', 'ctx', first.before.text));
    parts.push(el('mark', null, s.text));
    if (last.after) parts.push(el('div', 'ctx', last.after.text));
    $('source-body').replaceChildren(...parts);
    $('source-more').hidden = true;
  } catch (e) {
    toast(e.status === 404 ? 'That document has since been removed; this is the text the agent was shown.' : e.message, e.status !== 404);
  }
}

/* ------------------------------------------------------------ settings */

function renderSettings() {
  const st = S.state;
  if (!st) return;
  const f = $('settings-form');
  const s = st.settings;
  if (!f.dataset.dirty) {
    f.claudeModel.value = s.claudeModel || 'sonnet';
    f.agyModel.value = s.agyModel || '';
    f.claudePath.value = s.claudePath || '';
    f.agyPath.value = s.agyPath || '';
    f.embedModel.value = s.model || '';
    f.queryPrefix.value = s.queryPrefix || '';
    f.docPrefix.value = s.docPrefix || '';
    f.readFigures.checked = s.readFigures !== false;
    f.readModel.value = s.readModel || '';
    f.imageFolders.value = (s.imageFolders || []).join('\n');
    f.notexDocs.value = s.notexDocsSet || '';
    f.notexDocs.placeholder = s.notexDocs || f.notexDocs.placeholder;
  }
  renderReading();
  const facts = $('engine-facts');
  const row = (k, v) => [el('dt', null, k), el('dd', null, v)];
  const agent = (name) => (st.agents[name].found ? st.agents[name].path : st.agents[name].error);
  facts.replaceChildren(
    ...row('Engine', `${engine.url} · version ${st.version} · pid ${st.pid}`),
    ...row('Data', st.dataDir),
    ...row('Ollama', (st.ollama.state === 'up' ? `${st.ollama.model} · ${st.ollama.dim ? `${st.ollama.dim} dimensions` : 'dimensions measured on the first embedding'} · ${st.ollama.window}-token window · ${st.ollama.vision ? 'embeds figures' : 'text only - figures are kept but not searched'}` : st.ollama.error || st.ollama.state)
      + (st.ollama.owned ? ' · started by the engine, stops with it' : st.ollama.managed && st.ollama.state === 'up' ? ' · was already running; left running when the engine stops, its model unloaded' : '')),
    ...row('Claude', agent('claude')),
    ...row('Antigravity', agent('agy')),
    ...row('Index', `${st.totals.docs} documents · ${st.totals.chunks} passages · ${st.conversations} conversations`),
  );
  renderAgent();
}

async function saveSettings(ev) {
  ev.preventDefault();
  const f = ev.target;
  const s = S.state.settings;
  const body = {
    claudeModel: f.claudeModel.value, agyModel: f.agyModel.value.trim(),
    claudePath: f.claudePath.value.trim(), agyPath: f.agyPath.value.trim(),
    readFigures: f.readFigures.checked, readModel: f.readModel.value.trim(),
    imageFolders: f.imageFolders.value.split('\n').map((x) => x.trim()).filter(Boolean),
    notexDocs: f.notexDocs.value.trim(),
  };
  const emb = { embedModel: f.embedModel.value.trim(), queryPrefix: f.queryPrefix.value, docPrefix: f.docPrefix.value };
  if (emb.embedModel !== s.model || emb.queryPrefix !== s.queryPrefix || emb.docPrefix !== s.docPrefix) Object.assign(body, emb);
  $('settings-msg').textContent = 'Saving…';
  try {
    const r = await engine.json('PUT', '/api/settings', { body });
    delete f.dataset.dirty;
    S.state.settings = r.settings;
    $('settings-msg').textContent = r.stale ? `${r.stale} documents need embedding again before you can ask.` : 'Saved.';
    $('reembed').hidden = !r.stale;
    renderAgent();
  } catch (e) { $('settings-msg').textContent = e.message; }
}

/* ------------------------------------------------------------- tracker */

const RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 };
const WHO = { you: 'You', agent: 'Agent', cli: 'Command line', other: 'Other' };
const KIND = { search: 'Search', ask: 'Ask', passage: 'Passage', figure: 'Figure', documents: 'Documents', ingest: 'Ingest', reindex: 'Re-index', reembed: 'Re-embed', resume: 'Resume', read: 'Read figures' };

function fmtMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
function fmtWhen(at) {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const agentName = (client) => (client && client.startsWith('mcp:') ? client.slice(4).split(/[/ ]/)[0] : null);

function stat(label, value, sub) {
  const c = el('div', 'stat');
  c.append(el('div', 'label', label), el('div', 'value', value));
  if (sub) c.appendChild(el('div', 'sub', sub));
  return c;
}

/* The parts of a call's time, drawn to scale: model loading inside
 * embedding, then search, then the answering agent. */
function timebar(c) {
  const bar = el('div', 'timebar');
  const total = c.ms || 0;
  if (!total) return bar;
  const load = c.load_ms || 0;
  const parts = [['load', load], ['embed', Math.max((c.embed_ms || 0) - load, 0)], ['image', c.image_ms || 0], ['read', c.read_ms || 0], ['search', c.search_ms || 0], ['agent', c.agent_ms || 0]];
  for (const [cls, ms] of parts) {
    if (!ms) continue;
    const i = el('i', cls);
    i.style.width = `${Math.min(100, (ms / total) * 100)}%`;
    i.title = `${{ load: 'loading the model', embed: 'embedding text', image: 'embedding figures', read: 'Claude reading figures', search: 'searching', agent: 'the agent answering' }[cls]}: ${fmtMs(ms)}`;
    bar.appendChild(i);
  }
  return bar;
}

/* One period for the cards, the chart and the call list, so the list never
 * disagrees with the totals above it (t-5aa838abc4). */
const T = { range: 'day', source: '', kind: '', calls: [], more: false, detail: null, running: new Map(), sum: null, samples: [], sumTimer: null };

async function loadTracker() {
  if (!S.up) return;
  try {
    const [sum, smp] = await Promise.all([
      engine.json('GET', `/api/tracker/summary?range=${T.range}`),
      engine.json('GET', `/api/tracker/samples?range=${T.range}`),
    ]);
    T.sum = sum;
    T.samples = smp.samples;
    renderCards(sum);
    renderChart();
    await loadCalls(false);
  } catch (e) { if (!(e instanceof EngineDown)) toast(e.message, true); }
}

async function loadCalls(older) {
  const q = new URLSearchParams({ limit: '50', since: String(Date.now() - RANGES[T.range]) });
  if (T.source) q.set('source', T.source);
  if (T.kind) q.set('kind', T.kind);
  if (older && T.calls.length) q.set('before', String(T.calls[T.calls.length - 1].id));
  const { calls, running = [] } = await engine.json('GET', `/api/tracker/calls?${q}`);
  if (!older) T.running = new Map(running.map((r) => [r.run, r]));
  T.calls = older ? T.calls.concat(calls) : calls;
  T.more = calls.length === 50;
  renderCalls();
}

function renderCards(sum) {
  const by = sum.bySource || {};
  const n = (k) => (by[k] ? by[k].calls : 0);
  const all = Object.values(by);
  const calls = all.reduce((a, o) => a + o.calls, 0);
  const avg = calls ? all.reduce((a, o) => a + o.avgMs * o.calls, 0) / calls : 0;
  const slowest = all.reduce((a, o) => Math.max(a, o.maxMs), 0);
  const now = sum.now;
  const split = [['you', 'you'], ['agent', 'agents'], ['cli', 'command line'], ['other', 'other']].filter(([k]) => n(k)).map(([k, w]) => `${n(k)} ${w}`).join(' · ');
  const loaded = sum.modelLoadedSeconds || 0;
  $('tr-cards').replaceChildren(
    stat('Calls', String(calls), split || 'none yet'),
    stat('Time per call', calls ? fmtMs(avg) : '-', calls ? `slowest ${fmtMs(slowest)}` : null),
    stat('Embedding', fmtMs(sum.embedMs + (sum.imageMs || 0)), [sum.imageMs ? `${fmtMs(sum.imageMs)} of it figures` : '', sum.loadMs ? `${fmtMs(sum.loadMs)} loading the model` : 'model was already loaded'].filter(Boolean).join(' · ')),
    stat('Figures read', String(sum.reads || 0), sum.reads || sum.readCached ? `${fmtMs(sum.readMs || 0)} reading${sum.readCached ? ` · ${sum.readCached} from kept readings` : ''}` : 'by Claude, when documents are added'),
    stat('Model loads', String(sum.loads), `loaded for ${loaded >= 3600 ? (loaded / 3600).toFixed(1) + ' h' : Math.round(loaded / 60) + ' min'}`),
    stat('GPU now', now && now.gpuUtil != null ? `${now.gpuUtil}%` : '-',
      now && now.vramUsed != null ? `VRAM ${now.vramUsed} / ${now.vramTotal} MiB` : 'no NVIDIA GPU found'),
    stat('Embedding model', now ? (now.modelLoaded ? `${now.modelVram} MiB` : 'not loaded') : '-',
      now && now.ollamaUp === false ? 'Ollama is not answering' : 'VRAM it holds in Ollama'),
  );
  for (const [k, label] of Object.entries(WHO)) {
    const o = by[k];
    if (!o) continue;
    $('tr-cards').appendChild(stat(label, `${o.calls} ${o.calls === 1 ? 'call' : 'calls'}`, `avg ${fmtMs(o.avgMs)} · slowest ${fmtMs(o.maxMs)}${o.errors ? ` · ${o.errors} failed` : ''}`));
  }
}

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }

function renderChart() {
  const W = 600, H = 120;
  const to = Date.now();
  const from = to - RANGES[T.range];
  const samples = T.samples;
  const x = (at) => ((at - from) / (to - from)) * W;
  const y = (f) => H - Math.max(0, Math.min(1, f)) * H;
  // A gap of more than three steps is the engine having been stopped: the line breaks there.
  const step = T.range === 'hour' ? 5000 : 60_000;
  const segments = [];
  let cur = [];
  for (const s of samples) {
    if (cur.length && s.at - cur[cur.length - 1].at > step * 3) { segments.push(cur); cur = []; }
    cur.push(s);
  }
  if (cur.length) segments.push(cur);
  const chart = $('tr-chart');
  const parts = [25, 50, 75].map((p) => svg('line', { class: 'grid', x1: 0, x2: W, y1: y(p / 100), y2: y(p / 100) }));
  for (const seg of segments) {
    for (const s of seg) {
      if (s.modelLoaded >= 0.5) parts.push(svg('rect', { class: 'model', x: x(s.at), y: 0, width: Math.max(1, (step / (to - from)) * W), height: H }));
    }
    const vram = seg.filter((s) => s.vramUsed != null && s.vramTotal);
    if (vram.length) {
      const d = `M${x(vram[0].at)},${H} ` + vram.map((s) => `L${x(s.at)},${y(s.vramUsed / s.vramTotal)}`).join(' ') + ` L${x(vram[vram.length - 1].at)},${H} Z`;
      parts.push(svg('path', { class: 'vram', d }));
    }
    const gpu = seg.filter((s) => s.gpuUtil != null);
    if (gpu.length) parts.push(svg('path', { class: 'gpu', d: gpu.map((s, i) => `${i ? 'L' : 'M'}${x(s.at)},${y(s.gpuUtil / 100)}`).join(' ') }));
  }
  chart.replaceChildren(...parts);
  chart.dataset.from = String(from);
  chart.samples = samples;
  $('tr-chart-from').textContent = samples.length ? fmtWhen(from) : 'No samples in this period - they are taken while the engine runs.';
}

/* Hovering the chart reads out the sample under the pointer. */
function chartReadout(e) {
  const chart = $('tr-chart');
  const samples = chart.samples || [];
  if (!samples.length) return;
  const box = chart.getBoundingClientRect();
  const from = Number(chart.dataset.from);
  const at = from + ((e.clientX - box.left) / box.width) * (Date.now() - from);
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.at - at) < Math.abs(best.at - at)) best = s;
  $('tr-chart-to').textContent = `${fmtWhen(best.at)} · GPU ${best.gpuUtil == null ? '-' : Math.round(best.gpuUtil) + '%'}`
    + ` · VRAM ${best.vramUsed == null ? '-' : best.vramUsed + ' MiB'} · model ${best.modelLoaded >= 0.5 ? (best.modelVram || 0) + ' MiB' : 'not loaded'}`;
}

const shownCall = (c) => (!T.source || c.source === T.source) && (!T.kind || c.kind === T.kind);

/* A call still going: its phase and a clock that counts up each second. */
function runningRow(r) {
  const tr = el('tr', 'running');
  tr.dataset.run = String(r.run);
  const who = el('td');
  who.appendChild(el('span', 'who ' + r.source, agentName(r.client) || WHO[r.source] || r.source));
  const what = el('td', null, KIND[r.kind] || r.kind);
  if (r.agent) what.appendChild(el('div', 'note', r.model ? `${r.agent} · ${r.model}` : r.agent));
  const q = el('td', 'q', r.question || '');
  q.title = r.question || '';
  const time = el('td');
  time.append(el('span', 'clock', fmtMs(Date.now() - r.at)), el('div', 'note phase', r.phase || 'working'));
  tr.append(el('td', null, fmtWhen(r.at)), who, what, q, el('td', 'num', ''), time);
  return tr;
}

function renderCalls() {
  const running = [...T.running.values()].filter(shownCall).sort((a, b) => b.run - a.run).map(runningRow);
  $('tr-calls').replaceChildren(...running, ...T.calls.map((c) => {
    const tr = el('tr');
    tr.dataset.id = String(c.id);
    const who = el('td');
    who.appendChild(el('span', 'who ' + c.source, agentName(c.client) || WHO[c.source] || c.source));
    const what = el('td', null, KIND[c.kind] || c.kind);
    if (c.agent) what.appendChild(el('div', 'note', c.model ? `${c.agent} · ${c.model}` : c.agent));
    const q = el('td', 'q', c.question || '');
    q.title = c.question || '';
    const time = el('td', null, fmtMs(c.ms));
    time.appendChild(timebar(c));
    const res = el('td', 'num', c.error ? '' : c.results == null ? '' : String(c.results));
    if (c.error) { res.appendChild(el('span', 'err', 'failed')); res.title = c.error; }
    tr.append(el('td', null, fmtWhen(c.at)), who, what, q, res, time);
    return tr;
  }));
  $('tr-empty').hidden = T.calls.length > 0 || running.length > 0;
  $('tr-more').hidden = !T.more;
}

function where(p) { return p.pageFrom == null ? '' : p.pageFrom === p.pageTo ? `, p.${p.pageFrom}` : `, pp.${p.pageFrom}-${p.pageTo}`; }

function passageBox(p, label) {
  const box = el('div', 'passage');
  box.appendChild(el('div', 'where', `${label || (p.n ? `[${p.n}] ` : '')}${p.docName}${where(p)}${p.heading ? ' - ' + p.heading : ''}${p.score != null ? ` · score ${Number(p.score).toFixed(3)}` : ''}`));
  if (p.figureId) box.appendChild(figureBox(p.figureId, p.text, null, p.reading));
  else {
    box.appendChild(document.createTextNode(p.text));
    for (const f of p.figures || []) box.appendChild(figureBox(f.figureId, f.caption, null, f.reading));
  }
  return box;
}

async function openCall(id) {
  let c;
  try { c = await engine.json('GET', `/api/tracker/calls/${id}`); } catch (e) { toast(e.message, true); return; }
  T.detail = c.id;
  $('tr-detail').hidden = false;
  $('tr-detail-title').textContent = `${KIND[c.kind] || c.kind} · ${agentName(c.client) || WHO[c.source] || c.source}`;
  $('tr-detail-where').textContent = [new Date(c.at).toLocaleString(), c.client].filter(Boolean).join(' · ');
  const body = [];
  const h = (t) => body.push(el('h4', null, t));
  if (c.question) { h(c.kind === 'ask' || c.kind === 'search' ? 'Question' : 'Subject'); body.push(el('div', null, c.question)); }
  if (c.error) { h('Error'); body.push(el('div', 'err', c.error)); }
  h('Time');
  const facts = el('dl', 'facts');
  const row = (k, v) => { if (v != null && v !== '') facts.append(el('dt', null, k), el('dd', null, v)); };
  row('Total', fmtMs(c.ms));
  row('Embedding', c.embed_ms != null ? fmtMs(c.embed_ms) : null);
  row('Embedding figures', c.image_ms ? fmtMs(c.image_ms) : null);
  row('Reading figures', c.read_ms || c.reads || c.read_cached
    ? `${c.reads || 0} read by Claude${c.read_cached ? `, ${c.read_cached} from kept readings` : ''}${c.read_ms ? ` - ${fmtMs(c.read_ms)}` : ''}` : null);
  row('Figures', c.detail && c.detail.figures ? String(c.detail.figures) : null);
  row('Loading the model', c.load_ms ? fmtMs(c.load_ms) : null);
  row('Search', c.search_ms != null ? fmtMs(c.search_ms) : null);
  row('Agent', c.agent_ms != null ? fmtMs(c.agent_ms) : null);
  row('Answered by', c.agent ? [c.agent, c.model].filter(Boolean).join(' · ') : null);
  row('Results', c.results != null ? String(c.results) : null);
  body.push(facts, timebar(c));
  const d = c.detail || {};
  if (d.answer) {
    h('Answer');
    const ans = el('div', 'answer');
    ans.appendChild(toDom(parse(d.answer), document, { cite: (n) => el('sup', null, `[${n}]`) }));
    body.push(ans);
  }
  if (d.warning) body.push(el('div', 'warn', d.warning));
  for (const w of d.warnings || []) body.push(el('div', 'warn', w));
  if (d.passages && d.passages.length) {
    h(c.kind === 'ask' ? `Passages the agent was shown (${d.passages.length})` : `Passages returned (${d.passages.length})`);
    for (const p of d.passages) body.push(passageBox(p));
  }
  if (d.chunk) {
    h('Passage returned');
    if (d.before) body.push(passageBox({ ...d.before, docName: d.docName }, 'before · '));
    body.push(passageBox({ ...d.chunk, docName: d.docName }));
    if (d.after) body.push(passageBox({ ...d.after, docName: d.docName }, 'after · '));
  }
  if (d.docs) {
    h('Documents listed');
    const ul = el('ul');
    for (const x of d.docs) ul.appendChild(el('li', null, `${x.name} (${x.status}${x.pages ? `, ${x.pages} pages` : ''}, ${x.chunks} passages)`));
    body.push(ul);
  }
  $('tr-detail-body').replaceChildren(...body);
}

function closeCall() { $('tr-detail').hidden = true; T.detail = null; }

/* The tab is live from the engine's event stream: a call appears when it
 * starts and moves through its phases, its row fills in when it ends, and
 * every 5-second sample moves the GPU cards and the chart. Nothing is
 * fetched again except the totals, once a burst of calls has settled. While
 * another tab is open the events are let go; opening the tab loads afresh
 * (t-106a75470d, t-14ba4ed74a). */
function trackerEvent(e) {
  if (S.tab !== 'tracker') return;
  if (e.type === 'call-start') { T.running.set(e.run, e); renderCalls(); }
  else if (e.type === 'call-phase') {
    const r = T.running.get(e.run);
    if (!r) return;
    r.phase = e.phase;
    const cell = $('tr-calls').querySelector(`tr[data-run="${e.run}"] .phase`);
    if (cell) cell.textContent = e.phase;
  } else if (e.type === 'call-drop') { T.running.delete(e.run); renderCalls(); }
  else if (e.type === 'call') {
    if (e.run != null) T.running.delete(e.run);
    const c = e.call;
    if (c && shownCall(c) && !T.calls.some((x) => x.id === c.id)) T.calls.unshift(c);
    renderCalls();
    clearTimeout(T.sumTimer);
    T.sumTimer = setTimeout(refreshTotals, 400);
  } else if (e.type === 'sample') {
    if (T.sum) { T.sum.now = e.sample; renderCards(T.sum); }
    const last = T.samples[T.samples.length - 1];
    if (T.range === 'hour') {
      T.samples.push(e.sample);
      const from = Date.now() - RANGES.hour;
      while (T.samples.length && T.samples[0].at < from) T.samples.shift();
      renderChart();
    } else if (!last || Math.floor(e.sample.at / 60_000) > Math.floor(last.at / 60_000)) {
      // Longer periods are drawn from minute averages: fetched again as each minute closes.
      engine.json('GET', `/api/tracker/samples?range=${T.range}`).then((r) => { T.samples = r.samples; renderChart(); }).catch(() => {});
    }
  }
}

async function refreshTotals() {
  try {
    const sum = await engine.json('GET', `/api/tracker/summary?range=${T.range}`);
    if (T.sum && T.sum.now && (!sum.now || sum.now.at < T.sum.now.at)) sum.now = T.sum.now;
    T.sum = sum;
    renderCards(sum);
  } catch (_) { /* the next call tries again */ }
}

/* Running rows' clocks; once a second, only while someone is looking. */
function tickRunning() {
  if (S.tab !== 'tracker' || !T.running.size) return;
  for (const tr of $('tr-calls').querySelectorAll('tr.running')) {
    const r = T.running.get(Number(tr.dataset.run));
    if (r) tr.querySelector('.clock').textContent = fmtMs(Date.now() - r.at);
  }
}

/* ------------------------------------------------------- notifications */

/* An agent's request to start the engine (t-73f0ae28d8). The RAGX tool
 * writes them to notifications.json in the plugin folder, which ter-manager
 * serves whether or not the engine runs, so they are read even while it is
 * stopped. A tool that was killed while waiting leaves its request pending;
 * past the tool's wait it is shown as expired (t-22785c1ed6). */
const NOTE_WAIT_MS = 180_000;
const N = { items: [], seen: new Set(), first: true };

function noteState(n) {
  if (n.status === 'pending' && Date.now() - n.at > NOTE_WAIT_MS + 15_000) return 'expired';
  return n.status;
}

async function loadNotes() {
  N.items = await engine.notifications();
  const pending = N.items.filter((n) => noteState(n) === 'pending');
  const badge = $('note-badge');
  badge.hidden = !pending.length;
  badge.textContent = String(pending.length);
  for (const n of pending) {
    if (N.seen.has(n.id)) continue;
    N.seen.add(n.id);
    if (!N.first) toast(`${n.client || 'An agent'} wants to use RAGX - see Notifications.`);
  }
  N.first = false;
  renderNotes();
}

function renderNotes() {
  const list = $('note-list');
  list.replaceChildren(...N.items.map((n) => {
    const state = noteState(n);
    const li = el('li', state);
    const what = el('div', 'what');
    what.appendChild(el('strong', null, `${n.client || 'An agent'}${n.clientVersion ? ' ' + n.clientVersion : ''}`));
    what.appendChild(document.createTextNode(` called ${n.tool}`));
    if (n.query) { what.appendChild(document.createTextNode(': ')); what.appendChild(el('span', 'q', `"${n.query}"`)); }
    if (n.cwd) what.appendChild(el('div', 'note', `working in ${n.cwd}`));
    what.appendChild(el('div', 'note', fmtWhen(n.at)));
    li.appendChild(what);
    li.appendChild(el('span', 'state ' + state, state === 'pending' ? 'waiting for you' : state === 'answered' ? 'engine started - answered' : 'expired'));
    if (state === 'pending') {
      const b = el('button', 'primary', S.up ? 'Engine is running' : 'Approve - start the engine');
      b.dataset.act = 'approve';
      b.disabled = S.up;
      li.appendChild(b);
    }
    return li;
  }));
  $('note-empty').hidden = N.items.length > 0;
}

/* ------------------------------------------------------------- the tabs */

function showTab(tab) {
  S.tab = tab;
  remember('tab', tab);
  // The left sheet shows the conversations only on Ask (plugin.css reads this).
  document.body.dataset.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (!S.up) { if (S.checked) showOffline(); return; }
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (tab === 'ask') $('question').focus();
  if (tab === 'tracker') loadTracker();
}

/* ----------------------------------------------------------- wiring up */

function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('agent-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-agent]');
    if (!b || b.dataset.agent === S.agent) return;
    S.agent = b.dataset.agent;
    remember('agent', S.agent);
    renderAgent();
    if (S.agent === 'agy') warm();
  });
  $('model').addEventListener('change', (e) => { S.model = e.target.value; remember('model', S.model); });

  $('menu-btn').addEventListener('click', () => {
    const m = $('menu'); m.hidden = !m.hidden; $('menu-btn').setAttribute('aria-expanded', String(!m.hidden));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) $('menu').hidden = true; });
  $('refresh-btn').addEventListener('click', () => { $('menu').hidden = true; refresh().then(schedule); });
  $('stop-btn').addEventListener('click', async () => {
    $('menu').hidden = true;
    if (!S.up) { toast('The engine is not running.'); return; }
    const own = S.state && S.state.ollama && S.state.ollama.owned;
    if (!confirm(`Stop the engine? Answers in progress are ended; documents being read resume on the next start. ${own ? 'Ollama, which the engine started, stops too.' : 'The embedding model is unloaded from Ollama.'}`)) return;
    try { await engine.json('POST', '/api/shutdown'); toast('The engine is stopping.'); } catch (e) { toast(e.message, true); }
    S.startedAt = 0;
    setTimeout(() => refresh().then(schedule), 1500);
  });

  $('start-btn').addEventListener('click', startEngine);
  $('repo-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('repo').value.trim();
    if (!v) return;
    S.repo = v;
    remember('repo', v);
    showOffline();
  });
  $('ollama-start').addEventListener('click', () => openTerminal('ollama serve', 'Ollama'));
  $('ollama-pull').addEventListener('click', () => openTerminal(`ollama pull ${S.state.ollama.model}`, 'Ollama pull'));

  // Library
  $('pick').addEventListener('click', () => $('files').click());
  $('files').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('drop');
  const lib = document.querySelector('[data-panel="library"]');
  lib.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  lib.addEventListener('dragleave', (e) => { if (!lib.contains(e.relatedTarget)) drop.classList.remove('over'); });
  lib.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
  $('path-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = $('path').value.trim().replace(/^"(.*)"$/, '$1');
    if (!p) return;
    try { await engine.json('POST', '/api/docs/path', { body: { path: p } }); $('path').value = ''; toast('Queued.'); } catch (err) { toast(err.message, true); }
  });
  $('lib-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-filter]');
    if (!b) return;
    S.libFilter = b.dataset.filter;
    remember('lib-filter', S.libFilter);
    renderDocs();
    if (S.libFilter === 'notex') loadNotex();
  });
  $('notex-hint').addEventListener('click', () => { S.libFilter = 'notex'; remember('lib-filter', 'notex'); renderDocs(); });
  $('notex-add-all').addEventListener('click', () => addNotex(null));
  $('notex-list').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="notex-add"]');
    if (b) { b.disabled = true; addNotex([b.closest('tr').dataset.name]); }
  });
  $('read-all').addEventListener('click', async () => {
    try { const r = await engine.json('POST', '/api/read'); toast(`Reading figures in ${r.queued.length} document${r.queued.length === 1 ? '' : 's'} - up to 50 each.`); } catch (err) { toast(err.message, true); }
  });
  $('doc-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.closest('tr').dataset.id);
    const d = S.docs.get(id);
    if (b.dataset.act === 'remove') {
      if (!confirm(`Remove ${d.name} from the library? Its passages stop being found; past answers keep the text they cited.`)) return;
      try { await engine.json('DELETE', `/api/docs/${id}`); S.docs.delete(id); renderDocs(); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.act === 'read') {
      try { await engine.json('POST', `/api/docs/${id}/read`); toast(`Reading the figures in ${d.name} - up to 50 at a time.`); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.act === 'reindex') {
      try { await engine.json('POST', `/api/docs/${id}/reindex`); toast(`${d.name} is queued to be read again.`); } catch (err) { toast(err.message, true); }
    }
  });

  // Ask
  $('scope-btn').addEventListener('click', () => {
    const pop = $('scope-pop');
    pop.hidden = !pop.hidden;
    $('scope-btn').setAttribute('aria-expanded', String(!pop.hidden));
    renderScope();
  });
  $('scope-pop').addEventListener('change', onScopeChange);
  document.addEventListener('click', (e) => { if (!e.target.closest('.scope')) $('scope-pop').hidden = true; });
  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('question').value.trim();
    if (!q || S.asking) return;
    $('question').value = '';
    ask(q);
  });
  $('question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ask-form').requestSubmit(); }
  });
  $('cancel').addEventListener('click', () => { if (S.asking) S.asking.abort(); });
  $('new-conv').addEventListener('click', newConversation);
  $('conv-list').addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (e.target.closest('button[data-act="delete"]')) {
      if (!confirm('Delete this conversation and its answers?')) return;
      try { await engine.json('DELETE', `/api/conversations/${id}`); if (S.conv === id) newConversation(); loadConversations(); } catch (err) { toast(err.message, true); }
      return;
    }
    if (!S.asking) openConversation(id);
  });
  $('thread').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (b) openSource(Number(b.dataset.n));
  });
  $('source-close').addEventListener('click', closeSource);
  $('lightbox-close').addEventListener('click', closeFigure);
  $('lightbox').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeFigure(); });
  $('lightbox-source').addEventListener('click', () => { const n = lightboxSource; closeFigure(); if (n != null) openSource(n); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeFigure(); });
  $('source-more').addEventListener('click', moreContext);

  // Tracker
  for (const [id, key] of [['tr-range', 'range'], ['tr-source', 'source'], ['tr-kind', 'kind']]) {
    $(id).addEventListener('change', (e) => { T[key] = e.target.value; remember('tr-' + key, T[key]); closeCall(); loadTracker(); });
  }
  $('tr-more').addEventListener('click', () => loadCalls(true).catch((e) => toast(e.message, true)));
  $('tr-calls').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openCall(Number(tr.dataset.id)); });
  $('tr-detail-close').addEventListener('click', closeCall);
  $('tr-chart').addEventListener('mousemove', chartReadout);
  $('tr-chart').addEventListener('mouseleave', () => { $('tr-chart-to').textContent = 'now'; });
  $('tr-clear').addEventListener('click', async () => {
    if (!confirm('Clear every recorded call? GPU samples are kept; they age out by themselves after 30 days.')) return;
    try { await engine.json('DELETE', '/api/tracker/calls'); closeCall(); loadTracker(); toast('Call history cleared.'); } catch (e) { toast(e.message, true); }
  });

  // Notifications
  $('note-list').addEventListener('click', (e) => { if (e.target.closest('button[data-act="approve"]')) startEngine(); });

  // Settings
  $('settings-form').addEventListener('input', (e) => {
    e.currentTarget.dataset.dirty = '1';
    // A new model brings its own prefixes, as the engine sets them (defaultPrefixes in embed.js).
    if (e.target.name === 'embedModel') {
      const gemma = /^embeddinggemma/i.test(e.target.value.trim());
      e.currentTarget.queryPrefix.value = gemma ? 'task: search result | query: ' : '';
      e.currentTarget.docPrefix.value = gemma ? 'title: none | text: ' : '';
    }
  });
  $('stale-reembed').addEventListener('click', async () => {
    try { await engine.json('POST', '/api/reembed'); $('stale-reembed').disabled = true; toast('Re-embedding - progress shows in the library.'); } catch (err) { toast(err.message, true); }
  });
  $('settings-form').addEventListener('submit', saveSettings);
  $('reembed').addEventListener('click', async () => {
    try { await engine.json('POST', '/api/reembed'); $('reembed').hidden = true; $('settings-msg').textContent = 'Re-embedding - progress shows in the library.'; } catch (e) { toast(e.message, true); }
  });
}

async function boot() {
  followWallpaper();
  wire();
  if (TM) await TM.ready;
  S.tab = await recall('tab', 'ask');
  S.libFilter = await recall('lib-filter', 'all');
  S.agent = await recall('agent', 'claude');
  S.model = await recall('model', 'sonnet');
  for (const key of ['range', 'source', 'kind']) { T[key] = await recall('tr-' + key, T[key]); $('tr-' + key).value = T[key]; }
  S.local = await engine.local();
  S.repo = (S.local && S.local.repo) || await recall('repo', null);
  try { S.dataDir = (await hostCall('host.dataDir')).dir; } catch (e) {
    S.dataDir = null;
    $('start-msg').textContent = /save directory/i.test(e.message) ? e.message : '';
  }
  renderAgent();
  showTab(S.tab);
  await refresh();
  if (S.up) {
    const conv = await recall('conv', null);
    if (conv) openConversation(conv);
  }
  schedule();
  loadNotes();
  setInterval(loadNotes, 3000);
  setInterval(tickRunning, 1000);
  // Without the event stream (it reconnects on the next status check), the
  // tab falls back to loading every 5 s rather than going stale (t-87c9473aa5).
  setInterval(() => { if (S.tab === 'tracker' && S.up && !S.events && !document.hidden) loadTracker(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.tab === 'tracker' && S.up) loadTracker(); });
}

boot();
