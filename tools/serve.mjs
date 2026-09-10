// Dependency-free static file server for local development. Serves this
// project directory over http://localhost so service workers actually
// register (they refuse to on file://) — this is how the PWA gets tested
// without deploying anywhere.
//
// Usage:
//   node tools/serve.mjs           serve on PORT env var or 3000
//   node tools/serve.mjs 8080      serve on port 8080
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const PORT = Number(process.env.PORT || process.argv[2]) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.css': 'text/css; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  // A directory resolves to index.html, the same as GitHub Pages does. This
  // used to point straight at the app, which was fine when nothing was served
  // at the root — but index.html is now a redirect stub, and pointing '/'
  // past it would mean the dev server and the deployed site disagreed about
  // the one URL people actually type. Test what ships.
  const rel = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
  const full = normalize(join(ROOT, rel));
  // Path traversal: the resolved path must stay inside ROOT.
  if (full !== ROOT && !full.startsWith(ROOT + '\\') && !full.startsWith(ROOT + '/')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const st = await stat(full);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Serving ${ROOT} at http://localhost:${PORT}/`);
});
