/* A File Fabric canvas as places an agent can move through: ragx_search lands
 * it on a place, and a card shows where that place sits - what holds it,
 * what it holds, what lies beside it and what it is wired to - without its
 * text, so a step costs a few hundred tokens and text is read only where the
 * agent stops (t-3174acf082, t-03d1c825eb, t-d9ca019ef5).
 *
 * The structure is NoteX's <fabric>.places.json in NoteX's folder; a place's
 * text is its section in the library's own copy of the canvas, what search
 * answered from. Only canvases in the library are walked, and a card says
 * when NoteX's document of the canvas is newer than the library's
 * (t-f73693f19d). The map keeps relationships, not positions or sizes
 * (t-7e94c5aa4c).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SUFFIX } from './notex.js';

export const READ_MAX = 12_000;

export class PlaceError extends Error {
  constructor(code, message) { super(message); this.name = 'PlaceError'; this.code = code; }
}

/* The canvas's sections by the address its heading holds; the overview,
 * "## <fabric> (fabric)", is the canvas's own under "". */
export function sections(markdown, fabric) {
  const map = new Map();
  let key = null;
  let buf = [];
  const flush = () => { if (key !== null) map.set(key, buf.join('\n').trim()); };
  for (const line of String(markdown).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush();
      const h = line.slice(3).trim();
      key = h === `${fabric} (fabric)` ? '' : h;
      buf = [];
    } else if (key !== null) buf.push(line);
  }
  flush();
  return map;
}

const words = (text) => (String(text).match(/\S+/g) || []).length;
const norm = (s) => String(s || '').trim().toLowerCase();

/* A place by its address, else by a label or name that fits one place. */
export function findPlace(map, at) {
  const want = norm(at);
  if (!want) return { place: map.places.find((p) => p.kind === 'fabric') };
  const exact = map.places.filter((p) => p.kind !== 'fabric' && norm(p.address) === want);
  if (exact.length === 1) return { place: exact[0] };
  for (const field of ['label', 'name']) {
    const hit = map.places.filter((p) => p.kind !== 'fabric' && norm(p[field]) === want);
    if (hit.length === 1) return { place: hit[0] };
    if (hit.length > 1) return { many: hit };
  }
  const part = map.places.filter((p) => p.kind !== 'fabric' && norm(p.address).includes(want));
  if (part.length === 1) return { place: part[0] };
  return part.length ? { many: part } : { none: true };
}

const DIR = { left: 'to the left', right: 'to the right', above: 'above', below: 'below', inside: 'overlapping' };

/* One place's card, as text for an agent (t-136d2cac64). */
export function card(map, place, text = new Map(), { canvas, behind = false, reading = false, inLibrary = [] } = {}) {
  const byId = new Map(map.places.map((p) => [p.id, p]));
  const lines = [];
  const kind = (p) => ({ fabric: 'canvas', scroll: 'scroll box', canvas: 'open canvas' }[p.kind] || p.kind);
  const count = (c) => (c && c.total ? `, ${c.done}/${c.total} done` : '');
  const at = (p) => (p.address || p.label);
  const fabric = place.kind === 'fabric';

  lines.push(fabric ? `${canvas}  (the File Fabric canvas)` : `${canvas} > ${place.address}  (${kind(place)}${count(place.checklist)})`);
  if (behind) lines.push('Note: NoteX has a newer version of this canvas than the library; the text below may be behind. Update it in RAGX (or switch on Keep in RAGX in NoteX).');

  if (!fabric) {
    const up = [];
    for (let p = byId.get(place.parent); p && p.kind !== 'fabric'; p = byId.get(p.parent)) up.push(`${p.label}`);
    lines.push(`Up: ${up.length ? up.join(' < ') : 'the canvas itself'}${place.totem && place.totemVia === 'field' ? ' (in its totem\'s field)' : ''}`);
  }

  const kids = place.children.map((id) => byId.get(id)).filter(Boolean);
  if (kids.length) {
    // NoteX's labels carry their kind already: "Plan (note)", "Pipeline (totem)".
    lines.push(`${fabric ? 'On it' : 'Inside'}: ${kids.map((c) => `${c.label}${count(c.checklist)}${c.children.length ? ` [${c.children.length} inside]` : ''}`).join('; ')}`);
  } else if (!fabric) lines.push('Inside: nothing');

  const near = (place.neighbours || []).map((n) => ({ ...n, p: byId.get(n.id) })).filter((n) => n.p);
  if (near.length) lines.push(`Next to: ${near.map((n) => `${n.p.label} ${DIR[n.dir] || n.dir}`).join('; ')}`);

  const wired = (place.wires || []).map((w) => ({ ...w, p: byId.get(w.id) })).filter((w) => w.p);
  if (wired.length) lines.push(`Wired to: ${wired.map((w) => `${at(w.p)}${w.via && w.via !== 'link' ? ` (by ${w.via})` : ''}`).join('; ')}`);
  if (place.reach && place.reach.notes && place.reach.notes.length) {
    const notes = place.reach.notes.map((n) => byId.get(n.id)).filter((p) => p && p.id !== place.id);
    if (notes.length) lines.push(`Reaches along its wires: ${notes.map(at).join('; ')} - ${place.reach.done}/${place.reach.total} done in all`);
  }

  const files = place.files || [];
  const images = files.filter((f) => f.kind === 'image').map((f) => f.name);
  const others = files.filter((f) => f.kind !== 'image').map((f) => `${f.name}${f.kind && f.kind !== 'file' ? ` (${f.kind})` : ''}`);
  if (images.length) lines.push(`Images: ${images.join('; ')}`);
  if (others.length) lines.push(`Files: ${others.join('; ')}`);
  // The files here the library holds as documents of their own (t-fff1f21827).
  const ready = inLibrary.filter((d) => d.status === 'ready');
  if (ready.length) lines.push(`In RAGX as documents: ${ready.map((d) => d.name).join('; ')} - ragx_search with documents: [name] searches one.`);

  const section = text.get(fabric ? '' : place.address);
  if (section != null) lines.push(`Its section: ${words(section)} words${reading ? '' : ' - ragx_place with read: true gives it whole'}.`);
  else lines.push('Its section: not in the library\'s copy of this canvas.');
  return lines.join('\n');
}

