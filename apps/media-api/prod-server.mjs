import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.join(repoRoot, 'apps', 'editor-web');
const distRoot = path.join(webRoot, 'dist');
const indexPath = path.join(distRoot, 'index.html');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function safeResolveDistPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const cleanPath = decoded === '/' ? '/index.html' : decoded;
  const absolutePath = path.resolve(distRoot, `.${cleanPath}`);
  const rel = path.relative(distRoot, absolutePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return absolutePath;
}

async function serveStaticOrSpa(req, res) {
  const targetPath = safeResolveDistPath(req.url || '/');
  if (!targetPath) {
    sendJson(res, 400, { error: 'Invalid path' });
    return;
  }

  try {
    const stat = await fsp.stat(targetPath);
    if (stat.isFile()) {
      const ext = path.extname(targetPath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      fs.createReadStream(targetPath).pipe(res);
      return;
    }
  } catch {
    // SPA fallback below
  }

  try {
    const stat = await fsp.stat(indexPath);
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(indexPath).pipe(res);
  } catch (error) {
    sendJson(res, 500, {
      error: 'Missing frontend build output. Run `npm run build` first.',
      detail: String(error?.message || error),
    });
  }
}

async function bootstrap() {
  const vite = await createViteServer({
    root: webRoot,
    configFile: path.join(webRoot, 'vite.config.ts'),
    appType: 'custom',
    server: {
      middlewareMode: true,
      hmr: false,
    },
  });

  const server = http.createServer(async (req, res) => {
    if (!req.url || !req.method) {
      sendJson(res, 400, { error: 'Bad request' });
      return;
    }

    const pathname = req.url.split('?')[0] || '/';
    if (pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname.startsWith('/api/')) {
      vite.middlewares(req, res, () => {
        if (!res.writableEnded) {
          sendJson(res, 404, { error: 'Not found' });
        }
      });
      return;
    }

    await serveStaticOrSpa(req, res);
  });

  server.listen(PORT, HOST, () => {
    console.log(`prune prod server listening on http://${HOST}:${PORT}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start prod server', error);
  process.exit(1);
});
