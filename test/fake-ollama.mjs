/* A stand-in for `ollama serve`: listens where OLLAMA_HOST says, keeps one
 * model loaded or not, and records each request it gets (GET /calls). An
 * unload (keep_alive 0) of a model that is not loaded loads it first, as the
 * real Ollama does. */
import http from 'node:http';

const [hostname, port] = String(process.env.OLLAMA_HOST || '127.0.0.1:11434').split(':');
if (process.argv[2] === 'fail') { process.stderr.write('Error: listen tcp: bind: address already in use\n'); process.exit(1); }
let loaded = false;
const calls = [];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    calls.push({ path: req.url, body: json });
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/api/version') return send({ version: 'fake' });
    if (req.url === '/calls') return send(calls);
    if (req.url === '/api/ps') return send({ models: loaded ? [{ name: 'nomic-embed-text-v2-moe:latest' }] : [] });
    if (req.url === '/api/embed') {
      loaded = true;
      if (json && json.keep_alive === 0) { loaded = false; return send({ embeddings: [] }); }
      return send({ embeddings: [].concat(json.input).map(() => [0.6, 0.8]) });
    }
    res.writeHead(404); res.end('{}');
  });
}).listen(Number(port), hostname);
