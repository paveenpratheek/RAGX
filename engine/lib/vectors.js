/* Vector search by brute force over one in-memory matrix (t-c6c48895e7).
 *
 * Every vector is normalised, so cosine similarity is a plain dot product.
 * Brute force is exact and needs no index to build or tune; it costs about
 * 3 KB of RAM per chunk at 768 dimensions (t-48cf63b6db). If that stops being
 * enough, an int8 or HNSW index goes behind this same add / remove / search.
 */

export function normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  const out = new Float32Array(v.length);
  if (n === 0) return out;
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/* SQLite hands a BLOB back as a Uint8Array whose offset need not be a multiple
 * of four, and a Float32Array cannot sit on an unaligned offset - so it is
 * copied out rather than viewed in place. */
export function toBlob(v) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function fromBlob(b) {
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

export class VectorIndex {
  constructor(dim) {
    this.dim = dim;
    this.count = 0;
    this.ids = new Int32Array(1024);
    this.data = new Float32Array(1024 * dim);
    this.slot = new Map(); // chunk id -> row
  }

  add(id, vector) {
    if (vector.length !== this.dim) {
      throw new Error(`vector has ${vector.length} dimensions, the index has ${this.dim}`);
    }
    if (this.slot.has(id)) this.remove([id]);
    if (this.count === this.ids.length) this.grow();
    const row = this.count++;
    this.ids[row] = id;
    this.data.set(normalise(vector), row * this.dim);
    this.slot.set(id, row);
  }

  grow() {
    const ids = new Int32Array(this.ids.length * 2);
    ids.set(this.ids);
    const data = new Float32Array(ids.length * this.dim);
    data.set(this.data);
    this.ids = ids;
    this.data = data;
  }

  /* The last row moves into the hole, so removing stays O(1) per id. */
  remove(ids) {
    for (const id of ids) {
      const row = this.slot.get(id);
      if (row === undefined) continue;
      const last = --this.count;
      if (row !== last) {
        const moved = this.ids[last];
        this.ids[row] = moved;
        this.data.copyWithin(row * this.dim, last * this.dim, (last + 1) * this.dim);
        this.slot.set(moved, row);
      }
      this.slot.delete(id);
    }
  }

  /* Top k by dot product. k is small (about 40), so a sorted array of the best
   * so far beats a heap in both code and time. allow, a Set of ids, keeps
   * the scan to those - a conversation's chosen documents - so the top k are
   * theirs, not what is left of everyone's (t-2c61e12cb6). */
  search(query, k, allow = null) {
    const q = normalise(query);
    const dim = this.dim;
    const best = [];
    for (let row = 0; row < this.count; row++) {
      if (allow && !allow.has(this.ids[row])) continue;
      let s = 0;
      const base = row * dim;
      for (let i = 0; i < dim; i++) s += q[i] * this.data[base + i];
      if (best.length < k) {
        best.push({ id: this.ids[row], score: s });
        if (best.length === k) best.sort((a, b) => b.score - a.score);
      } else if (s > best[k - 1].score) {
        let at = k - 1;
        while (at > 0 && best[at - 1].score < s) { best[at] = best[at - 1]; at--; }
        best[at] = { id: this.ids[row], score: s };
      }
    }
    if (best.length < k) best.sort((a, b) => b.score - a.score);
    return best;
  }
}
