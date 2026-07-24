import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { buildMessages } from './prompt.js';
import { mountPreview, writeFiles } from './preview.js';
import { mountDevPreview } from './preview-dev.js';
import { mountPublish } from './publish.js';
import { mountEnv } from './env.js';
import { mountProjects } from './projects.js';
import { mountAuth, authRequired, authFromRequest, checkConversationLimit, incrementConversationCount, getConversationCount, MAX_CONVERSATIONS_PER_USER } from './auth.js';

// override so values in .env win over any pre-existing shell env vars.
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = process.env.SERVER_PORT || 5110;
const API_TOKEN = process.env.API_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());

const app = express();

// CORS — allow multiple origins in production, or * for dev.
app.use(cors({
  origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS,
  credentials: !ALLOWED_ORIGINS.includes('*'),
}));
app.use(express.json({ limit: '100mb' }));

// Email/password auth routes (register / login / me). Mounted before the
// auth gate so they stay reachable without a token.
mountAuth(app);

// ----- Access auth middleware -----
// 当需要鉴权时（已有注册用户 / 设置了 API_TOKEN / AUTH_REQUIRED），
// 所有 /api/* 需携带有效会话令牌或匹配静态 API_TOKEN。
// 登录相关与健康检查端点始终豁免，供未登录时探测与登录。
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health') return next();
  if (!authRequired()) return next(); // 无用户且未配置 → 开放访问
  const header = req.headers.authorization || '';
  if (API_TOKEN && header === `Bearer ${API_TOKEN}`) return next();
  const payload = authFromRequest(req);
  if (payload) {
    req.user = payload;
    return next();
  }
  res.status(401).json({ error: '未授权 — 请先登录' });
});

// Multi-file project preview: build with Vite and serve at /preview/<sid>/.
// Dev-preview middleware must be registered first — it intercepts /preview/:sid
// for active dev servers before the static-file fallback in mountPreview().
mountDevPreview(app);
mountPreview(app);

// Publish: build a persistent, publicly shareable site served at /p/<id>/.
mountPublish(app);

// Execution environment: local CLI detection, SSH / Remote runners.
mountEnv(app);

// Per-user project registry + Git worktree lifecycle (remote mode projects).
mountProjects(app);

// Write generated files to a project directory on disk.
app.post('/api/write-project-files', (req, res) => {
  const { files, projectDir } = req.body || {};
  if (!Array.isArray(files) || files.length === 0 || !projectDir) {
    return res.status(400).json({ error: '缺少参数 files 或 projectDir' });
  }
  try {
    writeFiles(projectDir, files);
    res.json({ ok: true, path: projectDir });
  } catch (err) {
    res.status(500).json({ error: `写入文件失败: ${err.message}` });
  }
});

// --- Health probe ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, authRequired: authRequired() });
});

// --- 对话次数追踪 ---
// 前端在每次 send() 开始时调用，扣减一次对话配额。
// 所有执行路径（内置/CLI/远程/SSH）统一由此端点计数。
app.post('/api/conversation/start', (req, res) => {
  if (!checkConversationLimit(req, res)) return;
  incrementConversationCount(req.user?.email);
  const used = getConversationCount(req.user?.email);
  res.json({ ok: true, used, max: MAX_CONVERSATIONS_PER_USER });
});

/**
 * Shared helper: open an SSE stream to the browser and pipe an
 * OpenAI-compatible streaming chat completion through it.
 */
async function streamCompletion(res, messages, { apiKey, baseUrl, model }) {
  if (!apiKey) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: '请先配置 API Key' })}\n\n`);
    return res.end();
  }
  const cleanBase = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const cleanModel = model || 'gpt-4o-mini';
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  // Abort upstream only if the client disconnects before we finish. Listen on
  // `res` (not `req`) — req 'close' can fire as soon as the body is read.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const upstream = await fetch(`${cleanBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: cleanModel, stream: true, temperature: 0.7, messages }),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      send('error', { message: `上游模型服务返回 ${upstream.status}: ${text.slice(0, 500)}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) send('delta', { text: delta });
        } catch {
          // ignore malformed keep-alive lines
        }
      }
    }

    send('done', { ok: true });
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return; // client disconnected
    send('error', { message: err?.message || '生成过程中发生未知错误' });
    res.end();
  }
}

app.post('/api/chat', async (req, res) => {
  // 对话次数限制：仅做闸门检查（计数由 /api/conversation/start 统一管理，
  // 避免 builtin 模式下一次 send() 触发多次 /api/chat 导致重复计数）。
  if (!checkConversationLimit(req, res)) return;

  const { system, messages, apiKey, baseUrl, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 参数' });
  }

  const full = [];
  if (system && typeof system === 'string') full.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system')) {
      full.push({ role: m.role, content: String(m.content ?? '') });
    }
  }
  await streamCompletion(res, full, { apiKey, baseUrl, model });
});

/**
 * Legacy single-agent endpoint (kept for backward compatibility).
 * Body: { prompt: string, history: [{role, content}] }
 */
app.post('/api/generate', async (req, res) => {
  // 对话次数限制：仅做闸门检查（计数由 /api/conversation/start 统一管理）。
  if (!checkConversationLimit(req, res)) return;

  const { prompt, history, apiKey, baseUrl, model } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: '缺少 prompt 参数' });
  }
  await streamCompletion(res, buildMessages(history, prompt), { apiKey, baseUrl, model });
});

// --- Serve the built frontend in production ---
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`\n  Atoms Demo backend running: http://localhost:${PORT}`);
  console.log(`  Remote access: token=${API_TOKEN ? '已设置' : '未设置（开放）'} origins=${ALLOWED_ORIGINS.join(',')}\n`);
});
