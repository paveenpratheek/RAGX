/* The Markdown an answer arrives in, made safe to show.
 *
 * parse() turns text into a plain tree; toDom() builds DOM from it with
 * createElement and textContent only. Nothing an agent writes - and nothing a
 * document fed it - ever reaches innerHTML, so a passage holding <script> or
 * an onerror attribute shows as the characters it is.
 *
 * Only what answers use: paragraphs, headings, lists, code, tables, bold,
 * italics, inline code, and citations [2] / [1][3] / [1, 4] / [2-4] turned
 * into numbers the page can make clickable. Links keep their text, not their
 * target: an answer is not a place to navigate from.
 */

const CITE = /\[(\d{1,4}(?:\s*[-–,]\s*\d{1,4})*)\]/g;

function citeNumbers(inner) {
  const out = [];
  for (const part of inner.split(',')) {
    const [a, b] = part.split(/[-–]/).map((x) => Number(x.trim()));
    if (b === undefined) out.push(a);
    else if (b >= a && b - a <= 20) for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

export function inline(text) {
  const nodes = [];
  const push = (n) => {
    const last = nodes[nodes.length - 1];
    if (n.t === 'text' && last && last.t === 'text') last.v += n.v;
    else nodes.push(n);
  };
  let s = String(text).replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1'); // links keep their text
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[(\d{1,4}(?:\s*[-–,]\s*\d{1,4})*)\])/g;
  let at = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > at) push({ t: 'text', v: s.slice(at, m.index) });
    if (m[2] || m[3]) nodes.push({ t: 'strong', c: inline(m[2] || m[3]) });
    else if (m[4]) nodes.push({ t: 'code', v: m[4] });
    else if (m[5] || m[6]) nodes.push({ t: 'em', c: inline(m[5] || m[6]) });
    else if (m[7]) for (const n of citeNumbers(m[7])) nodes.push({ t: 'cite', n });
    at = re.lastIndex;
  }
  if (at < s.length) push({ t: 'text', v: s.slice(at) });
  return nodes;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

export function parse(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) blocks.push({ t: 'p', c: inline(para.join(' ')) }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); blocks.push({ t: 'h', level: h[1].length, c: inline(h[2]) }); continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
      i--;
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    const item = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]);
      const last = blocks[blocks.length - 1];
      if (last && last.t === 'list' && last.ordered === ordered) last.items.push(inline(item[2]));
      else blocks.push({ t: 'list', ordered, items: [inline(item[2])] });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/* Every citation number in the text, in order of first appearance. */
export function citedIn(text) {
  const seen = [];
  for (const m of String(text).matchAll(CITE)) for (const n of citeNumbers(m[1])) if (!seen.includes(n)) seen.push(n);
  return seen;
}

/* cite(n) returns the element for a citation - the page decides what it is. */
export function toDom(blocks, doc, { cite }) {
  const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };
  const runs = (nodes, into) => {
    for (const n of nodes) {
      if (n.t === 'text') into.appendChild(doc.createTextNode(n.v));
      else if (n.t === 'code') { const c = el('code'); c.textContent = n.v; into.appendChild(c); }
      else if (n.t === 'strong' || n.t === 'em') { const e = el(n.t); runs(n.c, e); into.appendChild(e); }
      else if (n.t === 'cite') into.appendChild(cite(n.n));
    }
    return into;
  };
  const frag = doc.createDocumentFragment();
  for (const b of blocks) {
    if (b.t === 'p') frag.appendChild(runs(b.c, el('p')));
    else if (b.t === 'h') frag.appendChild(runs(b.c, el('h' + Math.min(b.level + 2, 6))));
    else if (b.t === 'pre') { const p = el('pre'); p.textContent = b.v; frag.appendChild(p); }
    else if (b.t === 'list') {
      const l = el(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) l.appendChild(runs(it, el('li')));
      frag.appendChild(l);
    } else if (b.t === 'table') {
      const wrap = el('div', 'table-wrap');
      const tbl = el('table');
      const tr = el('tr');
      for (const h of b.head) tr.appendChild(runs(h, el('th')));
      const thead = el('thead'); thead.appendChild(tr); tbl.appendChild(thead);
      const tbody = el('tbody');
      for (const r of b.rows) { const row = el('tr'); for (const c of r) row.appendChild(runs(c, el('td'))); tbody.appendChild(row); }
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      frag.appendChild(wrap);
    }
  }
  return frag;
}
