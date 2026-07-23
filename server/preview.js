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
  </body>
</html>
`;

/** Possible entry file names (in priority order). */
const ENTRY_CANDIDATES = [
  'src/main.jsx',
  'src/main.tsx',
  'src/index.jsx',
  'src/index.tsx',
  'src/app.jsx',
  'src/app.tsx',
  'src/main.js',
  'src/main.ts',
];

/** After writing files, find the actual entry file and inject it into index.html. */
function patchEntry(dir) {
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) return;

  // Find the actual entry from files on disk.
  let entry = null;
  for (const candidate of ENTRY_CANDIDATES) {
    if (fs.existsSync(path.join(dir, candidate))) {
      entry = candidate;
      break;
    }
  }
  if (!entry) return;

  let html = fs.readFileSync(indexPath, 'utf8');

  // Replace any existing module script that has a /src/ or ./src/ reference.
  const hadScript = /<script[^>]*type=["']module["'][^>]*src=["'][^"']*["'][^>]*><\/script>/.test(html);
  if (hadScript) {
    html = html.replace(
      /<script[^>]*type=["']module["'][^>]*src=["'][^"']*["'][^>]*><\/script>/,
      `<script type="module" src="./${entry}"></script>`,
    );
  } else if (html.includes('<div id="root">') || html.includes('<div id="app">') || html.includes('<div id="root')) {
    html = html.replace('</body>', `  <script type="module" src="./${entry}"></script>\n</body>`);
  }

  fs.writeFileSync(indexPath, html, 'utf8');
}

/** Fresh session dir, keeping nothing from a previous iteration. */
function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function buildReact(sid, files) {
  const dir = path.join(PREVIEWS_DIR, sid);
  resetDir(dir);
  writeFiles(dir, files);

  // Ensure an entry HTML exists for Vite, then patch in the real entry script.
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');
  patchEntry(dir);

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
  patchEntry(srcDir);

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
  patchEntry(destDir);

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

  // 远程/云端模式：文件已在服务器磁盘上，无需前端再传文件。
  // 通过 workDir 直接构建预览。
  app.post('/api/preview/:sid/build', async (req, res) => {
    const sid = sanitizeRel(req.params.sid);
    const { workDir } = req.body || {};
    if (!sid) return res.status(400).json({ error: '缺少会话 id' });
    if (!workDir || typeof workDir !== 'string') {
      return res.status(400).json({ error: '缺少 workDir' });
    }
    if (!fs.existsSync(workDir)) {
      return res.status(400).json({ error: '工作目录不存在' });
    }
    try {
      const url = await withLock(sid, () => buildFromDir(sid, workDir));
      res.json({ ok: true, url });
    } catch (err) {
      console.error('[preview] build from dir failed:', err?.message || err);
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
    // fallthrough:false —— 预览资源缺失时直接返回 404，而不是落到
    // 后面的 SPA 入口（app.get('*')）。否则 iframe 会加载一份完整的主
    // 应用副本，同源共享 localStorage 会覆盖掋当前会话。
    handler = express.static(dir, { index: 'index.html', fallthrough: false });
    staticCache.set(dir, handler);
  }
  return handler;
}
