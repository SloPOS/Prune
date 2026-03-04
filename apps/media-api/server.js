const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3199);

const REPO_ROOT = path.resolve(__dirname, '../..');
const ALLOWED_ROOTS = {
  inbox: path.resolve((process.env.PRUNE_INBOX_ROOT) || path.join(REPO_ROOT, 'inbox')),
  archive: path.resolve((process.env.PRUNE_ARCHIVE_ROOT) || path.join(REPO_ROOT, 'data', 'archive')),
};

const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.opus'
]);

const TRANSCRIPT_SUFFIXES = ['.transcript.json', '.json'];

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBool(v, fallback = false) {
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function parseBoundedInt(value, { fallback, min, max }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const intValue = Math.trunc(parsed);
  return Math.min(Math.max(intValue, min), max);
}

function normalizeRelativeDir(dirRaw) {
  const input = typeof dirRaw === 'string' ? dirRaw.trim() : '';
  if (!input) return '';
  const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '/') return '';
  return normalized.replace(/^\/+/, '');
}

function resolveSafePath(rootPath, relativeDir) {
  const targetPath = path.resolve(rootPath, relativeDir || '.');
  const rel = path.relative(rootPath, targetPath);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw Object.assign(new Error('Path escapes allowed root'), { statusCode: 400 });
  }
  return targetPath;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findTranscriptForMedia(filePath) {
  const ext = path.extname(filePath);
  const baseWithoutExt = filePath.slice(0, -ext.length);

  for (const suffix of TRANSCRIPT_SUFFIXES) {
    const candidate = `${baseWithoutExt}${suffix}`;
    if (await pathExists(candidate)) return candidate;
  }

  return null;
}

async function walkMediaFiles(startPath, { recursive = false, limit = 500 } = {}) {
  const files = [];
  const queue = [startPath];
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    const dirEntries = await fs.readdir(current, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (recursive) queue.push(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext)) continue;

      files.push(fullPath);
      if (files.length >= limit) return files;
    }
  }

  return files;
}

async function buildMediaRecord(rootPath, absoluteFilePath, { includeAbsolutePaths = false } = {}) {
  const [stat, transcriptPath] = await Promise.all([
    fs.stat(absoluteFilePath),
    findTranscriptForMedia(absoluteFilePath),
  ]);

  const relativePath = path.relative(rootPath, absoluteFilePath);
  const transcriptRelativePath = transcriptPath ? path.relative(rootPath, transcriptPath) : null;

  return {
    name: path.basename(absoluteFilePath),
    path: relativePath,
    absolutePath: includeAbsolutePaths ? absoluteFilePath : undefined,
    extension: path.extname(absoluteFilePath).toLowerCase(),
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    transcript: transcriptPath
      ? {
          exists: true,
          path: transcriptRelativePath,
          absolutePath: includeAbsolutePaths ? transcriptPath : undefined,
        }
      : {
          exists: false,
          path: null,
          absolutePath: includeAbsolutePaths ? null : undefined,
        },
  };
}

async function mapWithConcurrency(items, limit, mapFn) {
  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapFn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function handleListMedia(req, res, url) {
  const rootKey = url.searchParams.get('root') || 'inbox';
  const relativeDir = normalizeRelativeDir(url.searchParams.get('dir') || '');
  const recursive = parseBool(url.searchParams.get('recursive'), false);
  const includeAbsolutePaths = parseBool(url.searchParams.get('includeAbsolutePaths'), false);
  const limit = parseBoundedInt(url.searchParams.get('limit') || 200, {
    fallback: 200,
    min: 1,
    max: 2000,
  });
  const metadataConcurrency = parseBoundedInt(url.searchParams.get('metadataConcurrency') || 24, {
    fallback: 24,
    min: 1,
    max: 64,
  });

  const rootPath = ALLOWED_ROOTS[rootKey];
  if (!rootPath) {
    return sendJson(res, 400, { error: 'Invalid root', allowedRoots: Object.keys(ALLOWED_ROOTS) });
  }

  try {
    const targetDir = resolveSafePath(rootPath, relativeDir);
    const stat = await fs.stat(targetDir);
    if (!stat.isDirectory()) {
      return sendJson(res, 400, { error: 'Target is not a directory' });
    }

    const mediaFiles = await walkMediaFiles(targetDir, { recursive, limit });
    const items = await mapWithConcurrency(
      mediaFiles,
      metadataConcurrency,
      (filePath) => buildMediaRecord(rootPath, filePath, { includeAbsolutePaths }),
    );

    return sendJson(res, 200, {
      root: rootKey,
      rootPath,
      directory: path.relative(rootPath, targetDir) || '.',
      recursive,
      includeAbsolutePaths,
      limit,
      metadataConcurrency,
      count: items.length,
      items,
    });
  } catch (error) {
    const statusCode = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    return sendJson(res, statusCode, { error: error.message });
  }
}

function handleListRoots(_req, res) {
  sendJson(res, 200, {
    roots: Object.entries(ALLOWED_ROOTS).map(([key, rootPath]) => ({ key, rootPath })),
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/roots') {
    return handleListRoots(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/media') {
    return handleListMedia(req, res, url);
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`media-api listening on http://localhost:${PORT}`);
});
