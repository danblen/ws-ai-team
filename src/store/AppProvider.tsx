import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  AgentRole,
  ChatMessage,
  Framework,
  LiveTurn,
  LogEntry,
  LogLevel,
  ProjectFile,
  Session,
} from '../lib/types';
import {
  createSession,
  loadAgents,
  loadCurrentId,
  loadEnvConfig,
  loadLocalProjects,
  loadSessions,
  projectDirName,
  saveAgents,
  saveCurrentId,
  saveEnvConfig,
  saveLocalProjects,
  saveSessions,
  uid,
} from '../lib/storage';
import type { LocalProject } from '../lib/storage';
import { DEFAULT_AGENTS } from '../lib/agents';
import type { EnvironmentConfig } from '../lib/env/types';
import { createEnvironment } from '../lib/env';
import type { RemoteProject } from '../lib/api';
import { runCrew, parseEngineerOutput } from '../lib/orchestrator';
import type { RunMode } from '../lib/orchestrator';
import {
  BASE_PREFIX,
  buildPreview,
  setApiConfig,
  clearApiConfig,
  writeProjectFiles,
  readLocalDirFiles,
  checkoutProject,
  mergeProject,
  checkoutLocalProject,
  mergeLocalProject,
  getAuthToken,
  login as apiLogin,
  register as apiRegister,
  fetchMe,
  setAuthToken,
  clearAuthToken,
} from '../lib/api';

export type WorkTab = 'overview' | 'preview' | 'code' | 'cloud' | 'files' | 'terminal' | 'publish' | 'team';

/** 一条排队中的待执行消息。 */
export interface QueueItem {
  id: string;
  text: string;
  mode: RunMode;
}

/** Per-session run state so multiple sessions can run concurrently. */
interface RunState {
  running: boolean;
  building: boolean;
  live: LiveTurn | null;
  liveFiles: ProjectFile[];
  error: string | null;
}

const IDLE: RunState = { running: false, building: false, live: null, liveFiles: [], error: null };

