/* The Documents plugin: the page ter-manager shows for the RAG engine.
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

const TM = window.TerManager;
const engine = new Engine('.');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const S = {
  up: false, state: null, local: null, dataDir: null, repo: null,
  tab: 'ask', agent: 'claude', model: 'sonnet',
  conv: null, convAgent: null, sources: new Map(), asking: null,
  docs: new Map(), progress: new Map(), events: null, startedAt: 0,
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

function showOffline() {
  $('offline').hidden = false;
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = true; });
  $('ollama').hidden = true;
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
  S.state = st;
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
  renderSettings();
  renderPool(st.pool);
  if (!was) {
    startEvents();
    await Promise.all([loadDocs(), loadConversations()]);
    if (S.agent === 'agy') warm();
  }
}

function showOllama(o) {
  const box = $('ollama');
  if (!o || o.state === 'up') { box.hidden = true; return; }
  box.hidden = false;
  $('ollama-start').hidden = o.state !== 'down';
  $('ollama-pull').hidden = o.state !== 'model-missing';
  $('ollama-msg').textContent = o.state === 'down' ? 'Ollama is not running - documents cannot be read and questions are searched by keyword only.'
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
      if (!S.docs.has(e.docId)) { S.docs.set(e.docId, { id: e.docId, name: e.name, status: e.phase, chunks: 0, pages: null }); renderDocs(); }
      else renderDoc(e.docId);
      break;
    case 'doc':
      S.progress.delete(e.doc.id);
      S.docs.set(e.doc.id, e.doc);
      renderDocs();
      toast(e.status === 'exists' ? `${e.doc.name} is already in the library.` : `${e.doc.name} is ready - ${e.doc.chunks} passages.`);
      setStatus('up', `Engine running · ${S.docs.size} documents`);
      break;
    case 'ingest-error':
      toast(`${e.name}: ${e.error}`, true);
      loadDocs();
      break;
    case 'removed':
      S.docs.delete(e.docId);
      renderDocs();
      break;
    case 'pool':
      renderPool(e.pool);
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
}

function statusCell(d) {
  const td = el('td');
  const p = S.progress.get(d.id);
  if (p && p.phase !== 'ready' && p.phase !== 'error') {
    if (p.phase === 'embedding' && p.total) {
      td.appendChild(el('span', 'state', `embedding ${p.done}/${p.total} `));
      const bar = el('progress'); bar.max = p.total; bar.value = p.done; td.appendChild(bar);
    } else td.appendChild(el('span', 'state', p.phase === 'extracting' ? 'reading…' : `${p.phase}…`));
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
  tr.append(name, statusCell(d), el('td', 'num', String(d.chunks || '')), el('td', 'num', d.pages ? String(d.pages) : ''));
  const acts = el('td', 'acts');
  const re = el('button', null, 'Re-index'); re.dataset.act = 'reindex';
  const rm = el('button', 'danger', 'Remove'); rm.dataset.act = 'remove';
  acts.append(re, rm);
  tr.appendChild(acts);
  return tr;
}

function renderDocs() {
  const body = $('doc-list');
  body.replaceChildren(...[...S.docs.values()].sort((a, b) => b.id - a.id).map(docRow));
  $('docs-empty').hidden = S.docs.size > 0;
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
  return `[${s.n}] ${s.docName}${pages}${s.heading ? ' - ' + s.heading : ''}`;
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
    const body = { question, agent: S.agent, conversationId: S.conv };
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
    $('send').disabled = false;
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

function newConversation() {
  S.conv = null; S.convAgent = null; S.sources = new Map();
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
  const mark = el('mark', null, s.text);
  $('source-body').replaceChildren(mark);
  $('source-more').hidden = !s.chunkIds || !s.chunkIds.length;
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
  }
  const facts = $('engine-facts');
  const row = (k, v) => [el('dt', null, k), el('dd', null, v)];
  const agent = (name) => (st.agents[name].found ? st.agents[name].path : st.agents[name].error);
  facts.replaceChildren(
    ...row('Engine', `${engine.url} · version ${st.version} · pid ${st.pid}`),
    ...row('Data', st.dataDir),
    ...row('Ollama', st.ollama.state === 'up' ? `${st.ollama.model} · ${st.ollama.dim} dimensions · ${st.ollama.window}-token window` : st.ollama.error || st.ollama.state),
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

/* ------------------------------------------------------------- the tabs */

function showTab(tab) {
  S.tab = tab;
  remember('tab', tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (!S.up) return;
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (tab === 'ask') $('question').focus();
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
    if (!confirm('Stop the engine? Answers in progress are ended; documents being read resume on the next start.')) return;
    try { await engine.json('POST', '/api/shutdown'); toast('The engine is stopping.'); } catch (e) { toast(e.message, true); }
    S.startedAt = 0;
    setTimeout(() => refresh().then(schedule), 1500);
  });

  $('start-btn').addEventListener('click', async () => {
    S.startedAt = Date.now();
    setStatus('wait', 'Starting the engine…');
    $('start-msg').textContent = TM && TM.isHosted
      ? 'Started in a terminal - ter-manager switched to it. Come back here from the sidebar; this page notices when the engine answers.'
      : 'Open a terminal and run the command above.';
    await openTerminal(startCommand(), 'Documents engine');
    schedule();
  });
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
  $('doc-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const id = Number(b.closest('tr').dataset.id);
    const d = S.docs.get(id);
    if (b.dataset.act === 'remove') {
      if (!confirm(`Remove ${d.name} from the library? Its passages stop being found; past answers keep the text they cited.`)) return;
      try { await engine.json('DELETE', `/api/docs/${id}`); S.docs.delete(id); renderDocs(); } catch (err) { toast(err.message, true); }
    } else if (b.dataset.act === 'reindex') {
      try { await engine.json('POST', `/api/docs/${id}/reindex`); toast(`${d.name} is queued to be read again.`); } catch (err) { toast(err.message, true); }
    }
  });

  // Ask
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
  $('source-more').addEventListener('click', moreContext);

  // Settings
  $('settings-form').addEventListener('input', (e) => { e.currentTarget.dataset.dirty = '1'; });
  $('settings-form').addEventListener('submit', saveSettings);
  $('reembed').addEventListener('click', async () => {
    try { await engine.json('POST', '/api/reembed'); $('reembed').hidden = true; $('settings-msg').textContent = 'Re-embedding - progress shows in the library.'; } catch (e) { toast(e.message, true); }
  });
}

async function boot() {
  wire();
  if (TM) await TM.ready;
  S.tab = await recall('tab', 'ask');
  S.agent = await recall('agent', 'claude');
  S.model = await recall('model', 'sonnet');
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
}

boot();