/* The library's NoteX canvases, and one by its name - "Ter-Manager",
 * "Ter-Manager.notex.md", or a part of the name that fits one. */
export function canvasDoc(docs, name) {
  const all = docs.filter((d) => d.origin === 'notex' && d.status === 'ready' && d.name.toLowerCase().endsWith(SUFFIX));
  const list = () => all.map((d) => d.name.slice(0, -SUFFIX.length)).join('; ') || 'none';
  let want = norm(name);
  if (want.endsWith(SUFFIX)) want = want.slice(0, -SUFFIX.length);
  if (!want) throw new PlaceError('no-canvas', `Say which canvas. The File Fabric canvases in the library: ${list()}.`);
  const fab = (d) => d.name.slice(0, -SUFFIX.length).toLowerCase();
  const exact = all.filter((d) => fab(d) === want);
  const hit = exact.length ? exact : all.filter((d) => fab(d).includes(want));
  if (hit.length !== 1) {
    throw new PlaceError('no-canvas', `${hit.length ? `"${name}" fits ${hit.length} canvases` : `No File Fabric canvas called "${name}" is in the library`}. The canvases: ${list()}.`);
  }
  return hit[hit.length - 1];
}

/* What ragx_place answers: a place's card, or with read its whole section. */
export function place({ docs, name, at = '', read = false, folder, fileOf, placesAt = () => [] }) {
  const doc = canvasDoc(docs, name);
  const fabric = doc.name.slice(0, -SUFFIX.length);
  let map;
  try { map = JSON.parse(fs.readFileSync(path.join(folder, `${fabric}.places.json`), 'utf8')); } catch (_) {
    throw new PlaceError('no-map', `NoteX's place map for ${fabric} is not in ${folder} - open the canvas in NoteX once to write it.`);
  }
  const md = fs.readFileSync(fileOf(doc), 'utf8');
  const text = sections(md, fabric);
  let behind = false;
  try { behind = crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, doc.name))).digest('hex') !== doc.sha256; } catch (_) { /* NoteX's copy gone: the library's stands */ }

  const found = findPlace(map, at);
  if (found.none) throw new PlaceError('no-place', `No place on ${fabric} is called "${at}". ragx_place with only the canvas shows what is on it.`);
  if (found.many) {
    throw new PlaceError('many-places', `"${at}" fits ${found.many.length} places on ${fabric} - give the address:\n${found.many.slice(0, 12).map((p) => `- ${p.address}`).join('\n')}`);
  }
  const p = found.place;
  const head = card(map, p, text, { canvas: fabric, behind, reading: read, inLibrary: placesAt(fabric, p.kind === 'fabric' ? '' : p.address) });
  if (!read) return { doc, place: p, text: head };
  const section = text.get(p.kind === 'fabric' ? '' : p.address);
  if (section == null) return { doc, place: p, text: head };
  const clipped = section.length > READ_MAX ? `${section.slice(0, READ_MAX).trimEnd()}\n... (cut at ${READ_MAX} characters of ${section.length})` : section;
  return { doc, place: p, text: `${head}\n\n--- the section ---\n${clipped}` };
}
