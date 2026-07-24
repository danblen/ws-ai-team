import { execFile, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORKSPACES_DIR } from './env.js';
import { ensureAdminForSensitive } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '.data');
const REGISTRY_FILE = path.join(DATA_DIR, 'projects.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Git 提交统一使用的身份（避免宿主机未配置 user.name/email 导致提交失败）。
const GIT_IDENTITY = ['-c', 'user.email=aiteam@local', '-c', 'user.name=AI Team'];

/**
 * 将任意字符串规整为单层、安全的目录名，杜绝路径穿越与绝对路径。
 */
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_').trim();
}

/** 归一化 id / sid，仅保留安全字符。 */
function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** 由标题生成便于识别的短 slug。 */
function slugify(title) {
  const slug = String(title || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || 'project';
}

/** 生成「slug-随机后缀」形式的项目 id。 */
function genId(name) {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------- 注册表读写 ----------
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
    console.error('[projects] 写入注册表失败:', err?.message || err);
  }
}

/** 当前请求的用户归属键（未登录回退 _anon）。 */
function ownerKey(req) {
  return sanitizeName(req.user?.email) || '_anon';
}

// ---------- Git 封装 ----------
function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `git ${args.join(' ')} 失败: ${stderr || err.message}`;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

/** 主工作树目录：WORKSPACES_DIR/<owner>/<projectId>。 */
function projectDir(owner, id) {
  return path.join(WORKSPACES_DIR, owner, id);
}

/** 会话 worktree 目录：WORKSPACES_DIR/<owner>/.worktrees/<projectId>/<sid>。 */
function worktreeDir(owner, id, sid) {
  return path.join(WORKSPACES_DIR, owner, '.worktrees', id, sid);
}

function branchName(sid) {
  return `session-${safeId(sid)}`;
}

// ---------- 本地模式 Git 工作树（任意用户目录） ----------

/**
 * 本地项目的会话 worktree 目录：放在项目仓库内的 .aiteam-worktrees/<sid>，
 * 并写入 .git/info/exclude 避免在主工作树中显示为未跟踪文件。
 */
function localWorktreeDir(repoDir, sid) {
  return path.join(repoDir, '.aiteam-worktrees', safeId(sid));
}

/**
 * 确保目录是一个可开分支的 git 仓库：
 * - 非仓库则 git init；
 * - 无任何提交则把现有文件（或空提交）作为基提交；
 * - 把 worktree 存放目录加入 .git/info/exclude。
 */
