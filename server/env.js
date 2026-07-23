import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runCLI, scanWorkspace } from './cli.js';
import { startDevServer } from './preview-dev.js';
import { runSSHAndSync, testSSH } from './ssh.js';
import { ensureAdminForSensitive } from './auth.js';

// 本机可被探测到的 CLI Agent 清单。
const KNOWN_CLIS = [
  { id: 'claude', name: 'Claude Code CLI', bin: 'claude' },
  { id: 'opencode', name: 'OpenCode CLI', bin: 'opencode', fallbackPaths: ['/Volumes/z/app/opencode/opencode.sh'] },
  { id: 'aider', name: 'Aider', bin: 'aider' },
];

/**
 * Each CLI-run session gets its own workspace directory.
 * 必须位于应用仓库之外：否则 CLI（如 OpenCode）向上探测项目根时会读到
 * ai-team3 自身源码。放到用户家目录下的 ~/.ai-team/workspaces。
 */
export const WORKSPACES_DIR = path.join(os.homedir(), 'ws', 'ai-team-output');
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

/**
 * 将任意字符串规整为单层、安全的目录名，杜绝路径穿越与绝对路径。
 */
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_').trim();
}

/**
 * 解析出「本次任务实际工作的项目目录」：
 *   <配置的工作根目录>/<项目名>
 *   或（未配置工作根目录时）
 *   ~/ws/ai-team-output/<邮箱>/<项目名>
 * - base 用 path.resolve 处理，确保绝对路径不会被当作相对路径拼接；
 * - 未配置根目录时回退到仓库外的 WORKSPACES_DIR（~/ws/ai-team-output）；
 * - 未提供项目名时用 sid 兜底；
 * - direct===true 且有 reqWorkDir 时，直接以该目录为项目根（不拼项目名）。
 */
function resolveProjectDir(reqWorkDir, projectName, sid, email, direct) {
  if (direct && reqWorkDir) return path.resolve(reqWorkDir);
  let base = reqWorkDir ? path.resolve(reqWorkDir) : WORKSPACES_DIR;
  if (!reqWorkDir && email) {
    base = path.join(WORKSPACES_DIR, sanitizeName(email));
  }
  const name = sanitizeName(projectName) || sid;
  return path.join(base, name);
}

/**
 * 判断 child 是否位于 parent 目录内（含 parent 本身）。
 * 用于区分「受管理的工作区（WORKSPACES_DIR 下，注册项目/默认工作区，所有
 * 登录用户可用）」与「任意外部目录（高危，仅管理员可用）」。
 */
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function which(bin) {
  return new Promise((resolve) => {
    execFile('which', [bin], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const p = stdout.trim().split('\n')[0];
      resolve(p || null);
    });
  });
}

/**
 * SSE helper: send an event to the client.
 */
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 挂载执行环境相关路由。
 */