interface AppState {
  sessions: Session[];
  current: Session;
  agents: AgentRole[];
  envConfig: EnvironmentConfig;
  // current session's run state (derived)
  live: LiveTurn | null;
  liveFiles: ProjectFile[];
  running: boolean;
  building: boolean;
  error: string | null;
  activeTab: WorkTab;
  isRunning: (id: string) => boolean;
  // session actions
  newSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  // agent actions
  updateAgents: (agents: AgentRole[]) => void;
  resetAgents: () => void;
  // environment
  setEnvConfig: (config: EnvironmentConfig) => void;
  /** 设置/清除本会话选定的本地工作目录（传 null 清除）。 */
  setSessionWorkDir: (id: string, dir: string | null) => void;
  /** 远程模式：为会话绑定一个项目（checkout worktree 分支并锁定）。 */
  bindSessionProject: (id: string, project: RemoteProject) => Promise<void>;
  /** 远程模式：把当前会话分支合并到主干。 */
  mergeSessionProject: (id: string) => Promise<void>;
  /** 本地模式：已记录的历史项目（按名称）。 */
  localProjects: LocalProject[];
  /** 本地模式：为会话绑定一个本地项目（名称 + 仓库目录），创建 Git worktree 并记入注册表。 */
  bindLocalProject: (id: string, name: string, repoDir: string) => Promise<void>;
  /** 本地模式：设置开发方式（新建工作树 / 直接在当前分支）。仅在切出工作树前可切换。 */
  setLocalDevMode: (id: string, mode: 'worktree' | 'direct') => void;
  /** 本地模式：把当前会话的 worktree 分支合并回项目主干。 */
  mergeLocalSession: (id: string) => Promise<void>;
  // auth (公共登录/注册，与执行环境无关)
  authEmail: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  // run actions
  send: (text: string, mode?: RunMode) => void;
  /** 当前会话的待执行消息队列（运行中提交的消息会入队，依次自动执行）。 */
  queue: QueueItem[];
  /** 将一条消息加入当前会话的执行队列。 */
  enqueue: (text: string, mode: RunMode) => void;
  /** 从队列中移除一条待执行消息。 */
  removeQueued: (itemId: string) => void;
  /** 用当前会话的代码立即构建并预览（无需等待对话完成）。 */
  previewNow: () => Promise<void>;
  stop: () => void;
  setActiveTab: (tab: WorkTab) => void;
  clearError: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

/** Condense prior conversation so follow-up turns continue the same project. */
function condenseHistory(messages: ChatMessage[]): string {
  const recent = messages.slice(-8);
  return recent
    .map((m) => {
      if (m.kind === 'user') return `用户：${clip(m.content, 400)}`;
      if (m.kind === 'agent') return `${m.agentName || '智能体'}：${clip(stripFences(m.content), 300)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripFences(raw: string): string {
  const i = raw.indexOf('```');
  return i >= 0 ? raw.slice(0, i).trim() : raw.trim();
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

// 若本应用被嵌入 iframe（例如预览页），绝不写 localStorage，
// 以免同源的第二份副本覆盖父窗口的会话数据。
const IS_EMBEDDED =
  typeof window !== 'undefined' &&
  (window.top !== window.self || window.location.pathname.includes('/preview/'));

export function AppProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<Session[]>(() => {
    const loaded = loadSessions();
    return loaded.length ? loaded : [createSession()];
  });
  const [currentId, setCurrentId] = useState<string>(() => loadCurrentId() || '');
  const [agents, setAgents] = useState<AgentRole[]>(() => loadAgents());
  const [envConfig, setEnvConfigState] = useState<EnvironmentConfig>(() => loadEnvConfig());
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [activeTab, setActiveTab] = useState<WorkTab>('overview');
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [localProjects, setLocalProjects] = useState<LocalProject[]>(() => loadLocalProjects());
  // 每个会话的待执行消息队列。
  const [queues, setQueues] = useState<Record<string, QueueItem[]>>({});

  const abortRefs = useRef<Record<string, AbortController>>({});
  const liveContentRefs = useRef<Record<string, string>>({});
  const codeAgentRefs = useRef<Record<string, boolean>>({});
  const currentIdRef = useRef<string>('');

  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) || sessions[0],
    [sessions, currentId],
  );

  useEffect(() => {
    if (current && current.id !== currentId) setCurrentId(current.id);
  }, [current, currentId]);

  useEffect(() => {
    currentIdRef.current = current?.id || '';
  }, [current]);

  useEffect(() => {
    if (!IS_EMBEDDED) saveSessions(sessions);
  }, [sessions]);
  useEffect(() => {
    if (!IS_EMBEDDED) saveAgents(agents);
  }, [agents]);
  useEffect(() => {
    if (!IS_EMBEDDED) saveEnvConfig(envConfig);
  }, [envConfig]);
  useEffect(() => {
    if (!IS_EMBEDDED) saveLocalProjects(localProjects);
  }, [localProjects]);
  useEffect(() => {
    if (currentId && !IS_EMBEDDED) saveCurrentId(currentId);
  }, [currentId]);

  // Remote mode: redirect all /api/* calls to the remote instance.
  useEffect(() => {
    if (envConfig.mode === 'remote' && envConfig.remote.url) {
      setApiConfig(envConfig.remote.url, envConfig.remote.token || getAuthToken());
    } else {
      clearApiConfig();
    }
  }, [envConfig]);

  // 启动时校验已持久化的会话令牌，恢复登录态（打到当前站点）。
  useEffect(() => {
    if (!getAuthToken()) return;
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (!cancelled) setAuthEmail(me.email);
      })
      .catch(() => {
        if (!cancelled) setAuthEmail(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 公共登录/注册/登出（始终打到当前站点）。
  const login = useCallback(async (email: string, password: string) => {
    const res = await apiLogin(email, password);
    setAuthToken(res.token);
    setAuthEmail(res.email);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const res = await apiRegister(email, password);
    setAuthToken(res.token);
    setAuthEmail(res.email);
  }, []);

  const logout = useCallback(() => {
    clearAuthToken();
    setAuthEmail(null);
  }, []);

  const run = runs[current?.id] || IDLE;

  const setRun = useCallback((id: string, patch: Partial<RunState>) => {
    setRuns((prev) => ({ ...prev, [id]: { ...(prev[id] || IDLE), ...patch } }));
  }, []);

  const patchCurrent = useCallback((id: string, fn: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }, []);

  const appendMessage = useCallback(
    (id: string, msg: ChatMessage) => {
      patchCurrent(id, (s) => ({ ...s, messages: [...s.messages, msg], updatedAt: Date.now() }));
    },
    [patchCurrent],
  );

  const appendLog = useCallback(
    (id: string, level: LogLevel, text: string) => {
      const entry: LogEntry = { id: uid('log'), time: Date.now(), level, text };
      patchCurrent(id, (s) => ({ ...s, logs: [...s.logs, entry] }));
    },
    [patchCurrent],
  );

  const newSession = useCallback(() => {
    const s = createSession();
    setSessions((prev) => [s, ...prev]);
    setCurrentId(s.id);
    setActiveTab('overview');
  }, []);

  const switchSession = useCallback((id: string) => {
    setCurrentId(id);
    setActiveTab('overview');
  }, []);

  const deleteSession = useCallback(
    (id: string) => {
      abortRefs.current[id]?.abort();
      delete abortRefs.current[id];
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        const result = next.length ? next : [createSession()];
        if (id === currentId) setCurrentId(result[0].id);
        return result;
      });
    },
    [currentId],
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      patchCurrent(id, (s) => ({ ...s, title: title.trim() || s.title }));
    },
    [patchCurrent],
  );

  const updateAgents = useCallback((next: AgentRole[]) => setAgents(next), []);
  const resetAgents = useCallback(() => setAgents(DEFAULT_AGENTS.map((a) => ({ ...a }))), []);
  const setEnvConfig = useCallback((config: EnvironmentConfig) => setEnvConfigState(config), []);

  const setSessionWorkDir = useCallback(
    (id: string, dir: string | null) => {
      const workDir = dir?.trim() || undefined;
      patchCurrent(id, (s) => ({ ...s, workDir, updatedAt: Date.now() }));
      if (!workDir) {
        appendLog(id, 'info', '已清除本会话工作目录，后续任务将自动创建项目目录');
        return;
      }
      appendLog(id, 'info', `已选定工作目录：${workDir}`);
      // 选定后立即载入该目录文件，让代码区直接“打开”它。
      (async () => {
        try {
          const files = await readLocalDirFiles(id, workDir);
          if (files.length > 0) {
            const hasRootHtml = files.some((f) => /^index\.html$/i.test(f.path));
            const hasJsx = files.some((f) => /\.(jsx|tsx)$/i.test(f.path));
            const framework: Framework = hasRootHtml && !hasJsx ? 'html' : 'react';
            patchCurrent(id, (s) => ({ ...s, files, framework, updatedAt: Date.now() }));
            appendLog(id, 'ok', `✔ 已载入目录中的 ${files.length} 个文件`);
          } else {
            patchCurrent(id, (s) => ({ ...s, files: [], updatedAt: Date.now() }));
            appendLog(id, 'info', '该目录暂无可展示的文件');
          }
          if (id === currentIdRef.current) setActiveTab('code');
        } catch (err) {
          appendLog(id, 'error', (err as Error).message || '载入目录文件失败');
        }
      })();
    },
    [appendLog, patchCurrent],
  );

  const bindSessionProject = useCallback(
    async (id: string, project: RemoteProject) => {
      appendLog(id, 'info', `正在为项目「${project.name}」创建工作树…`);
      try {
        const { workDir, branch } = await checkoutProject(project.id, id);
        patchCurrent(id, (s) => ({
          ...s,
          projectId: project.id,
          projectName: project.name,
          workDir,
          projectLocked: true,
          merged: false,
          updatedAt: Date.now(),
        }));
        appendLog(id, 'ok', `✔ 已绑定项目「${project.name}」，分支 ${branch}`);
        // 载入 worktree 目录现有文件，让代码区直接“打开”它。
        const files = await readLocalDirFiles(id, workDir);
        if (files.length > 0) {
          const hasRootHtml = files.some((f) => /^index\.html$/i.test(f.path));
          const hasJsx = files.some((f) => /\.(jsx|tsx)$/i.test(f.path));
          const framework: Framework = hasRootHtml && !hasJsx ? 'html' : 'react';
          patchCurrent(id, (s) => ({ ...s, files, framework, updatedAt: Date.now() }));
          appendLog(id, 'ok', `✔ 已载入项目中的 ${files.length} 个文件`);
          if (id === currentIdRef.current) setActiveTab('code');
        }
      } catch (err) {
        appendLog(id, 'error', (err as Error).message || '绑定项目失败');
        throw err;
      }
    },
    [appendLog, patchCurrent],
  );

  const mergeSessionProject = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session?.projectId) {
        appendLog(id, 'error', '本会话未绑定项目，无法合并');
        return;
      }
      appendLog(id, 'info', '正在合并到主干…');
      try {
        await mergeProject(session.projectId, id);
        patchCurrent(id, (s) => ({ ...s, merged: true, updatedAt: Date.now() }));
        appendLog(id, 'ok', '✔ 已合并到主干');
      } catch (err) {
        appendLog(id, 'error', (err as Error).message || '合并失败');
        throw err;
      }
    },
    [appendLog, patchCurrent, sessions],
  );

  // 本地模式：为会话绑定一个本地项目（名称 + 仓库主干目录）。
  // 仅记入注册表并载入该目录代码；Git 工作树在会话开始（首次发送）时才切出。
  const bindLocalProject = useCallback(
    async (id: string, name: string, repoDir: string) => {
      const dir = repoDir.trim();
      if (!dir) return;
      const finalName = name.trim() || dir.split('/').filter(Boolean).pop() || dir;
      const now = Date.now();
      // 记入/更新本地项目注册表（以仓库主干目录为键）。
      setLocalProjects((prev) => {
        const idx = prev.findIndex((p) => p.workDir === dir);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], name: finalName, updatedAt: now };
          // 置顶最近使用。
          const [item] = next.splice(idx, 1);
          return [item, ...next];
        }
        return [
          { id: uid('lp'), name: finalName, workDir: dir, createdAt: now, updatedAt: now },
          ...prev,
        ];
      });

      // 选定即绑定：以仓库目录作为主干展示其代码，workDir 暂等于主干（尚无工作树）。
      // 默认采用「新建工作树」开发方式，可在概览卡片切换为「直接在当前分支」。
      patchCurrent(id, (s) => ({
        ...s,
        projectName: finalName,
        projectRoot: dir,
        workDir: dir,
        projectLocked: true,
        localDevMode: s.localDevMode || 'worktree',
        merged: false,
        updatedAt: Date.now(),
      }));
      appendLog(id, 'info', `已选择项目「${finalName}」：${dir}`);
      try {
        // 载入目录现有文件（可在代码区浏览/选中），但不主动切换页面，保持在当前页。
        const files = await readLocalDirFiles(id, dir);
        if (files.length > 0) {
          const hasRootHtml = files.some((f) => /^index\.html$/i.test(f.path));
          const hasJsx = files.some((f) => /\.(jsx|tsx)$/i.test(f.path));
          const framework: Framework = hasRootHtml && !hasJsx ? 'html' : 'react';
          patchCurrent(id, (s) => ({ ...s, files, framework, updatedAt: Date.now() }));
          appendLog(id, 'ok', `✔ 已载入项目中的 ${files.length} 个文件`);
        }
      } catch (err) {
        appendLog(id, 'error', (err as Error).message || '读取项目文件失败');
      }
    },
    [appendLog, patchCurrent],
  );

  // 本地模式：切换开发方式（仅在尚未切出工作树时允许）。
  const setLocalDevMode = useCallback(
    (id: string, mode: 'worktree' | 'direct') => {
      patchCurrent(id, (s) => {
        // 已切出工作树（workDir 与主干不同）后不再允许切换，避免状态混乱。
        if (s.workDir && s.projectRoot && s.workDir !== s.projectRoot) return s;
        return { ...s, localDevMode: mode, updatedAt: Date.now() };
      });
    },
    [patchCurrent],
  );

  // 本地模式：把当前会话的 worktree 分支合并回项目主干。
  const mergeLocalSession = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (!session?.projectRoot) {
        appendLog(id, 'error', '本会话未绑定本地项目，无法合并');
        return;
      }
      appendLog(id, 'info', '正在合并到主干…');
      try {
        await mergeLocalProject(session.projectRoot, id);
        // 合并后移除了工作树：workDir 回退到主干，下次发送会重新切出新工作树。
        patchCurrent(id, (s) => ({
          ...s,
          merged: true,
          workDir: s.projectRoot || s.workDir,
          updatedAt: Date.now(),
        }));
        appendLog(id, 'ok', '✔ 已合并到主干');
      } catch (err) {
        appendLog(id, 'error', (err as Error).message || '合并失败');
        throw err;
      }
    },
    [appendLog, patchCurrent, sessions],
  );

  const stop = useCallback(() => {
    const id = currentIdRef.current;
    abortRefs.current[id]?.abort();
    delete abortRefs.current[id];
    setRun(id, { running: false, live: null, liveFiles: [] });
  }, [setRun]);

  const runPreviewBuild = useCallback(
    async (sid: string, files: ProjectFile[], framework: Framework) => {
      setRun(sid, { building: true });
      appendLog(sid, 'cmd', `vite build · ${files.length} 个文件`);
      try {
        const url = await buildPreview(sid, files, framework);
        patchCurrent(sid, (s) => ({ ...s, previewUrl: url, updatedAt: Date.now() }));
        appendLog(sid, 'ok', `✔ 构建成功，预览已就绪`);
        if (sid === currentIdRef.current) setActiveTab('preview');
      } catch (err) {
        const msg = (err as Error).message || '构建失败';
        appendLog(sid, 'error', msg);
        setRun(sid, { error: msg });
      } finally {
        setRun(sid, { building: false });
      }
    },
    [appendLog, patchCurrent, setRun],
  );

  // 依据当前会话的代码立即构建预览（可在对话未结束时手动触发）。
  const previewNow = useCallback(async () => {
    const sid = currentIdRef.current;
    const session = sessions.find((s) => s.id === sid);
    if (!session) return;
    const files = session.files || [];
    if (files.length === 0) {
      appendLog(sid, 'info', '暂无可预览的代码');
      return;
    }
    if (runs[sid]?.building) return;
    await runPreviewBuild(sid, files, session.framework);
  }, [sessions, runs, runPreviewBuild, appendLog]);

  const send = useCallback(
    (text: string, mode: RunMode = 'iterate', forcedWorkDir?: string) => {
      const goal = text.trim();
      const sid = current?.id;
      if (!goal || !sid) return;
      if (runs[sid]?.running && !forcedWorkDir) return;

      const session = sessions.find((s) => s.id === sid);

      // 本地/远程模式：会话开始时若尚未切出工作树（workDir 仍等于项目主干），
      // 先从主干切出一份 Git 工作树再开发；完成后带着新 workDir 重新发起。
      // 远程模式下 checkoutLocalProject 会在应用所在服务器上切出工作树。
      if (
        !forcedWorkDir &&
        (envConfig.mode === 'local' || envConfig.mode === 'remote') &&
        session?.projectRoot &&
        session.localDevMode !== 'direct' &&
        (!session.workDir || session.workDir === session.projectRoot)
      ) {
        const root = session.projectRoot;
        setRun(sid, { running: true, error: null, live: null, liveFiles: [] });
        appendLog(sid, 'info', '正在为本会话创建 Git 工作树…');
        (async () => {
          try {
            const { workDir, branch } = await checkoutLocalProject(root, sid);
            patchCurrent(sid, (s) => ({
              ...s,
              workDir,
              projectLocked: true,
              merged: false,
              updatedAt: Date.now(),
            }));
            appendLog(sid, 'ok', `✔ 已创建工作树，分支 ${branch}`);
            send(text, mode, workDir);
          } catch (err) {
            const msg = (err as Error).message || '创建工作树失败';
            appendLog(sid, 'error', msg);
            setRun(sid, { running: false, error: msg });
          }
        })();
        return;
      }

      const priorMessages = session ? session.messages : [];
      const currentFiles = session ? session.files : [];
      const effectiveMode: RunMode = currentFiles.length > 0 ? mode : 'replan';

      // 本会话对应的项目目录名：首条消息时用本次目标生成（与重命名一致），
      // 否则沿用已有会话标题，保证同一会话多次迭代始终在同一个项目文件夹中。
      const projectTitle =
        priorMessages.length === 0
          ? goal.slice(0, 20)
          : session?.title || sid;
      const projectName = projectDirName(projectTitle, sid);
      // 本会话选定的本地目录（若有）：直接作为项目根，不再拼项目名子目录。
      // 本地模式下优先使用刚切出的工作树目录（forcedWorkDir）。
      const sessionWorkDir = forcedWorkDir || session?.workDir || '';

      // 远程模式必须先在概览选择/新建项目，或选择服务器上的工作目录（绑定后才有 workDir）。
      if (
        envConfig.mode === 'remote' &&
        envConfig.remote.url &&
        (!sessionWorkDir || (!session?.projectId && !session?.projectRoot))
      ) {
        setRun(sid, { error: '请先在概览选择项目或工作目录' });
        return;
      }

      setRun(sid, { running: true, error: null, live: null, liveFiles: [] });
      appendMessage(sid, { id: uid('u'), kind: 'user', content: goal });
      appendLog(sid, 'cmd', `新任务：${goal}`);
      if (priorMessages.length === 0) {
        renameSession(sid, goal.length <= 20 ? goal : goal.slice(0, 20) + '…');
      }

      const controller = new AbortController();
      abortRefs.current[sid] = controller;
      liveContentRefs.current[sid] = '';
      codeAgentRefs.current[sid] = false;

      // ── CLI mode: bypass runCrew, delegate to local CLI Agent ──
      if (envConfig.mode === 'local' && envConfig.local.engine === 'cli') {
        const cliAgent: AgentRole = {
          id: 'cli-runner',
          name: 'CLI Agent',
          emoji: '⚡',
          color: '#f59e0b',
          goal: '',
          systemPrompt: '',
          producesCode: true,
          enabled: true,
        };

        setRun(sid, { live: { agent: cliAgent, content: '', phase: 'thinking' }, liveFiles: [] });
        appendLog(sid, 'agent', `⚡ CLI Agent 开始工作…`);

        const env = createEnvironment(envConfig, sid, projectName, sessionWorkDir || undefined);
        if (env) {
          (async () => {
            try {
              for await (const event of env.run(goal, envConfig.local.cliId, controller.signal)) {
                switch (event.type) {
                  case 'delta': {
                    const c = (liveContentRefs.current[sid] || '') + event.text;
                    liveContentRefs.current[sid] = c;
                    setRuns((prev) => {
                      const cur = prev[sid] || IDLE;
                      const live = cur.live
                        ? { ...cur.live, content: c, phase: 'writing' as const }
                        : cur.live;
                      return { ...prev, [sid]: { ...cur, live } };
                    });
                    break;
                  }
                  case 'status':
                    if (event.text) appendLog(sid, 'info', event.text);
                    break;
                  case 'done': {
                    const files = event.files || [];
                    const previewUrl = event.previewUrl || null;

                    appendMessage(sid, {
                      id: uid('a'),
                      kind: 'agent',
                      content: liveContentRefs.current[sid] || 'CLI 执行完成',
                      agentId: 'cli-runner',
                      agentName: 'CLI Agent',
                      emoji: '⚡',
                      color: '#f59e0b',
                      hasCode: files.length > 0,
                    });

                    if (files.length > 0) {
                      // 框架/语言由 CLI 产物推断，不写死：根目录有 index.html
                      // 且无 .jsx/.tsx → html，否则视为 react。
                      const hasRootHtml = files.some((f) => /^index\.html$/i.test(f.path));
                      const hasJsx = files.some((f) => /\.(jsx|tsx)$/i.test(f.path));
                      const framework = hasRootHtml && !hasJsx ? 'html' : 'react';
                      patchCurrent(sid, (s) => ({
                        ...s,
                        files,
                        framework,
                        updatedAt: Date.now(),
                      }));
                      appendLog(sid, 'ok', `✔ CLI 生成 ${files.length} 个文件`);

                      // 文件已由 CLI 直接写入 <工作根目录>/<项目名> 磁盘目录，无需重复写入。

                      if (previewUrl) {
                        const fullUrl = previewUrl.startsWith('/')
                          ? `${BASE_PREFIX}${previewUrl}`
                          : previewUrl;
                        patchCurrent(sid, (s) => ({ ...s, previewUrl: fullUrl }));
                        appendLog(sid, 'ok', `✔ 预览已就绪`);
                        if (sid === currentIdRef.current) setActiveTab('preview');
                      }
                    }
                    setRun(sid, { liveFiles: files });
                    break;
                  }
                  case 'error':
                    appendLog(sid, 'error', event.text || 'CLI 执行失败');
                    setRun(sid, { error: event.text || 'CLI 执行失败' });
                    break;
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError') {
                const msg = (err as Error).message || 'CLI 执行异常';
                appendLog(sid, 'error', msg);
                setRun(sid, { error: msg });
              }
            } finally {
              setRun(sid, { running: false, live: null, liveFiles: [] });
              delete abortRefs.current[sid];
            }
          })();
        }
        return;
      }

      // ── Remote mode: run CLI on the deployed remote server (e.g. siplgo.xyz) ──
      if (envConfig.mode === 'remote' && envConfig.remote.url) {
        const host = (() => {
          try {
            return new URL(envConfig.remote.url).host;
          } catch {
            return envConfig.remote.url;
          }
        })();
        const remoteAgent: AgentRole = {
          id: 'remote-runner',
          name: `远程 · ${host}`,
          emoji: '☁️',
          color: '#0ea5e9',
          goal: '',
          systemPrompt: '',
          producesCode: true,
          enabled: true,
        };

        setRun(sid, { live: { agent: remoteAgent, content: '', phase: 'thinking' }, liveFiles: [] });
        appendLog(sid, 'agent', `☁️ 远程 Agent (${host}) 开始在服务器上工作…`);

        const env = createEnvironment(envConfig, sid, projectName, sessionWorkDir || undefined);
        if (env) {
          (async () => {
            try {
              for await (const event of env.run(goal, envConfig.remote.cliId, controller.signal)) {
                switch (event.type) {
                  case 'delta': {
                    const c = (liveContentRefs.current[sid] || '') + event.text;
                    liveContentRefs.current[sid] = c;
                    setRuns((prev) => {
                      const cur = prev[sid] || IDLE;
                      const live = cur.live
                        ? { ...cur.live, content: c, phase: 'writing' as const }
                        : cur.live;
                      return { ...prev, [sid]: { ...cur, live } };
                    });
                    break;
                  }
                  case 'status':
                    if (event.text) appendLog(sid, 'info', event.text);
                    break;
                  case 'done': {
                    const files = event.files || [];
                    const previewUrl = event.previewUrl || null;

                    appendMessage(sid, {
                      id: uid('a'),
                      kind: 'agent',
                      content: liveContentRefs.current[sid] || '远程执行完成',
                      agentId: 'remote-runner',
                      agentName: `远程 · ${host}`,
                      emoji: '☁️',
                      color: '#0ea5e9',
                      hasCode: files.length > 0,
                    });

                    if (files.length > 0) {
                      const hasRootHtml = files.some((f) => /^index\.html$/i.test(f.path));
                      const hasJsx = files.some((f) => /\.(jsx|tsx)$/i.test(f.path));
                      const framework = hasRootHtml && !hasJsx ? 'html' : 'react';
                      patchCurrent(sid, (s) => ({
                        ...s,
                        files,
                        framework,
                        updatedAt: Date.now(),
                      }));
                      appendLog(sid, 'ok', `✔ 远程生成 ${files.length} 个文件`);

                      // 预览由远端构建，previewUrl 已被 RemoteEnvironment 拼成远端绝对地址。
                      if (previewUrl) {
                        patchCurrent(sid, (s) => ({ ...s, previewUrl }));
                        appendLog(sid, 'ok', `✔ 远程预览已就绪`);
                        if (sid === currentIdRef.current) setActiveTab('preview');
                      }
                    }
                    setRun(sid, { liveFiles: files });
                    break;
                  }
                  case 'error':
                    appendLog(sid, 'error', event.text || '远程执行失败');
                    setRun(sid, { error: event.text || '远程执行失败' });
                    break;
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError') {
                const msg = (err as Error).message || '远程执行异常';
                appendLog(sid, 'error', msg);
                setRun(sid, { error: msg });
              }
            } finally {
              setRun(sid, { running: false, live: null, liveFiles: [] });
              delete abortRefs.current[sid];
            }
          })();
        }
        return;
      }

      // ── SSH mode: run CLI on remote host ──
      if (envConfig.mode === 'ssh' && envConfig.ssh.host) {
        const sshAgent: AgentRole = {
          id: 'ssh-runner',
          name: `SSH · ${envConfig.ssh.host}`,
          emoji: '🔒',
          color: '#8b5cf6',
          goal: '',
          systemPrompt: '',
          producesCode: true,
          enabled: true,
        };

        setRun(sid, { live: { agent: sshAgent, content: '', phase: 'thinking' }, liveFiles: [] });
        appendLog(sid, 'agent', `🔒 SSH Agent (${envConfig.ssh.host}) 开始工作…`);

        const env = createEnvironment(envConfig, sid, projectName);
        if (env) {
          (async () => {
            try {
              for await (const event of env.run(goal, envConfig.ssh.cliId, controller.signal)) {
                switch (event.type) {
                  case 'delta': {
                    const c = (liveContentRefs.current[sid] || '') + event.text;
                    liveContentRefs.current[sid] = c;
                    setRuns((prev) => {
                      const cur = prev[sid] || IDLE;
                      const live = cur.live
                        ? { ...cur.live, content: c, phase: 'writing' as const }
                        : cur.live;
                      return { ...prev, [sid]: { ...cur, live } };
                    });
                    break;
                  }
                  case 'status':
                    if (event.text) appendLog(sid, 'info', event.text);
                    break;
                  case 'done': {
                    const files = event.files || [];
                    const previewUrl = event.previewUrl || null;

                    appendMessage(sid, {
                      id: uid('a'),
                      kind: 'agent',
                      content: liveContentRefs.current[sid] || 'SSH 执行完成',
                      agentId: 'ssh-runner',
                      agentName: `SSH · ${envConfig.ssh.host}`,
                      emoji: '🔒',
                      color: '#8b5cf6',
                      hasCode: files.length > 0,
                    });

                    if (files.length > 0) {
                      patchCurrent(sid, (s) => ({
                        ...s,
                        files,
                        framework: 'react',
                        updatedAt: Date.now(),
                      }));
                      appendLog(sid, 'ok', `✔ SSH 生成 ${files.length} 个文件`);

                      if (previewUrl) {
                        const fullUrl = previewUrl.startsWith('/')
                          ? `${BASE_PREFIX}${previewUrl}`
                          : previewUrl;
                        patchCurrent(sid, (s) => ({ ...s, previewUrl: fullUrl }));
                        appendLog(sid, 'ok', `✔ 预览已就绪`);
                        if (sid === currentIdRef.current) setActiveTab('preview');
                      }
                    }
                    setRun(sid, { liveFiles: files });
                    break;
                  }
                  case 'error':
                    appendLog(sid, 'error', event.text || 'SSH 执行失败');
                    setRun(sid, { error: event.text || 'SSH 执行失败' });
                    break;
                }
              }
            } catch (err) {
              if ((err as Error).name !== 'AbortError') {
                const msg = (err as Error).message || 'SSH 执行异常';
                appendLog(sid, 'error', msg);
                setRun(sid, { error: msg });
              }
            } finally {
              setRun(sid, { running: false, live: null, liveFiles: [] });
              delete abortRefs.current[sid];
            }
          })();
        }
        return;
      }

      // ── Builtin mode: runCrew (existing) ──
      const ctx = { currentFiles, history: condenseHistory(priorMessages) };
      let firstNonCodeSummary = '';

      runCrew(
        agents,
        goal,
        effectiveMode,
        ctx,
        {
          onSystem: (msg) => {
            appendMessage(sid, { id: uid('sys'), kind: 'system', content: msg });
            appendLog(sid, 'info', msg);
          },
          onAgentStart: (agent) => {
            liveContentRefs.current[sid] = '';
            codeAgentRefs.current[sid] = agent.producesCode;
            setRun(sid, { live: { agent, content: '', phase: 'thinking' }, liveFiles: [] });
            appendLog(sid, 'agent', `${agent.emoji} ${agent.name} 开始工作…`);
            if (agent.producesCode && sid === currentIdRef.current) setActiveTab('code');
          },
          onAgentDelta: (t) => {
            const content = (liveContentRefs.current[sid] || '') + t;
            liveContentRefs.current[sid] = content;
            setRuns((prev) => {
              const cur = prev[sid] || IDLE;
              const live = cur.live ? { ...cur.live, content, phase: 'writing' as const } : cur.live;
              const liveFiles = codeAgentRefs.current[sid]
                ? parseEngineerOutput(content).files
                : cur.liveFiles;
              return { ...prev, [sid]: { ...cur, live, liveFiles } };
            });
          },
          onAgentDone: (agent, content) => {
            const parsed = agent.producesCode ? parseEngineerOutput(content) : null;
            appendMessage(sid, {
              id: uid('a'),
              kind: 'agent',
              content,
              agentId: agent.id,
              agentName: agent.name,
              emoji: agent.emoji,
              color: agent.color,
              hasCode: Boolean(parsed && parsed.files.length > 0),
            });
            if (!agent.producesCode && !firstNonCodeSummary) {
              firstNonCodeSummary = stripFences(content);
            }
            if (parsed && parsed.files.length > 0) {
              patchCurrent(sid, (s) => ({
                ...s,
                files: parsed.files,
                framework: parsed.framework,
                summary: firstNonCodeSummary || s.summary,
                updatedAt: Date.now(),
              }));
              appendLog(sid, 'ok', `✔ ${agent.name} 生成 ${parsed.files.length} 个文件`);

              // 内置团队产出的代码仅在内存中，写入磁盘目录持久化。
              // 会话选定目录时直接写入该目录，否则写入 <工作根目录>/<项目名>。
              const projectDir = sessionWorkDir
                ? sessionWorkDir
                : envConfig.local.workDir
                  ? `${envConfig.local.workDir}/${projectName}`
                  : null;
              if (projectDir) {
                writeProjectFiles(parsed.files, projectDir).catch(() => {});
              }

              void runPreviewBuild(sid, parsed.files, parsed.framework);
            } else if (!agent.producesCode) {
              appendLog(sid, 'ok', `✔ ${agent.name} 完成`);
            }
            setRun(sid, { live: null });
          },
          onError: (msg) => {
            appendLog(sid, 'error', msg);
            setRun(sid, { error: msg });
          },
        },
        controller.signal,
      ).finally(() => {
        setRun(sid, { running: false, live: null, liveFiles: [] });
        delete abortRefs.current[sid];
      });
    },
    [agents, appendLog, appendMessage, current, envConfig, patchCurrent, renameSession, runPreviewBuild, runs, sessions, setRun],
  );

  const clearError = useCallback(() => setRun(currentIdRef.current, { error: null }), [setRun]);

  const isRunning = useCallback(
    (id: string) => Boolean(runs[id]?.running || runs[id]?.building),
    [runs],
  );

  // ---- 消息队列（类 Claude Code）----
  const queue = current ? queues[current.id] || [] : [];

  const enqueue = useCallback((text: string, mode: RunMode) => {
    const t = text.trim();
    if (!t) return;
    const sid = currentIdRef.current;
    if (!sid) return;
    setQueues((prev) => ({
      ...prev,
      [sid]: [...(prev[sid] || []), { id: uid('q'), text: t, mode }],
    }));
  }, []);

  const removeQueued = useCallback((itemId: string) => {
    const sid = currentIdRef.current;
    if (!sid) return;
    setQueues((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).filter((q) => q.id !== itemId),
    }));
  }, []);

  // 当前会话空闲（非运行且非构建）且队列非空时，自动取出下一条执行。
  useEffect(() => {
    const sid = current?.id;
    if (!sid) return;
    const r = runs[sid] || IDLE;
    if (r.running || r.building) return;
    const q = queues[sid] || [];
    if (q.length === 0) return;
    const [next, ...rest] = q;
    setQueues((prev) => ({ ...prev, [sid]: rest }));
    send(next.text, next.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, queues, current]);

  const value: AppState = {
    sessions,
    current,
    agents,
    envConfig,
    live: run.live,
    liveFiles: run.liveFiles,
    running: run.running,
    building: run.building,
    error: run.error,
    activeTab,
    isRunning,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    updateAgents,
    resetAgents,
    // environment
    setEnvConfig,
    setSessionWorkDir,
    bindSessionProject,
    mergeSessionProject,
    localProjects,
    bindLocalProject,
    setLocalDevMode,
    mergeLocalSession,
    // auth
    authEmail,
    login,
    register,
    logout,
    // run actions
    send,
    queue,
    enqueue,
    removeQueued,
    previewNow,
    stop,
    setActiveTab,
    clearError,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
