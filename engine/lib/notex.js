/* NoteX's documents, seen from RAGX: every File Fabric canvas NoteX has
 * written as <fabric>.notex.md, and where each stands in the library
 * (t-c30c32cbe2).
 *
 * NoteX keeps them in its own data folder. ter-manager gives every plugin
 * <saveDir>/plugins/<id>, so it sits beside RAGX's (plugins/rag) unless
 * Settings names another (t-25a3490818).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SUFFIX = '.notex.md';

export function notexFolder(dataDir, setting = '') {
  return path.resolve(setting || path.join(dataDir, '..', 'notex', 'docs'));
}

const inside = (dir, file) => {
  if (!file) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/* A file in the folder by its bare name - never a path that leaves it. */
export function notexFile(folder, name) {
  if (!name || name !== path.basename(name) || !name.toLowerCase().endsWith(SUFFIX)) return null;
  const file = path.join(folder, name);
  return fs.existsSync(file) ? file : null;
}

/* The files NoteX lists beside a canvas's document, <canvas>.files.json,
 * each with its place (t-fff1f21827); null when NoteX wrote no list, as
 * before phase 4. */
export function notexFileList(folder, canvas) {
  const name = `${canvas}.files.json`;
  if (!canvas || name !== path.basename(name)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
    return Array.isArray(v.files) ? v.files : [];
  } catch (_) { return null; }
}

/* Why RAGX will not read a listed file, or null when it may (t-7c03feb73f):
 * a path in NoteX's list is only NoteX's word, so the file must be the one
 * the list names, File Fabric's copy in this canvas's sources/ folder, of a
 * kind RAGX reads as a document, inside a folder RAGX's own Settings allow -
 * the folders it may show linked images from. Its bytes are checked against
 * the listed hash when it is read. */
export function canvasFileProblem(f, { canvas, folders, readable }) {
  if (!f || typeof f.name !== 'string' || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || typeof (f.address ?? '') !== 'string') return 'not a file entry';
  if (!f.name || f.name !== path.basename(f.name)) return 'not a bare file name';
  if (!readable.includes(path.extname(f.name).toLowerCase())) return 'not a kind of file RAGX reads as a document';
  if (!path.isAbsolute(f.path)) return 'not a full path';
  const abs = path.resolve(f.path);
  if (path.basename(abs) !== f.name || path.basename(path.dirname(abs)) !== 'sources' || path.basename(path.dirname(path.dirname(abs))) !== canvas) {
    return `not File Fabric's copy in ${canvas}/sources/`;
  }
  if (!folders.some((dir) => inside(dir, abs))) return `outside the folders RAGX may read from File Fabric - add the workspace to them in Settings`;
  return null;
}

/* The canvases NoteX keeps in RAGX by auto-sync, and when each was last
 * synced: NoteX's config.json beside its docs folder, read only
 * (t-9ba4e48993, t-96cbf048b2). Nothing kept when there is none. */
export function notexKept(folder) {
  try {
    const sync = JSON.parse(fs.readFileSync(path.join(folder, '..', 'config.json'), 'utf8')).sync || {};
    return Object.fromEntries(Object.entries(sync).map(([fabric, s]) => [fabric, { at: (s && s.at) || null }]));
  } catch (_) { return {}; }
}

/* Each .notex.md and where it stands: new (not in the library), added (these
 * bytes are), or changed (its name is in the library from NoteX, with other
 * bytes) - an Update replaces that one (t-086ad99f31). Library documents that
 * are NoteX's by their bytes or their path are marked so on the way. */
export function notexStatus(store, folder) {
  let names = [];
  const kept = notexKept(folder);
  try { names = fs.readdirSync(folder).filter((n) => n.toLowerCase().endsWith(SUFFIX)); } catch (_) {
    return { folder, exists: false, files: [], kept: Object.keys(kept).length };
  }
  const docs = store.docs();
  for (const d of docs) {
    if (d.origin !== 'notex' && inside(folder, d.source_path)) { store.setOrigin(d.id, 'notex'); d.origin = 'notex'; }
  }
  const files = names.map((name) => {
    const file = path.join(folder, name);
    const st = fs.statSync(file);
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const same = docs.find((d) => d.sha256 === sha256);
    if (same && same.origin !== 'notex') { store.setOrigin(same.id, 'notex'); same.origin = 'notex'; }
    const older = same ? null : docs.find((d) => d.origin === 'notex' && d.name === name);
    const fabric = name.slice(0, -SUFFIX.length);
    return {
      name, fabric, modified: st.mtime.toISOString(), bytes: st.size, kept: kept[fabric] || null,
      status: same ? 'added' : older ? 'changed' : 'new',
      docId: same ? same.id : older ? older.id : null,
      docStatus: same ? same.status : older ? older.status : null,
    };
  });
  return { folder, exists: true, files: files.sort((a, b) => b.modified.localeCompare(a.modified)), kept: Object.keys(kept).length };
}
