import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScenario, runAll, createLab, SCENARIO_IDS } from '../public/lab.mjs';

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const STATIC_FILES = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/guide.html', ['text/html; charset=utf-8', 'guide.html']],
  ['/styles.css', ['text/css; charset=utf-8', 'styles.css']],
  ['/pb-shell.css', ['text/css; charset=utf-8', 'pb-shell.css']],
  ['/pb-back.css', ['text/css; charset=utf-8', 'pb-back.css']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/lab.mjs', ['text/javascript; charset=utf-8', 'lab.mjs']],
  ['/model.mjs', ['text/javascript; charset=utf-8', 'model.mjs']],
  ['/kb.mjs', ['text/javascript; charset=utf-8', 'kb.mjs']],
  ['/tools.mjs', ['text/javascript; charset=utf-8', 'tools.mjs']],
  ['/examples.mjs', ['text/javascript; charset=utf-8', 'examples.mjs']],
].map(([path, [type, file]]) => [path, [type, readFileSync(join(PUBLIC, file))]]));
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const JSON_HEADERS = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' };

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// POST /api/run — the same domain module the browser imports, run server-side.
// Body: { layers?: string[], scenario?: 'status'|'forgot'|'refund' }
// Omit `scenario` to run all three.
function handleApiRun(res, payload) {
  const layers = Array.isArray(payload?.layers) ? payload.layers.filter(l => typeof l === 'string') : [];
  if (payload?.scenario) {
    if (!SCENARIO_IDS.includes(payload.scenario)) {
      res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: `unknown scenario: ${payload.scenario}` }));
      return;
    }
    const result = runScenario(createLab({ layers }), payload.scenario);
    res.writeHead(200, JSON_HEADERS).end(JSON.stringify(result));
    return;
  }
  res.writeHead(200, JSON_HEADERS).end(JSON.stringify(runAll({ layers })));
}

export function createStaticServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }
    if (url.pathname === '/version') {
      res.writeHead(200, JSON_HEADERS)
        .end(JSON.stringify({
          name: PACKAGE.name,
          version: PACKAGE.version,
          commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local',
        }));
      return;
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      try {
        handleApiRun(res, JSON.parse((await readBody(req)) || '{}'));
      } catch {
        res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'invalid JSON body' }));
      }
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = STATIC_FILES.get(url.pathname);
      if (asset) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'cache-control': 'public, max-age=300',
          'content-type': asset[0],
        }).end(req.method === 'HEAD' ? undefined : asset[1]);
        return;
      }
    }
    res.writeHead(404, SECURITY_HEADERS).end('not found');
  });
}

export async function startProduction({ port = Number(process.env.PORT) || 3000 } = {}) {
  const server = createStaticServer();
  server.listen(port, '0.0.0.0');
  await once(server, 'listening');
  const close = () => new Promise(resolve => server.close(resolve));
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server, close } = await startProduction();
  console.log(`Packet Climb listening on ${server.address().port}`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
