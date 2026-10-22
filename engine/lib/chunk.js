/* Blocks in, chunks out: pieces of about 1800 characters that follow the
 * document's own structure.
 *
 * 1800 characters is about 386 tokens, inside the 512-token window of the
 * embedding model (t-833b7833e5). A chunk never crosses a heading, so the
 * heading path it carries is true of all of it. Inside a section, prose is
 * packed by sentence; code by line and tables by row, so neither is ever cut
 * mid-line, and a table carried on into the next chunk repeats its header.
 *
 * Consecutive prose chunks overlap by up to 250 characters of whole sentences,
 * so a fact that sits on a boundary is whole in at least one of them. Each
 * chunk records the length of that repeat as `lead`, which is what lets search
 * join two neighbours back together without reading it twice (t-1177c55292).
 */

export const TARGET = 1800;
export const OVERLAP = 250;

const sentenceSplitter = new Intl.Segmenter('en', { granularity: 'sentence' });

/* Text longer than max, cut at the last whitespace before the limit - or at
 * the limit itself when there is none, as in a long URL or a hash. */
function hardSplit(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/* Atoms are what chunks are packed from: a sentence, a line group of code or
 * a table row. `joiner` is what separates an atom from the one before it in
 * running text; `prose` atoms may be repeated as overlap. */
function atomsOf(block, prevBlock, target) {
  const atoms = [];
  const first = (b) => {
    if (b.kind === 'para' && prevBlock && prevBlock.kind === 'para' &&
        b.text.startsWith('- ') && prevBlock.text.startsWith('- ')) return '\n';
    return '\n\n';
  };
  const page = block.page ?? null;

  if (block.kind === 'para') {
    const sentences = [];
    for (const { segment } of sentenceSplitter.segment(block.text)) {
      const s = segment.trim();
      if (!s) continue;
      if (s.length <= target) sentences.push(s);
      else sentences.push(...hardSplit(s, target));
    }
    sentences.forEach((s, i) => atoms.push({ text: s, joiner: i ? ' ' : first(block), page, prose: true }));
  } else if (block.kind === 'code') {
    let group = [];
    let len = 0;
    const flushGroup = () => {
      if (group.length) atoms.push({ text: group.join('\n'), joiner: atoms.length ? '\n' : first(block), page, prose: false });
      group = [];
      len = 0;
    };
    for (const line of block.text.split('\n')) {
      for (const piece of line.length > target ? hardSplit(line, target) : [line]) {
        if (len + piece.length + 1 > target / 3 && group.length) flushGroup();
        group.push(piece);
        len += piece.length + 1;
      }
    }
    flushGroup();
  } else if (block.kind === 'table') {
    const rows = block.rows || block.text.split('\n');
    rows.forEach((r, i) => {
      for (const piece of r.length > target ? hardSplit(r, target) : [r]) {
        atoms.push({ text: piece, joiner: atoms.length ? '\n' : first(block), page, prose: false, header: i === 0 ? null : rows[0] });
      }
    });
  }
  return atoms;
}

export function chunk(blocks, { target = TARGET, overlap = OVERLAP } = {}) {
  const chunks = [];
  const stack = []; // open headings, outermost first
  let cur = null;   // { atoms, len, heading }

  const emit = () => {
    if (!cur || !cur.atoms.length) { cur = null; return; }
    const text = cur.atoms.map((a, i) => (i ? a.joiner : '') + a.text).join('');
    const pages = cur.atoms.map((a) => a.page).filter((p) => p !== null);
    chunks.push({
      heading: cur.heading,
      text,
      lead: cur.lead,
      pageFrom: pages.length ? Math.min(...pages) : null,
      pageTo: pages.length ? Math.max(...pages) : null,
    });
    cur = null;
  };

  const start = (heading, prev, next) => {
    cur = { atoms: [], len: 0, heading, lead: 0 };
    if (!prev) return;
    // Overlap: whole prose sentences from the end of the previous chunk.
    const tail = [];
    let len = 0;
    for (let i = prev.atoms.length - 1; i >= 0; i--) {
      const a = prev.atoms[i];
      if (!a.prose) break;
      const add = a.text.length + (tail.length ? tail[0].joiner.length : 0);
      if (len + add > overlap) break;
      tail.unshift(a);
      len += add;
    }
    const tailLen = tail.reduce((s, a, i) => s + a.text.length + (i ? a.joiner.length : 0), 0);
    if (tail.length && tailLen + next.joiner.length + next.text.length <= target) {
      cur.atoms.push(...tail);
      cur.len = tailLen;
      cur.lead = tailLen;
    } else if (next.header && next.header.length + 1 + next.text.length <= target) {
      // A table carried on: its header row opens the new chunk.
      cur.atoms.push({ text: next.header, joiner: '\n\n', page: next.page, prose: false });
      cur.len = next.header.length;
    }
  };

  const path = () => stack.map((h) => h.text).join(' > ');

  let prevBlock = null;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      emit();
      const level = block.level || 1;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: block.text });
      prevBlock = block;
      continue;
    }
    for (const atom of atomsOf(block, prevBlock, target)) {
      if (!cur) start(path(), null, atom);
      const add = (cur.atoms.length ? atom.joiner.length : 0) + atom.text.length;
      if (cur.atoms.length && cur.len + add > target) {
        const prev = cur;
        emit();
        start(prev.heading, prev, atom);
      }
      cur.len += (cur.atoms.length ? atom.joiner.length : 0) + atom.text.length;
      cur.atoms.push(atom);
    }
    prevBlock = block;
  }
  emit();
  return chunks;
}
