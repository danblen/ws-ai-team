import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');
const APP_NODE_MODULES = path.join(APP_ROOT, 'node_modules');

// Create a require() that resolves packages from the main app's node_modules.
// This is used by the resolve plugin to find packages that the preview project
// doesn't have installed locally (React, ReactDOM, etc.).
const appRequire = createRequire(path.join(APP_ROOT, 'package.json'));

// ---------- Config ----------

// Must match the Vite `base` config in vite.config.ts so that URLs Vite
// generates (e.g. /ai-team/preview/<sid>/@vite/client) match what the
// browser resolves through nginx's path rewriting.
const APP_BASE_PATH = (process.env.APP_BASE_PATH || '/ai-team').replace(/\/+$/, '');
const STALE_MS = 30 * 60 * 1000;        // 30 min idle → auto-cleanup
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

// ---------- State ----------

/** sid → { vite, workDir, createdAt, lastAccess } */
const servers = new Map();
let cleanupTimer = null;

// ---------- Helpers ----------

function sanitizeRel(p) {
  const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/');
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

/** Possible entry file names in priority order. */
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

/**
 * Ensure the workDir has an index.html and that it references the
 * project's actual entry file. Modifies source files in place — acceptable
 * because this is the CLI's workspace, not a precious source tree.
 */
function ensureIndexHtml(dir) {
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, DEFAULT_INDEX_HTML, 'utf8');
    return;
  }

  let html = fs.readFileSync(indexPath, 'utf8');

  // If there's already a module-script tag, check it references a real file.
  const existingSrc = html.match(/<script[^>]*type=["']module["'][^>]*src=["']([^"']*)["']/);
  if (existingSrc) {
    const src = existingSrc[1];
    const rel = src.replace(/^\.?\//, '');
    if (rel && fs.existsSync(path.join(dir, rel))) return; // already correct
  }

  // Find the actual entry file
  let entry = null;
  for (const candidate of ENTRY_CANDIDATES) {
    if (fs.existsSync(path.join(dir, candidate))) {
      entry = candidate;
      break;
    }
  }
  if (!entry) return;

  // Replace any existing module-script, or inject one before </body>
  if (html.includes('<script type="module') || html.includes("<script type='module")) {
    html = html.replace(
      /<script[^>]*type=["']module["'][^>]*src=["'][^"']*["'][^>]*><\/script>/,
      `<script type="module" src="./${entry}"></script>`,
    );
  } else if (
    html.includes('<div id="root">') ||
    html.includes('<div id="app">') ||
    html.includes('<div id="root')
  ) {
    html = html.replace('</body>', `  <script type="module" src="./${entry}"></script>\n</body>`);
  }

  fs.writeFileSync(indexPath, html, 'utf8');
}

// ---------- Vite plugin: resolve bare imports from the main app's node_modules ----------

/**
 * Vite plugin that resolves bare imports (e.g. `import React from 'react'`)
 * by falling back to the main application's node_modules.  This is necessary
 * because the preview project directory typically doesn't have a
 * node_modules/ of its own.
 *
 * Only activates for imports that Vite's standard resolvers couldn't handle.
 */
function resolveFromAppModules() {
  return {
    name: 'vite:resolve-app-modules',
    enforce: 'post',
    resolveId(id, importer) {
      // Only handle bare (non-relative, non-absolute, non-internal) imports
      if (!importer) return null;
      if (id.startsWith('.') || id.startsWith('\0') || id.startsWith('/')) return null;

      // Let Vite handle its own internal modules
      if (id.startsWith('@vite/') || id.startsWith('vite/')) return null;

      try {
        const resolved = appRequire.resolve(id, { paths: [APP_ROOT] });
        // Only accept if it actually resolved inside app's node_modules
        // (not a globally-installed module or built-in)
        if (resolved && resolved.startsWith(APP_NODE_MODULES + '/') || resolved === APP_NODE_MODULES) {
          return { id: resolved, external: false };
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

// ---------- Public API ----------

/**
 * Start (or re-use) a Vite dev server for the given session and work
 * directory.  Returns the root-relative preview URL (e.g. /preview/<sid>/).
 */
export async function startDevServer(sid, workDir) {
  const cleanSid = sanitizeRel(sid);
  if (!cleanSid || !workDir) throw new Error('startDevServer: sid and workDir required');

  // Already running — bump lastAccess and return cached URL
  if (servers.has(cleanSid)) {
    servers.get(cleanSid).lastAccess = Date.now();
    return `/preview/${cleanSid}/`;
  }

  // Ensure index.html exists with a correct entry reference
  ensureIndexHtml(workDir);

  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  const base = `${APP_BASE_PATH}/preview/${cleanSid}/`;

  const vite = await createServer({
    root: workDir,
    base,
    server: {
      middlewareMode: true,
      hmr: false,
      fs: {
        allow: [workDir, APP_NODE_MODULES],
      },
    },
    appType: 'spa',
    plugins: [
      react({ fastRefresh: false }),
      resolveFromAppModules(),
    ],
    configFile: false,
    logLevel: 'silent',
  });

  const entry = { vite, workDir, createdAt: Date.now(), lastAccess: Date.now() };
  servers.set(cleanSid, entry);

  // Start background cleanup if not running
  if (!cleanupTimer) {
    cleanupTimer = setInterval(cleanupStale, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
  }

  console.log(`[preview-dev] started: ${cleanSid} ← ${workDir}  base=${base}`);
  return `/preview/${cleanSid}/`;
}

/** Get a running dev server entry, or null. */
export function getDevServer(sid) {
  const entry = servers.get(sanitizeRel(sid));
  return entry || null;
}

/** Stop the dev server for a session. */
export async function stopDevServer(sid) {
  const cleanSid = sanitizeRel(sid);
  const entry = servers.get(cleanSid);
  if (!entry) return;
  await entry.vite.close();
  servers.delete(cleanSid);
  console.log(`[preview-dev] stopped: ${cleanSid}`);
  if (servers.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Stop all dev servers (e.g. on process exit). */
export async function stopAll() {
  const entries = [...servers.entries()];
  servers.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  await Promise.all(entries.map(([, entry]) => entry.vite.close()));
  if (entries.length > 0) console.log(`[preview-dev] stopped ${entries.length} server(s)`);
}

async function cleanupStale() {
  const now = Date.now();
  const stale = [...servers.entries()].filter(([, e]) => now - e.lastAccess > STALE_MS);
  for (const [sid] of stale) {
    console.log(`[preview-dev] cleaning stale: ${sid}`);
    await stopDevServer(sid);
  }
}

// Clean up on process exit
process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);

// ---------- Express middleware ----------

/**
 * Mount the dev preview middleware and API endpoint.
 * Must be registered BEFORE mountPreview() so the dev server intercepts
 * /preview/:sid before the static-file fallback from mountPreview().
 */
export function mountDevPreview(app) {
  // DEV endpoint: start a dev server for a work directory
  app.post('/api/preview/:sid/dev', async (req, res) => {
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
      const url = await startDevServer(sid, workDir);
      res.json({ ok: true, url });
    } catch (err) {
      console.error('[preview-dev] start failed:', err?.message || err);
      res.status(500).json({ error: `启动预览失败：${err?.message || '未知错误'}` });
    }
  });

  // DEV middleware: serve /preview/:sid through Vite if a dev server exists
  app.use('/preview/:sid', (req, res, next) => {
    // Only intercept GET/HEAD — let POST/etc fall through
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const sid = sanitizeRel(req.params.sid);
    const entry = servers.get(sid);
    if (!entry) return next();
    entry.lastAccess = Date.now();
    entry.vite.middlewares(req, res, next);
  });
}