export function mountEnv(app) {
  // ------ Agent detection ------

  app.get('/api/env/agents', async (req, res) => {
    const mode = req.query.mode || 'local';
    const agents = [];

    if (mode === 'local') {
      agents.push({ id: 'builtin', name: '内置智能体团队', kind: 'builtin' });
      const found = await Promise.all(
        KNOWN_CLIS.map(async (c) => {
          let p = await which(c.bin);
          // which 找不到时尝试 fallback 路径（alias 等情况）
          if (!p && c.fallbackPaths) {
            for (const fp of c.fallbackPaths) {
              try {
                await fs.promises.access(fp, fs.constants.X_OK);
                p = fp;
                break;
              } catch { /* continue */ }
            }
          }
          return p ? { id: c.id, name: c.name, kind: 'cli', path: p } : null;
        }),
      );
      for (const f of found) if (f) agents.push(f);
    }

    res.json({ ok: true, mode, agents });
  });

  // ------ Local CLI run (SSE stream) ------

  app.post('/api/env/local/run', async (req, res) => {
    const { task, cliId, sid, workDir: reqWorkDir, projectName, direct } = req.body || {};
    if (!task || !cliId || !sid) {
      return res.status(400).json({ error: '缺少参数: task, cliId, sid' });
    }

    // 在「工作根目录/项目名」子目录中执行；若 direct 则直接以选定目录为项目根。
    const workDir = resolveProjectDir(reqWorkDir, projectName, sid, req.user?.email, direct);
    // 工作目录走出受管理的 WORKSPACES_DIR（即任意外部目录）时，云端仅管理员可在其中跑 CLI。
    if (!isWithin(WORKSPACES_DIR, workDir) && !ensureAdminForSensitive(req, res)) return;
    fs.mkdirSync(workDir, { recursive: true });

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // If client disconnects, abort the CLI child.
    const abortController = new AbortController();
    const onClose = () => { if (!res.writableEnded) abortController.abort(); };
    res.on('close', onClose);

    let hasError = false;

    try {
      sendSSE(res, 'status', { text: `正在 ${workDir} 中用 ${cliId} 执行任务…` });

      const exitCode = await runCLI(cliId, task, workDir, {
        onDelta: (text) => sendSSE(res, 'delta', { text }),
        onStatus: (text) => sendSSE(res, 'status', { text }),
        signal: abortController.signal,
      });

      if (exitCode !== 0) {
        sendSSE(res, 'error', { text: `CLI 退出，代码: ${exitCode}` });
        hasError = true;
        return res.end();
      }

      // Scan workspace for files
      const files = scanWorkspace(workDir);
      sendSSE(res, 'status', { text: `扫描到 ${files.length} 个文件` });

      // Build preview
      let previewUrl = null;
      if (files.length > 0) {
        try {
          previewUrl = await startDevServer(sid, workDir);
          sendSSE(res, 'status', { text: '预览已就绪' });
        } catch (err) {
          sendSSE(res, 'status', { text: `启动预览: ${err.message}` });
        }
      }

      sendSSE(res, 'done', { files, previewUrl, workDir });
    } catch (err) {
      if (abortController.signal.aborted) {
        sendSSE(res, 'status', { text: 'CLI 执行被用户中止' });
      } else {
        sendSSE(res, 'error', { text: err.message || 'CLI 执行失败' });
      }
    } finally {
      if (!res.writableEnded) res.end();
      res.off('close', onClose);
    }
  });

  // ------ Read files from a session's workspace ------

  app.get('/api/env/local/files', (req, res) => {
    const sid = req.query.sid;
    const reqWorkDir = req.query.workDir;
    const projectName = req.query.projectName;
    const direct = req.query.direct === '1' || req.query.direct === 'true';
    if (!sid) return res.status(400).json({ error: '缺少 ?sid=' });

    const workDir = resolveProjectDir(reqWorkDir, projectName, sid, req.user?.email, direct);
    // 读取任意外部目录同属高危，云端仅管理员可读。
    if (!isWithin(WORKSPACES_DIR, workDir) && !ensureAdminForSensitive(req, res)) return;
    if (!fs.existsSync(workDir)) return res.json({ ok: true, files: [] });

    try {
      const files = scanWorkspace(workDir);
      res.json({ ok: true, files });
    } catch (err) {
      res.status(500).json({ error: `读取工作目录失败: ${err.message}` });
    }
  });

  // ------ Browse local directories (for the per-session workspace picker) ------

  app.get('/api/env/local/dirs', (req, res) => {
    // 浏览服务器任意目录属高危操作，云端仅管理员可用。
    if (!ensureAdminForSensitive(req, res)) return;
    const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    const dir = raw ? path.resolve(raw) : os.homedir();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return res.status(400).json({ error: `无法读取目录: ${err.message}` });
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .filter((e) => e.name !== 'node_modules' && e.name !== 'dist')
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    res.json({ ok: true, path: dir, parent: parent === dir ? null : parent, dirs });
  });

  // ------ SSH: test connection ------

  app.post('/api/env/ssh/test', async (req, res) => {
    const sshConfig = req.body;
    if (!sshConfig?.host || !sshConfig?.username) {
      return res.status(400).json({ error: '缺少 SSH 连接参数: host, username' });
    }
    const result = await testSSH(sshConfig);
    res.json(result);
  });

  // ------ SSH: run CLI on remote host (SSE stream) ------

  app.post('/api/env/ssh/run', async (req, res) => {
    const { ssh, task, cliId, sid, remoteWorkDir } = req.body || {};
    if (!task || !cliId || !sid || !ssh?.host) {
      return res.status(400).json({
        error: '缺少参数: task, cliId, sid, ssh.host',
      });
    }

    const localWorkDir = path.join(WORKSPACES_DIR, sid);
    fs.mkdirSync(localWorkDir, { recursive: true });

    // SSE setup
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // If client disconnects, abort the SSH operation.
    const abortController = new AbortController();
    const onClose = () => { if (!res.writableEnded) abortController.abort(); };
    res.on('close', onClose);

    const workDir = remoteWorkDir || `~/ai-team-workspace/${sid}`;

    try {
      sendSSE(res, 'status', { text: `正在通过 SSH 连接 ${ssh.host}:${ssh.port || 22}…` });

      const files = await runSSHAndSync(ssh, cliId, task, workDir, localWorkDir, {
        onDelta: (text) => sendSSE(res, 'delta', { text }),
        onStatus: (text) => sendSSE(res, 'status', { text }),
        signal: abortController.signal,
      });

      sendSSE(res, 'status', { text: `同步到 ${files.length} 个文件` });

      // Build preview
      let previewUrl = null;
      if (files.length > 0) {
        try {
          previewUrl = await startDevServer(sid, localWorkDir);
          sendSSE(res, 'status', { text: '预览已就绪' });
        } catch (err) {
          sendSSE(res, 'status', { text: `启动预览: ${err.message}` });
        }
      }

      sendSSE(res, 'done', { files, previewUrl });
    } catch (err) {
      if (abortController.signal.aborted) {
        sendSSE(res, 'status', { text: 'SSH 执行被用户中止' });
      } else {
        sendSSE(res, 'error', { text: err.message || 'SSH 执行失败' });
      }
    } finally {
      if (!res.writableEnded) res.end();
      res.off('close', onClose);
    }
  });
}
