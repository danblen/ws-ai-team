import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../store/AppProvider';
import DirBrowserModal from './DirBrowserModal';
import { listProjects, createProject } from '../lib/api';
import type { RemoteProject } from '../lib/api';

// 「在服务器上选择工作目录」入口的授权邮箱。该功能可直接改动服务器上的
// 代码，存在被外部操纵服务器的风险，故临时仅限该管理员账号使用；其余账号
// 一律不渲染此入口（直接不进入 DOM，而非仅视觉隐藏）。
// 注意：这只是前端限制，真正的安全边界仍应由后端对相关接口做鉴权。
const DIR_SELECT_ALLOWED_EMAIL = 'siplgo@siplgo.xyz';

/**
 * 概览区的项目 / 工作目录选择入口。
 * - 云端模式：列出「我的项目」（后端注册表），可新建或选已有项目；选定后为本会话
 *   创建 Git worktree 分支并锁定，提供「合并到主干」按钮。
 * - 本地模式：选择任意工作目录，或从历史项目直接选取立即开发。
 */
export default function ProjectPicker() {
  const app = useApp();
  const s = app.current;
  const mode = app.envConfig.mode;

  // 已绑定云端注册表项目 → 云端锁定卡片。
  if (mode === 'remote' && s.projectId) {
    return <RemoteBoundCard />;
  }
  // 以「目录」方式绑定（本地模式，或云端模式选服务器目录）→ 工作树 / 直接开发卡片。
  if (s.projectRoot) {
    return <LocalBoundCard />;
  }
  // 兼容本地模式旧的直接选目录（仅 workDir）。
  if (mode === 'local' && s.workDir) {
    return <LocalBoundCard />;
  }

  // 未选定 → 展示选择器。
  if (mode === 'remote') return <RemotePicker />;
  if (mode === 'local') return <LocalPicker />;
  return null; // SSH 等模式不在此处理
}

// 云端模式下隐藏工作树的绝对路径前缀（含用户家目录与邮箱），仅以 workspace 展示相对部分。
function maskRemoteWorkDir(workDir: string): string {
  const m = workDir.match(/\/ai-team-output\/[^/]+\/(.*)$/);
  return m ? `workspace/${m[1]}` : workDir;
}

