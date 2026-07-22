import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { buildForPublish } from './preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 已发布站点的持久化目录（区别于短生命周期的 .previews）。
// 每个站点位于 .published/<id>/dist/，通过 /p/<id>/ 公开访问。
export const PUBLISHED_DIR = path.join(__dirname, '.published');
fs.mkdirSync(PUBLISHED_DIR, { recursive: true });

// 记录 sid → 发布站点信息，使「重新发布」复用同一 URL。
const REGISTRY_FILE = path.join(PUBLISHED_DIR, 'registry.json');

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg) {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  } catch (err) {
    console.error('[publish] 写入注册表失败:', err?.message || err);
  }
}

/** 归一化 id / sid，仅保留安全字符，杜绝路径穿越。 */
function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** 由标题生成便于识别的短 slug。 */
function slugify(title) {
  const slug = String(title || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'app';
}

/** 首次发布时生成「slug-随机后缀」形式的站点 id。 */
function genId(title) {
  return `${slugify(title)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 逐站点串行构建，避免并发写坏同一目录。
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/**
 * 挂载发布相关路由：
 * - POST /api/publish/:sid  构建并（重新）发布，返回 { id, url }（根相对 /p/<id>/）。
 * - GET  /api/publish/:sid  查询该会话是否已发布及其 URL。
 * - GET  /p/:id/*           公开静态服务已发布站点（不在 /api 鉴权网关内）。
 */
export function mountPublish(app) {
  app.post('/api/publish/:sid', async (req, res) => {
    const sid = safeId(req.params.sid);
    const { files, framework, title } = req.body || {};
    if (!sid) return res.status(400).json({ error: '缺少会话 id' });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '缺少 files 参数' });
    }

    const reg = readRegistry();
    const existing = reg[sid];
    const id = existing?.id || genId(title || sid);
    const destDir = path.join(PUBLISHED_DIR, id);
    const fw = framework === 'html' ? 'html' : 'react';

    try {
      await withLock(id, () => buildForPublish(destDir, files, fw));
      const now = Date.now();
      reg[sid] = {
        id,
        title: title || '',
        framework: fw,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      writeRegistry(reg);
      res.json({ ok: true, id, url: `/p/${id}/` });
    } catch (err) {
      console.error('[publish] 构建失败:', err?.message || err);
      res.status(500).json({ error: `发布失败：${err?.message || '未知错误'}` });
    }
  });

  app.get('/api/publish/:sid', (req, res) => {
    const sid = safeId(req.params.sid);
    const entry = readRegistry()[sid];
    if (!entry) return res.json({ ok: true, published: false });
    res.json({
      ok: true,
      published: true,
      id: entry.id,
      url: `/p/${entry.id}/`,
      updatedAt: entry.updatedAt,
    });
  });

  // 公开访问已发布站点。fallthrough:true → 找不到文件时交回后续（SPA fallback）。
  app.use('/p/:id', (req, res, next) => {
    const id = safeId(req.params.id);
    const distDir = path.join(PUBLISHED_DIR, id, 'dist');
    staticFor(distDir)(req, res, next);
  });
}

// 按目录缓存 express.static 处理器。
const staticCache = new Map();
function staticFor(dir) {
  let handler = staticCache.get(dir);
  if (!handler) {
    handler = express.static(dir, { index: 'index.html', fallthrough: true });
    staticCache.set(dir, handler);
  }
  return handler;
}
