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