// ---------- 云端：已绑定项目卡片（锁定） ----------
function RemoteBoundCard() {
  const app = useApp();
  const s = app.current;
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merge = useCallback(async () => {
    setMerging(true);
    setError(null);
    try {
      await app.mergeSessionProject(s.id);
    } catch (e) {
      setError((e as Error).message || '合并失败');
    } finally {
      setMerging(false);
    }
  }, [app, s.id]);

  return (
    <section className="ov-card project-card">
      <h3>当前项目</h3>
      <div className="project-bound">
        <span className="project-bound-name">📦 {s.projectName || s.projectId}</span>
        <span className="project-lock" title="已锁定，本会话不可切换项目">🔒 已锁定</span>
      </div>
      {s.workDir && <p className="env-hint" title={maskRemoteWorkDir(s.workDir)}>工作树：{maskRemoteWorkDir(s.workDir)}</p>}
      {error && <p className="env-hint warn">{error}</p>}
      <div className="project-actions">
        {s.merged ? (
          <span className="project-merged">✔ 已合并到主干</span>
        ) : (
          <button className="btn-primary" onClick={merge} disabled={merging || app.running}>
            {merging ? '正在合并…' : '合并到主干'}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- 本地：已绑定项目卡片（Git 工作树） ----------
function LocalBoundCard() {
  const app = useApp();
  const s = app.current;
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merge = useCallback(async () => {
    setMerging(true);
    setError(null);
    try {
      await app.mergeLocalSession(s.id);
    } catch (e) {
      setError((e as Error).message || '合并失败');
    } finally {
      setMerging(false);
    }
  }, [app, s.id]);

  // 工作树已切出：workDir 与主干不同。
  const hasWorktree = Boolean(s.workDir && s.workDir !== s.projectRoot);
  const devMode = s.localDevMode || 'worktree';
  const direct = devMode === 'direct';

  return (
    <section className="ov-card project-card">
      <h3>当前项目</h3>
      <div className="project-bound">
        <span className="project-bound-name">📦 {s.projectName || s.projectRoot || s.workDir}</span>
      </div>
      {s.projectRoot && (
        <p className="env-hint" title={s.projectRoot}>主干：{s.projectRoot}</p>
      )}

      {/* 开发方式选择：分支 + 勾选 worktree，合为一体。仅在尚未切出工作树前可切换。 */}
      {!hasWorktree && (
        <div className="dev-mode-bar">
          <span className="dev-seg dev-seg-branch" title="基于该分支开发（勾选 worktree 时从此分支切出工作树）">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            main
          </span>
          <label
            className="dev-seg dev-seg-worktree"
            title="勾选：开始会话时从主干切出独立工作树，可合并回主干；不勾选：直接在当前分支开发"
          >
            <input
              type="checkbox"
              checked={!direct}
              disabled={app.running}
              onChange={(e) => app.setLocalDevMode(s.id, e.target.checked ? 'worktree' : 'direct')}
            />
            <span>worktree</span>
          </label>
        </div>
      )}

      {hasWorktree ? (
        <p className="project-path" title={s.workDir}>工作树：{s.workDir}</p>
      ) : direct ? (
        <p className="env-hint">将直接在当前分支开发，改动直接作用于主干。</p>
      ) : (
        <p className="env-hint">开始会话后将自动从主干切出一份 Git 工作树。</p>
      )}
      {error && <p className="env-hint warn">{error}</p>}

      {/* 仅工作树模式且已切出时提供合并。直接开发无需合并。 */}
      {!direct && (
        <div className="project-actions">
          {s.merged ? (
            <span className="project-merged">✔ 已合并到主干</span>
          ) : (
            <button
              className="btn-primary"
              onClick={merge}
              disabled={merging || app.running || !hasWorktree}
              title={hasWorktree ? '' : '尚未开始会话，无可合并的工作树'}
            >
              {merging ? '正在合并…' : '合并到主干'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- 云端：项目选择器 ----------
function RemotePicker() {
  const app = useApp();
  const s = app.current;
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirOpen, setDirOpen] = useState(false);
  const [dirName, setDirName] = useState('');

  const loggedIn = Boolean(app.authEmail);
  // 仅授权管理员账号可使用「选择服务器目录」入口（大小写不敏感）。
  const canSelectDir =
    (app.authEmail || '').trim().toLowerCase() === DIR_SELECT_ALLOWED_EMAIL;

  const refresh = useCallback(() => {
    if (!loggedIn) return;
    setLoading(true);
    setError(null);
    listProjects()
      .then(setProjects)
      .catch((e) => setError((e as Error).message || '读取项目失败'))
      .finally(() => setLoading(false));
  }, [loggedIn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const bind = useCallback(
    async (project: RemoteProject) => {
      setBusy(true);
      setError(null);
      try {
        await app.bindSessionProject(s.id, project);
      } catch (e) {
        setError((e as Error).message || '绑定项目失败');
      } finally {
        setBusy(false);
      }
    },
    [app, s.id],
  );

  const create = useCallback(async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(n);
      setName('');
      await app.bindSessionProject(s.id, project);
    } catch (e) {
      setError((e as Error).message || '新建项目失败');
    } finally {
      setBusy(false);
    }
  }, [app, name, s.id]);

  // 选择服务器上的一个目录作为工作目录（复用本地模式的绑定逻辑：
  // 记入项目、载入文件，Git 工作树在首次发送时切出，也可改为直接开发）。
  const bindDir = useCallback(
    async (dir: string) => {
      setBusy(true);
      setError(null);
      try {
        await app.bindLocalProject(s.id, dirName, dir);
        setDirName('');
      } catch (e) {
        setError((e as Error).message || '选择目录失败');
      } finally {
        setBusy(false);
      }
    },
    [app, dirName, s.id],
  );

  if (!loggedIn) {
    return (
      <section className="ov-card project-card">
        <h3>选择项目</h3>
        <p className="env-hint warn">云端模式需先登录。请点击右上角「登录 / 注册」后再选择或新建项目。</p>
      </section>
    );
  }

  return (
    <section className="ov-card project-card project-picker">
      <h3>选择项目</h3>
      <p className="env-hint">选择你已有的项目继续开发（将为本会话创建 Git 工作树分支），或新建一个项目。</p>

      <div className="project-new">
        <input
          className="env-input"
          placeholder="新项目名称"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              create();
            }
          }}
        />
        <button className="btn-primary" onClick={create} disabled={busy || !name.trim()}>
          新建并使用
        </button>
      </div>

      {error && <p className="env-hint warn">{error}</p>}

      <div className="project-list">
        {loading ? (
          <p className="env-hint">加载中…</p>
        ) : projects.length === 0 ? (
          <p className="env-hint">还没有项目，先在上方新建一个。</p>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              className="project-item"
              disabled={busy}
              onClick={() => bind(p)}
            >
              <span className="project-item-ico">📦</span>
              <span className="project-item-name">{p.name}</span>
              <span className="project-item-meta">继续开发 →</span>
            </button>
          ))
        )}
      </div>

      {canSelectDir && (
        <>
          <div className="project-list-label" style={{ marginTop: 14 }}>
            或在服务器上选择工作目录
          </div>
          <p className="env-hint">
            在当前应用所在服务器上浏览并选择一个 Git 仓库目录，像本地模式一样为本会话创建工作树（也可在下一步改为直接在当前分支开发）。
          </p>
          <div className="project-new">
            <input
              className="env-input"
              placeholder="项目名称（置空则取目录名）"
              value={dirName}
              disabled={busy}
              onChange={(e) => setDirName(e.target.value)}
            />
            <button className="btn-primary" onClick={() => setDirOpen(true)} disabled={busy}>
              {busy ? '处理中…' : '选择目录并使用'}
            </button>
          </div>

          {dirOpen && (
            <DirBrowserModal
              onPick={(dir) => {
                setDirOpen(false);
                bindDir(dir);
              }}
              onClose={() => setDirOpen(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

// ---------- 本地：目录 / 历史项目选择器 ----------
function LocalPicker() {
  const app = useApp();
  const s = app.current;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 历史项目：来自本地项目注册表，按名称展示。
  const history = app.localProjects;

  const bind = useCallback(
    async (projectName: string, repoDir: string) => {
      setBusy(true);
      setError(null);
      try {
        await app.bindLocalProject(s.id, projectName, repoDir);
        setName('');
      } catch (e) {
        setError((e as Error).message || '创建工作树失败');
      } finally {
        setBusy(false);
      }
    },
    [app, s.id],
  );

  const disabled = app.running || busy;

  return (
    <section className="ov-card project-card project-picker">
      <h3>选择项目</h3>
      <p className="env-hint">为项目起个名字并选择一个本地 Git 仓库目录开始开发（将为本会话创建独立工作树，可合并回主干），或从历史项目直接进入。</p>

      <div className="project-new">
        <input
          className="env-input"
          placeholder="项目名称（置空则取目录名）"
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn-primary" onClick={() => setOpen(true)} disabled={disabled}>
          {busy ? '正在创建工作树…' : '选择目录并使用'}
        </button>
      </div>

      {error && <p className="env-hint warn">{error}</p>}

      {history.length > 0 && (
        <div className="project-list">
          <div className="project-list-label">历史项目</div>
          {history.map((p) => (
            <button
              key={p.id}
              className="project-item"
              disabled={disabled}
              onClick={() => bind(p.name, p.workDir)}
            >
              <span className="project-item-ico">📦</span>
              <span className="project-item-name">{p.name}</span>
              <span className="project-item-meta" title={p.workDir}>{p.workDir}</span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <DirBrowserModal
          onPick={(dir) => {
            setOpen(false);
            bind(name, dir);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}
