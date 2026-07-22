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
  loadSessions,
  projectDirName,
  saveAgents,
  saveCurrentId,
  saveEnvConfig,
  saveSessions,
  uid,
} from '../lib/storage';
import { DEFAULT_AGENTS } from '../lib/agents';
import type { EnvironmentConfig } from '../lib/env/types';
import { createEnvironment } from '../lib/env';
import { runCrew, parseEngineerOutput } from '../lib/orchestrator';
import type { RunMode } from '../lib/orchestrator';
import {
  BASE_PREFIX,
  buildPreview,
  setApiConfig,
  clearApiConfig,
  writeProjectFiles,
  getAuthToken,
  login as apiLogin,
  register as apiRegister,
  fetchMe,
  setAuthToken,
  clearAuthToken,
} from '../lib/api';

export type WorkTab = 'overview' | 'preview' | 'code' | 'cloud' | 'files' | 'terminal' | 'publish';

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
  // auth (公共登录/注册，与执行环境无关)
  authEmail: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  // run actions
  send: (text: string, mode?: RunMode) => void;
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

  useEffect(() => saveSessions(sessions), [sessions]);
  useEffect(() => saveAgents(agents), [agents]);
  useEffect(() => saveEnvConfig(envConfig), [envConfig]);
  useEffect(() => {
    if (currentId) saveCurrentId(currentId);
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

  const send = useCallback(
    (text: string, mode: RunMode = 'iterate') => {
      const goal = text.trim();
      const sid = current?.id;
      if (!goal || !sid) return;
      if (runs[sid]?.running) return;

      const session = sessions.find((s) => s.id === sid);
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

        const env = createEnvironment(envConfig, sid, projectName);
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

        const env = createEnvironment(envConfig, sid, projectName);
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

              // 内置团队产出的代码仅在内存中，写入 <工作根目录>/<项目名> 磁盘目录持久化。
              const workDir = envConfig.local.workDir;
              if (workDir) {
                const projectDir = `${workDir}/${projectName}`;
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
    // auth
    authEmail,
    login,
    register,
    logout,
    // run actions
    send,
    stop,
    setActiveTab,
    clearError,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
