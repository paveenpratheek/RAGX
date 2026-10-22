import { DEFAULT_MODEL } from '../engine/lib/embed.js';

/* A stand-in Ollama. Vectors are words hashed into buckets, so texts that
 * share words are close - enough to test the pipeline, not meaning. */
export function fakeOllama({ models = { [DEFAULT_MODEL]: 64, other: 32 }, ctx = 512, maxChars = Infinity, failAfter = Infinity } = {}) {
  const state = { embedCalls: 0, inputs: [], refusals: 0 };
  const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619); return h >>> 0; };
  const vec = (text, dim) => {
    const v = new Array(dim).fill(0);
    for (const word of text.toLowerCase().match(/\p{L}+|\p{N}+/gu) || []) v[hash(word.replace(/s$/, '')) % dim] += 1;
    return v;
  };
  const reply = (status, json) => ({ ok: status < 300, status, statusText: String(status), json: async () => json });
  state.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const dim = models[body.model];
    const p = new URL(url).pathname;
    if (!dim) return reply(404, { error: `model "${body.model}" not found, try pulling it first` });
    if (p === '/api/show') {
      return reply(200, { capabilities: ['embedding'], model_info: { 'general.architecture': 'fake', 'fake.embedding_length': dim, 'fake.context_length': ctx } });
    }
    if (state.embedCalls >= failAfter) throw new TypeError('fetch failed');
    state.embedCalls++;
    if (body.input.some((t) => t.length > maxChars)) {
      state.refusals++;
      return reply(400, { error: 'the input length exceeds the context length' });
    }
    state.inputs.push(...body.input);
    return reply(200, { embeddings: body.input.map((t) => vec(t, dim)) });
  };
  return state;
}