async function ensureGitRepo(dir) {
  let isRepo = false;
  try {
    await git(dir, ['rev-parse', '--is-inside-work-tree']);
    isRepo = true;
  } catch { /* 非仓库 */ }
  if (!isRepo) {
    await git(dir, ['init']);
  }

  // 将 worktree 目录加入 info/exclude（幂等）。
  try {
    const excludeFile = path.join((await git(dir, ['rev-parse', '--git-dir'])), 'info', 'exclude');
    const abs = path.isAbsolute(excludeFile) ? excludeFile : path.join(dir, excludeFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let cur = '';
    try { cur = fs.readFileSync(abs, 'utf8'); } catch { /* 首次 */ }
    if (!cur.split('\n').includes('.aiteam-worktrees/')) {
      fs.appendFileSync(abs, `${cur.endsWith('\n') || cur === '' ? '' : '\n'}.aiteam-worktrees/\n`);
    }
  } catch { /* 忽略 exclude 写入失败 */ }

  // 确保至少有一个提交。
  let hasCommit = false;
  try {
    await git(dir, ['rev-parse', 'HEAD']);
    hasCommit = true;
  } catch { /* 无提交 */ }
  if (!hasCommit) {
    try {
      await git(dir, ['add', '-A']);
      await git(dir, [...GIT_IDENTITY, 'commit', '-m', 'init']);
    } catch {
      await git(dir, [...GIT_IDENTITY, 'commit', '--allow-empty', '-m', 'init']);
    }
  }
}

/**
 * 挂载项目相关路由：
 * - GET  /api/projects              列出当前用户的项目。
 * - POST /api/projects              新建项目（git init + 初始提交）。
 * - POST /api/projects/:id/checkout 为会话创建 worktree 分支。
 * - POST /api/projects/:id/merge    合并会话分支到主干并移除 worktree。
 */
export function mountProjects(app) {
  app.get('/api/projects', (req, res) => {
    const owner = ownerKey(req);
    const list = readRegistry()[owner] || [];
    res.json({ ok: true, projects: list });
  });

  app.post('/api/projects', async (req, res) => {
    const owner = ownerKey(req);
    // 允许不填项目名：置空时自动生成一个带时间戳的默认名，便于在项目列表中区分。
    const rawName = String(req.body?.name || '').trim();
    let name = rawName;
    if (!name) {
      const d = new Date();
      const ts = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      name = `未命名项目 ${ts}`;
    }

    const reg = readRegistry();
    const id = genId(name);
    const dir = projectDir(owner, id);

    try {
      fs.mkdirSync(dir, { recursive: true });
      await git(dir, ['init']);
      // 沙箱用户（sandbox-10000~10199）需要能读写 .git
      await git(dir, ['config', 'core.sharedRepository', 'true']);
      execSync(`chmod -R a+wX "${path.join(dir, '.git')}"`, { timeout: 10000 });
      // 初始空提交，保证有基提交可开分支。
      await git(dir, [...GIT_IDENTITY, 'commit', '--allow-empty', '-m', 'init']);

      const now = Date.now();
      const project = { id, name, workDir: dir, framework: 'react', createdAt: now, updatedAt: now, branches: {} };
      reg[owner] = [project, ...(reg[owner] || [])];
      writeRegistry(reg);
      res.json({ ok: true, project });
    } catch (err) {
      console.error('[projects] 新建失败:', err?.message || err);
      res.status(500).json({ error: `新建项目失败：${err?.message || '未知错误'}` });
    }
  });

  // 删除项目：移除项目目录、worktree 目录并从注册表中清除。
  app.delete('/api/projects/:id', async (req, res) => {
    const owner = ownerKey(req);
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ error: '缺少 id' });

    const reg = readRegistry();
    const list = reg[owner] || [];
    const idx = list.findIndex((p) => p.id === id);
    if (idx < 0) return res.status(404).json({ error: '项目不存在' });

    const dir = projectDir(owner, id);
    const wtsDir = path.join(WORKSPACES_DIR, owner, '.worktrees', id);

    try {
      // 删除项目主目录。
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      // 删除关联的 worktree 目录。
      if (fs.existsSync(wtsDir)) {
        fs.rmSync(wtsDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('[projects] 删除目录失败:', err?.message || err);
      // 目录删除失败仍继续清理注册表，避免注册表残留孤立条目。
    }

    list.splice(idx, 1);
    reg[owner] = list;
    writeRegistry(reg);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/checkout', async (req, res) => {
    const owner = ownerKey(req);
    const id = safeId(req.params.id);
    const sid = safeId(req.body?.sid);
    if (!id || !sid) return res.status(400).json({ error: '缺少 id 或 sid' });

    const reg = readRegistry();
    const list = reg[owner] || [];
    const project = list.find((p) => p.id === id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const dir = projectDir(owner, id);
    const wtDir = worktreeDir(owner, id, sid);
    const branch = branchName(sid);

    try {
      // 幂等：worktree 已存在（且是有效目录）直接返回。
      if (fs.existsSync(wtDir)) {
        return res.json({ ok: true, workDir: wtDir, branch });
      }
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });

      // 分支已存在则复用，否则新建。
      let branchExists = false;
      try {
        await git(dir, ['rev-parse', '--verify', branch]);
        branchExists = true;
      } catch { /* branch 不存在 */ }

      if (branchExists) {
        await git(dir, ['worktree', 'add', wtDir, branch]);
      } else {
        await git(dir, ['worktree', 'add', '-b', branch, wtDir]);
      }

      project.branches = { ...(project.branches || {}), [sid]: branch };
      project.updatedAt = Date.now();
      writeRegistry(reg);
      res.json({ ok: true, workDir: wtDir, branch });
    } catch (err) {
      console.error('[projects] checkout 失败:', err?.message || err);
      res.status(500).json({ error: `创建工作树失败：${err?.message || '未知错误'}` });
    }
  });

  app.post('/api/projects/:id/merge', async (req, res) => {
    const owner = ownerKey(req);
    const id = safeId(req.params.id);
    const sid = safeId(req.body?.sid);
    if (!id || !sid) return res.status(400).json({ error: '缺少 id 或 sid' });

    const reg = readRegistry();
    const list = reg[owner] || [];
    const project = list.find((p) => p.id === id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const dir = projectDir(owner, id);
    const wtDir = worktreeDir(owner, id, sid);
    const branch = branchName(sid);

    try {
      // 提取主干最新变更（若有远端则同步，无远端则跳过）。
      try {
        await git(dir, ['pull', '--no-rebase']);
      } catch { /* 无远端或拉取失败则忽略 */ }

      // 提交 worktree 内的改动（若无改动用空提交兜底以推进合并）。
      if (fs.existsSync(wtDir)) {
        await git(wtDir, ['add', '-A']);
        try {
          await git(wtDir, [...GIT_IDENTITY, 'commit', '-m', `session ${sid}`]);
        } catch {
          // 无改动可提交时忽略。
        }
      }

      // 合并会话分支到主干。
      await git(dir, [...GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge session ${sid}`, branch]);

      // 推送合并结果到远端（若有远端则推送，无远端则跳过）。
      try {
        await git(dir, ['push']);
      } catch { /* 无远端或推送失败则忽略 */ }

      // 移除 worktree。
      try {
        await git(dir, ['worktree', 'remove', '--force', wtDir]);
      } catch { /* worktree 可能已被清理 */ }

      if (project.branches) delete project.branches[sid];
      project.updatedAt = Date.now();
      writeRegistry(reg);
      res.json({ ok: true });
    } catch (err) {
      console.error('[projects] merge 失败:', err?.message || err);
      res.status(500).json({ error: `合并到主干失败：${err?.message || '未知错误'}` });
    }
  });

  // ---- 本地模式：对任意本地仓库目录创建/合并 worktree 分支 ----

  app.post('/api/local-git/checkout', async (req, res) => {
    // 对任意本地目录建工作树属高危操作，云端仅管理员可用。
    if (!ensureAdminForSensitive(req, res)) return;
    const dir = String(req.body?.dir || '').trim();
    const sid = safeId(req.body?.sid);
    if (!dir || !sid) return res.status(400).json({ error: '缺少 dir 或 sid' });

    const repoDir = path.resolve(dir);
    if (!fs.existsSync(repoDir)) return res.status(400).json({ error: '目录不存在' });

    const wtDir = localWorktreeDir(repoDir, sid);
    const branch = branchName(sid);

    try {
      await ensureGitRepo(repoDir);

      // 幂等：worktree 已存在则直接返回。
      if (fs.existsSync(wtDir)) {
        return res.json({ ok: true, workDir: wtDir, branch });
      }
      fs.mkdirSync(path.dirname(wtDir), { recursive: true });

      let branchExists = false;
      try {
        await git(repoDir, ['rev-parse', '--verify', branch]);
        branchExists = true;
      } catch { /* branch 不存在 */ }

      if (branchExists) {
        await git(repoDir, ['worktree', 'add', wtDir, branch]);
      } else {
        await git(repoDir, ['worktree', 'add', '-b', branch, wtDir]);
      }

      res.json({ ok: true, workDir: wtDir, branch });
    } catch (err) {
      console.error('[local-git] checkout 失败:', err?.message || err);
      res.status(500).json({ error: `创建工作树失败：${err?.message || '未知错误'}` });
    }
  });

  app.post('/api/local-git/merge', async (req, res) => {
    // 对任意本地目录合并工作树属高危操作，云端仅管理员可用。
    if (!ensureAdminForSensitive(req, res)) return;
    const dir = String(req.body?.dir || '').trim();
    const sid = safeId(req.body?.sid);
    if (!dir || !sid) return res.status(400).json({ error: '缺少 dir 或 sid' });

    const repoDir = path.resolve(dir);
    const wtDir = localWorktreeDir(repoDir, sid);
    const branch = branchName(sid);

    try {
      // 提取主干最新变更（若有远端则同步，无远端则跳过）。
      try {
        await git(repoDir, ['pull', '--no-rebase']);
      } catch { /* 无远端或拉取失败则忽略 */ }

      // 提交 worktree 内的改动（无改动则忽略）。
      if (fs.existsSync(wtDir)) {
        await git(wtDir, ['add', '-A']);
        try {
          await git(wtDir, [...GIT_IDENTITY, 'commit', '-m', `session ${sid}`]);
        } catch { /* 无改动可提交 */ }
      }

      // 合并会话分支到主干（当前主仓库所在分支）。
      await git(repoDir, [...GIT_IDENTITY, 'merge', '--no-ff', '-m', `merge session ${sid}`, branch]);

      // 推送合并结果到远端（若有远端则推送，无远端则跳过）。
      try {
        await git(repoDir, ['push']);
      } catch { /* 无远端或推送失败则忽略 */ }

      // 移除 worktree。
      try {
        await git(repoDir, ['worktree', 'remove', '--force', wtDir]);
      } catch { /* worktree 可能已被清理 */ }

      res.json({ ok: true });
    } catch (err) {
      console.error('[local-git] merge 失败:', err?.message || err);
      res.status(500).json({ error: `合并到主干失败：${err?.message || '未知错误'}` });
    }
  });
}
