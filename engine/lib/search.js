/* Hybrid search: vector search and keyword search, each taking its own best
 * 40, merged by reciprocal rank fusion (t-c6c48895e7).
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

/* Neighbouring chunks of one document that both made the cut become one
 * passage, joined by dropping the overlap the second one repeats (its lead),
 * so the agent never reads the shared sentences twice (t-45a2280d8f). */
function joinNeighbours(chosen) {
  const byDoc = [...chosen].sort((a, b) => a.doc_id - b.doc_id || a.ord - b.ord);
  const passages = [];
  for (const c of byDoc) {
    const last = passages[passages.length - 1];
    if (last && last.docId === c.doc_id && last.lastOrd === c.ord - 1) {
      last.text += c.text.slice(c.lead);
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
      score: c.fused.score,
      ranks: { vector: c.fused.ranks[0] || null, keyword: c.fused.ranks[1] || null },
    });
  }
  for (const p of passages) delete p.lastOrd;
  return passages.sort((a, b) => b.score - a.score);
}

/* store: the Store; index: a VectorIndex (or null when nothing is embedded);
 * queryVector: the question already embedded. */
export function hybridSearch({ store, index, question, queryVector, k = 8, perDoc = 3, pool = 40 }) {
  const vector = index && queryVector ? index.search(queryVector, pool) : [];
  const match = buildMatch(question);
  const keyword = match ? store.keywordSearch(match, pool) : [];
  const fused = fuse([vector, keyword]);

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
  return joinNeighbours(chosen);
}
