import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PREVIEWS_DIR = path.join(__dirname, '.previews');

fs.mkdirSync(PREVIEWS_DIR, { recursive: true });

// Serialize builds per session so concurrent requests for the same session
// don't stomp on each other's files.
const locks = new Map();

function withLock(sid, fn) {
  const prev = locks.get(sid) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(sid, next.catch(() => {}));
  return next;
}

function sanitizeRel(p) {
  // Prevent path traversal; normalize to a project-relative posix path.
  const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/');
}

export function writeFiles(dir, files) {
  for (const f of files) {
    const rel = sanitizeRel(f.path);
    if (!rel) continue;
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(f.content ?? ''), 'utf8');
  }
}

const DEFAULT_INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Generated App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

/** Fresh session dir, keeping nothing from a previous iteration. */
function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function buildReact(sid, files) {
  const dir = path.join(PREVIEWS_DIR, sid);
  resetDir(dir);
  writeFiles(dir, files);

  // Ensure an entry HTML exists for Vite.
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');

  // Import lazily so the server can boot even if vite isn't needed yet.
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  await build({
    root: dir,
    base: './',
    logLevel: 'silent',
    configFile: false,
    plugins: [react()],
    build: {
      outDir: path.join(dir, 'dist'),
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
    },
  });

  return `/preview/${sid}/`;
}

function buildHtml(sid, files) {
  const dir = path.join(PREVIEWS_DIR, sid);
  const distDir = path.join(dir, 'dist');
  resetDir(dir);
  fs.mkdirSync(distDir, { recursive: true });
  const entry = files.find((f) => sanitizeRel(f.path) === 'index.html') || files[0];
  fs.writeFileSync(path.join(distDir, 'index.html'), String(entry?.content ?? ''), 'utf8');
  return `/preview/${sid}/`;
}

/**
 * Build a React project from an existing source directory (CLI mode).
 * The source files already exist in srcDir; we build into the preview
 * session output directory, keeping the source intact.
 */
export async function buildFromDir(sid, srcDir) {
  const previewDir = path.join(PREVIEWS_DIR, sid);
  const distDir = path.join(previewDir, 'dist');

  // Ensure an index.html exists for Vite.
  const indexPath = path.join(srcDir, 'index.html');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');

  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  fs.mkdirSync(distDir, { recursive: true });

  await build({
    root: srcDir,
    base: './',
    logLevel: 'silent',
    configFile: false,
    plugins: [react()],
    build: {
      outDir: distDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
    },
  });

  return `/preview/${sid}/`;
}

/**
 * Build a project (multi-file React or single HTML) into <destDir>/dist,
 * writing the source files into destDir first. Used by the publish feature
 * to produce a persistent, shareable build separate from ephemeral previews.
 */
export async function buildForPublish(destDir, files, framework) {
  resetDir(destDir);
  writeFiles(destDir, files);
  const distDir = path.join(destDir, 'dist');

  if (framework === 'html') {
    fs.mkdirSync(distDir, { recursive: true });
    const entry = files.find((f) => sanitizeRel(f.path) === 'index.html') || files[0];
    fs.writeFileSync(path.join(distDir, 'index.html'), String(entry?.content ?? ''), 'utf8');
    return;
  }

  // Ensure an entry HTML exists for Vite.
  const indexPath = path.join(destDir, 'index.html');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');

  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  await build({
    root: destDir,
    base: './',
    logLevel: 'silent',
    configFile: false,
    plugins: [react()],
    build: {
      outDir: distDir,
      emptyOutDir: true,
      chunkSizeWarningLimit: 4000,
    },
  });
}

/** Register the preview build endpoint and static serving. */
export function mountPreview(app) {
  app.post('/api/preview/:sid', async (req, res) => {
    const sid = sanitizeRel(req.params.sid);
    const { files, framework } = req.body || {};
    if (!sid) return res.status(400).json({ error: '缺少会话 id' });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '缺少 files 参数' });
    }
    try {
      const url = await withLock(sid, () =>
        framework === 'html' ? buildHtml(sid, files) : buildReact(sid, files),
      );
      res.json({ ok: true, url });
    } catch (err) {
      console.error('[preview] build failed:', err?.message || err);
      res.status(500).json({ error: `构建失败：${err?.message || '未知错误'}` });
    }
  });

  // Serve each session's built output at /preview/<sid>/.
  app.use('/preview/:sid', (req, res, next) => {
    const sid = sanitizeRel(req.params.sid);
    const distDir = path.join(PREVIEWS_DIR, sid, 'dist');
    staticFor(distDir)(req, res, next);
  });
}

// Lazily created express.static handlers, cached per directory.
const staticCache = new Map();
function staticFor(dir) {
  let handler = staticCache.get(dir);
  if (!handler) {
    handler = express.static(dir, { index: 'index.html', fallthrough: true });
    staticCache.set(dir, handler);
  }
  return handler;
}
