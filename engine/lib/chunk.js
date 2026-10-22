/* Blocks in, chunks out: pieces that follow the document's own structure,
 * sized to what the embedding model can take in one go.
 *
 * A chunk never crosses a heading, so the heading path it carries is true of
 * all of it. Inside a section, prose is packed by sentence; code by line and
 * tables by row, so neither is ever cut mid-line, and a table carried on into
 * the next chunk repeats its header.
 *
 * Consecutive prose chunks overlap by whole sentences, up to 250 characters,
 * so a fact that sits on a boundary is whole in at least one of them. Each
 * chunk records the length of that repeat as `lead`, which is what lets search
 * join two neighbours back together without reading it twice (t-1177c55292).
 */

/* Never more than this, whatever the model's window: past it a chunk holds
 * several topics and its one vector describes none of them well. */
export const TARGET = 1800;
export const OVERLAP = 250;

/* Characters per token to size chunks by. Real chunks, embedded with their
 * "document > heading" line, ran 3.64 characters a token at the median but
 * 2.23 at the worst; a chunk sized by the median would be refused, so this
 * sits near the dense end. Going tighter still (2.25) added chunks and left
 * the one densest chunk refused anyway (t-854cd59c18). */
export const CHARS_PER_TOKEN = 2.5;

/* The first target for a model with this many tokens of context: as much of
 * the window as dense text can safely fill (t-74879afa78), never more than
 * TARGET (t-27f743aa8e). */
export function targetFor(windowTokens) {
  if (!windowTokens) return TARGET;
  return Math.min(TARGET, Math.floor(windowTokens * CHARS_PER_TOKEN));
}

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

/* reserve(headingPath): characters the embedded input spends before the text
 * - the "document > heading" line - so text and line together fit the target.
 * Overlap shrinks with the space left, to at most a seventh of it
 * (t-4cc42f1a3a). */
export function chunk(blocks, { target = TARGET, overlap = OVERLAP, reserve = () => 0 } = {}) {
  const chunks = [];
  const stack = []; // open headings, outermost first
  let cur = null;   // { atoms, len, heading, limit }
  const limitOf = (heading) => Math.max(200, target - reserve(heading));

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
    const limit = limitOf(heading);
    cur = { atoms: [], len: 0, heading, lead: 0, limit };
    if (!prev) return;
    // Overlap: whole prose sentences from the end of the previous chunk.
    const most = Math.min(overlap, Math.round(limit / 7));
    const tail = [];
    let len = 0;
    for (let i = prev.atoms.length - 1; i >= 0; i--) {
      const a = prev.atoms[i];
      if (!a.prose) break;
      const add = a.text.length + (tail.length ? tail[0].joiner.length : 0);
      if (len + add > most) break;
      tail.unshift(a);
      len += add;
    }
    const tailLen = tail.reduce((s, a, i) => s + a.text.length + (i ? a.joiner.length : 0), 0);
    if (tail.length && tailLen + next.joiner.length + next.text.length <= limit) {
      cur.atoms.push(...tail);
      cur.len = tailLen;
      cur.lead = tailLen;
    } else if (next.header && next.header.length + 1 + next.text.length <= limit) {
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
    for (const atom of atomsOf(block, prevBlock, limitOf(path()))) {
      if (!cur) start(path(), null, atom);
      const add = (cur.atoms.length ? atom.joiner.length : 0) + atom.text.length;
      if (cur.atoms.length && cur.len + add > cur.limit) {
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
