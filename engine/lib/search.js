/* Hybrid search: vector search and keyword search, each taking its own best
 * 40, merged by reciprocal rank fusion (t-c6c48895e7). Figures are searched
 * beside them, the question's vector against the figures' (t-d3dd407413),
 * so a chart can be found by describing it.
 *
 * Both are needed. Vector search finds a passage that says the same thing in
 * other words; keyword search finds the one that holds the exact invoice
 * number, name or code, which embeddings blur. RRF merges by rank alone, so
 * neither side's score scale has to be calibrated against the other's.
 */

export const RRF_K = 60;

const STOPWORDS = new Set((
  'a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
  'me my of on or our should so than that the their them then there these they this to was we were what ' +
  'when where which who whom why will with would you your'
).split(' '));

/* The question is never handed to MATCH as written (t-d6e12ce52f): FTS5 reads
 * hyphens, colons and quotes as query syntax, so the code INV-2024-0042 typed
 * bare fails with "no such column: 2024". Each word is quoted on its own - a
 * quoted INV-2024-0042 is the phrase inv 2024 0042 - and the words are OR'd,
 * leaving bm25 to rank rows that hold more and rarer of them higher. */
export function buildMatch(question) {
  const words = String(question).toLowerCase().match(/[\p{L}\p{N}]+(?:[-_.'/][\p{L}\p{N}]+)*/gu) || [];
  const terms = [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
  if (!terms.length) return null;
  return terms.map((t) => '"' + t + '"').join(' OR ');
}

/* lists: arrays of {id}, each best-first. Returns [{id, score, ranks}] with
 * ranks naming where each list put it (1-based), for showing why it came up. */
export function fuse(lists, k = RRF_K) {
  const acc = new Map();
  lists.forEach((list, which) => {
    list.forEach((item, i) => {
      const e = acc.get(item.id) || { id: item.id, score: 0, ranks: {} };
      e.score += 1 / (k + i + 1);
      e.ranks[which] = i + 1;
      acc.set(item.id, e);
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/* Neighbouring chunks of one section that both made the cut become one
 * passage, joined by dropping the overlap the second one repeats (its lead),
 * so the agent never reads the shared sentences twice (t-45a2280d8f). Chunks
 * either side of a heading stay apart: each passage keeps one heading path
 * that is true of all of it (t-dcfef3abdf). */
function joinNeighbours(chosen) {
  const byDoc = [...chosen].sort((a, b) => a.doc_id - b.doc_id || a.ord - b.ord);
  const passages = [];
  for (const c of byDoc) {
    const last = passages[passages.length - 1];
    // A reading never joins the author's text, or another figure's (t-7febde7b9f).
    if (last && last.docId === c.doc_id && last.lastOrd === c.ord - 1 && last.heading === c.heading && last.readFrom === (c.figure_id ?? null)) {
      // No overlap (code, table rows): the chunks met at a line break.
      last.text += c.lead ? c.text.slice(c.lead) : '\n' + c.text;
      last.chunkIds.push(c.id);
      last.lastOrd = c.ord;
      last.pageTo = c.page_to ?? last.pageTo;
      last.score = Math.max(last.score, c.fused.score);
      continue;
    }
    passages.push({
      docId: c.doc_id,
      docName: c.doc_name,
      heading: c.heading,
      pageFrom: c.page_from,
      pageTo: c.page_to,
      text: c.text,
      chunkIds: [c.id],
      lastOrd: c.ord,
      readFrom: c.figure_id ?? null,
      score: c.fused.score,
      ranks: { vector: c.fused.ranks[0] || null, keyword: c.fused.ranks[1] || null },
    });
  }
  for (const p of passages) { delete p.lastOrd; if (p.readFrom === null) delete p.readFrom; }
  return passages.sort((a, b) => b.score - a.score);
}

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/* Where a figure belongs in the text: its caption, else the text beside it -
 * the first 60 characters, enough to be unmistakable. */
function anchorKey(f) {
  const key = flat(f.caption || f.anchor).slice(0, 60);
  return key.length >= 12 ? key : null;
}

/* What a figure says of itself as a source: its caption, or that it has none
 * and what it sits beside. */
export function figureText(f) {
  if (f.caption) return f.caption;
  const what = f.kind === 'image' ? 'A picture' : 'A figure';
  return `${what} with no caption${f.anchor ? `, beside: "${f.anchor.slice(0, 160)}"` : ''}`;
}

/* A figure beside a passage, with what Claude read in it, if it was read. */
const figureRef = (store, f) => ({ figureId: f.id, kind: f.kind, page: f.page, caption: f.caption, reading: store.figureReading(f.id) || undefined });

/* How close a question must come to a figure for the figure to count as
 * found. Measured with embeddinggemma-2 on the user's documents: questions
 * describing a figure put it at 0.73-0.81, unrelated questions put the best
 * figure at 0.59-0.65 (t-a5489543e0, t-525cbbd9a7). Figures are kept out of
 * the text fusion: ranked in one list where a passage is ranked in two, they
 * were crowded out of every result (t-73abd85797). */
export const FIGURE_FLOOR = 0.68;

/* store: the Store; index and figureIndex: VectorIndexes (or null when nothing
 * is embedded); queryVector: the question already embedded. Returns the text
 * passages best first, each with the figures in it that the question reaches
 * (at most perPassage), then up to maxFigures figures found on their own,
 * marked by figureId (t-d3dd407413). */
export function hybridSearch({ store, index, figureIndex = null, question, queryVector, k = 8, perDoc = 3, pool = 40,
  maxFigures = 3, perPassage = 2, figureFloor = FIGURE_FLOOR }) {
  const vector = index && queryVector ? index.search(queryVector, pool) : [];
  const match = buildMatch(question);
  const keyword = match ? store.keywordSearch(match, pool) : [];
  const fused = fuse([vector, keyword]);
  const pictures = figureIndex && queryVector ? figureIndex.search(queryVector, pool) : [];
  const rank = new Map(pictures.map((h, i) => [h.id, { rank: i + 1, score: h.score }]));
  const reached = (id) => (rank.get(id)?.score ?? -1) >= figureFloor;

  /* At most perDoc chunks from one document, so one long document cannot
   * crowd every other source out of the answer (t-45a2280d8f). */
  const chosen = [];
  const perDocCount = new Map();
  for (const f of fused) {
    if (chosen.length === k) break;
    const c = store.chunk(f.id);
    if (!c) continue;
    const n = perDocCount.get(c.doc_id) || 0;
    if (n >= perDoc) continue;
    perDocCount.set(c.doc_id, n + 1);
    chosen.push({ ...c, fused: f });
  }
  const passages = joinNeighbours(chosen);

  /* A figure goes with the passage that holds its caption or the text
   * beside it, so a chart comes back with the paragraph that explains it -
   * the ones the question reaches, best first, since one long passage can
   * hold a dozen short captions. Without a question vector (keyword search
   * only) the first ones go. A figure found on its own and sitting in a
   * passage found too is that passage's, not a second result. */
  const byDoc = new Map();
  const figuresOf = (docId) => { if (!byDoc.has(docId)) byDoc.set(docId, store.docFigures(docId)); return byDoc.get(docId); };
  const attached = new Set();
  const own = passages.filter((p) => !p.readFrom);
  for (const p of own) {
    const text = flat(p.text);
    let inside = figuresOf(p.docId).filter((f) => { const key = anchorKey(f); return key && text.includes(key); });
    if (pictures.length) inside = inside.filter((f) => reached(f.id)).sort((a, b) => rank.get(a.id).rank - rank.get(b.id).rank);
    p.figures = inside.slice(0, perPassage).map((f) => figureRef(store, f));
    for (const f of p.figures) attached.add(f.figureId);
  }

  /* A passage Claude read from an image comes back as that image's figure,
   * with the reading beside it - never as text of the document's own
   * (t-7febde7b9f). A figure already beside a passage found goes with that
   * passage; several pieces of one reading are one result (t-0b8f6aab0e).
   * The figure floor is for finding a figure by its look; one whose reading
   * the question reaches comes back however far its image is (t-44b0b2c989). */
  const asFigure = new Map();
  for (const p of passages.filter((x) => x.readFrom)) {
    if (attached.has(p.readFrom)) continue;
    const seen = asFigure.get(p.readFrom);
    if (seen) { seen.score = Math.max(seen.score, p.score); seen.chunkIds.push(...p.chunkIds); continue; }
    const f = store.figure(p.readFrom);
    if (f) asFigure.set(f.id, figureResult(store, f, { score: p.score, ranks: p.ranks, chunkIds: [...p.chunkIds] }));
  }
  const alone = [];
  for (const h of pictures) {
    if (alone.length === maxFigures || h.score < figureFloor) break;
    if (attached.has(h.id) || asFigure.has(h.id)) continue;
    const f = store.figure(h.id);
    if (f) alone.push(figureResult(store, f, { score: h.score, ranks: { figure: rank.get(h.id).rank }, chunkIds: [] }));
  }
  return [...[...own, ...asFigure.values()].sort((a, b) => b.score - a.score), ...alone];
}

/* A figure as a result of its own: its caption as its text, and what Claude
 * read in it, if it was read. */
function figureResult(store, f, { score, ranks, chunkIds }) {
  return {
    docId: f.doc_id, docName: f.doc_name, heading: f.heading, pageFrom: f.page, pageTo: f.page,
    text: figureText(f), reading: store.figureReading(f.id) || undefined, chunkIds, figureId: f.id, kind: f.kind, figures: [],
    score, ranks,
  };
}
