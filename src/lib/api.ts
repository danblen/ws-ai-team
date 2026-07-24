import type { Framework, HealthInfo, ProjectFile } from './types';
import type { AvailableAgent, EnvironmentMode } from './env/types';
import { getLlmConfig } from './llm-config';

// ---------- Remote / configurable base URL ----------

let _apiPrefix = '';
let _apiToken = '';

const K_AUTH_TOKEN = 'atoms.auth.token.v1';

// 会话令牌（邮箱登录后获得）。持久化到 localStorage 以保持登录态，
// 注入到所有 /api 请求的 Authorization 头（优先于旧的 remote token）。
let _authToken = (() => {
  try {
    return localStorage.getItem(K_AUTH_TOKEN) || '';
  } catch {
    return '';
  }
})();

/** 设置（并持久化）登录会话令牌。传空串等同于清除。 */
export function setAuthToken(token: string) {
  _authToken = token || '';
  try {
    if (_authToken) localStorage.setItem(K_AUTH_TOKEN, _authToken);
    else localStorage.removeItem(K_AUTH_TOKEN);
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function getAuthToken(): string {
  return _authToken;
}

export function clearAuthToken() {
  setAuthToken('');
}

/**
 * Set a remote API target. When set, all /api/* fetch calls will be
 * redirected to {prefix}/api/* with an Authorization header.
 * Call clearApiConfig() to revert to local backend.
 */
export function setApiConfig(prefix: string, token: string) {
  _apiPrefix = prefix.replace(/\/+$/, '');
  _apiToken = token;
}

export function clearApiConfig() {
  _apiPrefix = '';
  _apiToken = '';
}

/** 当前生效的远端前缀（未配置时为空串，即本地）。 */
export function getApiPrefix(): string {
  return _apiPrefix;
}

// 应用部署的基路径（vite `base`，如 /aiteam）。生产环境后端挂在该子路径下，
// 所有 /api、/preview 请求都必须带上它，否则会绕过反向代理导致 404。
export const BASE_PREFIX = import.meta.env.BASE_URL.replace(/\/+$/, '');

function apiUrl(path: string): string {
  return `${_apiPrefix}${BASE_PREFIX}${path}`;
}

function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const h = { ...extra };
  // 登录会话令牌优先；其次才是旧的静态 remote token。
  const bearer = _authToken || _apiToken;
  if (bearer) h['Authorization'] = `Bearer ${bearer}`;
  return h;
}

// ---------- Auth ----------

export interface AuthResult {
  email: string;
  token: string;
}

/** 邮箱+密码登录（云端模式下自动打到远端实例）。 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || `登录失败 (${res.status})`);
  return { email: data.email, token: data.token };
}

/** 注册新邮箱账号，成功后直接返回令牌。 */
export async function register(email: string, password: string): Promise<AuthResult> {
  const res = await fetch(apiUrl('/api/auth/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error(data.error || `注册失败 (${res.status})`);
  return { email: data.email, token: data.token };
}

/** 校验当前令牌并返回登录邮箱；未登录则抛错。 */
export async function fetchMe(): Promise<{ email: string }> {
  const res = await fetch(apiUrl('/api/auth/me'), { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '未登录');
  return { email: data.email };
}

// ---------- 对话次数追踪 ----------

export interface ConversationUsage {
  used: number;
  max: number;
}

/**
 * 在每次 send() 开始时调用，扣减一次对话配额。
 * 服务端负责校验并持久化计数，前端无法绕过。
 * 超管不限制；普通用户达到上限后返回 403。
 */
export async function trackConversation(): Promise<ConversationUsage> {
  const res = await fetch(apiUrl('/api/conversation/start'), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '对话次数已达上限');
  return { used: data.used, max: data.max };
}


// ---------- API functions ----------

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch(apiUrl('/api/health'), { headers: apiHeaders() });
  if (!res.ok) throw new Error('健康检查失败');
  return res.json();
}

/** 检测某个执行环境下可用的 Agent（内置团队 / 已安装 CLI）。 */
export async function detectAgents(mode: EnvironmentMode): Promise<AvailableAgent[]> {
  const res = await fetch(
    apiUrl(`/api/env/agents?mode=${encodeURIComponent(mode)}`),
    { headers: apiHeaders() },
  );
  const data = await res.json().catch(() => ({ agents: [] }));
  if (!res.ok) throw new Error(data.error || `Agent 检测失败 (${res.status})`);
  return (data.agents || []) as AvailableAgent[];
}

/** 写入生成的项目文件到指定磁盘目录。 */
export async function writeProjectFiles(files: ProjectFile[], projectDir: string): Promise<void> {
  await fetch(apiUrl('/api/write-project-files'), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ files, projectDir }),
  });
}

/** 目录浏览：列出某本地目录下的子目录。path 为空时后端默认返回家目录。 */
export interface LocalDirEntry {
  name: string;
  path: string;
}
export interface LocalDirListing {
  path: string;
  parent: string | null;
  dirs: LocalDirEntry[];
}
export async function listLocalDirs(dirPath?: string): Promise<LocalDirListing> {
  const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  const res = await fetch(apiUrl(`/api/env/local/dirs${qs}`), { headers: apiHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `读取目录失败 (${res.status})`);
  return { path: data.path, parent: data.parent ?? null, dirs: (data.dirs || []) as LocalDirEntry[] };
}

/** 直接读取一个本地目录（作为项目根）下的文件。 */
export async function readLocalDirFiles(sid: string, workDir: string): Promise<ProjectFile[]> {
  const params = new URLSearchParams({ sid, workDir, direct: '1' });
  const res = await fetch(apiUrl(`/api/env/local/files?${params}`), { headers: apiHeaders() });
  const data = await res.json().catch(() => ({ files: [] }));
  if (!res.ok) throw new Error(data.error || `读取目录文件失败 (${res.status})`);
  return (data.files || []) as ProjectFile[];
}


/**
 * Ask the backend to build the given project files with Vite and serve them.
 * Returns the preview URL (e.g. /preview/<sid>/) on success.
 */
export async function buildPreview(
  sid: string,
  files: ProjectFile[],
  framework: Framework,
): Promise<string> {
  const res = await fetch(apiUrl(`/api/preview/${encodeURIComponent(sid)}`), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ files, framework }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || `构建失败 (${res.status})`);
  // 后端返回的是根相对路径（/preview/<sid>/），iframe 需带上基路径才能加载。
  const url = data.url as string;
  return url.startsWith('/') ? `${BASE_PREFIX}${url}` : url;
}

/** 远程模式：文件已在服务器磁盘上，直接传 workDir 让服务器构建预览。 */
export async function buildPreviewFromDir(
  sid: string,
  workDir: string,
): Promise<string> {
  const res = await fetch(apiUrl(`/api/preview/${encodeURIComponent(sid)}/build`), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workDir }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || `构建失败 (${res.status})`);
  const url = data.url as string;
  return url.startsWith('/') ? `${BASE_PREFIX}${url}` : url;
}

/** 远程模式：为已有工作目录启动 Vite Dev Server 预览（免构建、即时加载）。 */
export async function startDevPreview(
  sid: string,
  workDir: string,
): Promise<string> {
  const res = await fetch(apiUrl(`/api/preview/${encodeURIComponent(sid)}/dev`), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ workDir }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || `启动预览失败 (${res.status})`);
  const url = data.url as string;
  return url.startsWith('/') ? `${BASE_PREFIX}${url}` : url;
}

// ---------- Publish (persistent, publicly shareable site) ----------

export interface PublishResult {
  id: string;
  /** 完整可分享的绝对地址（含 origin + 基路径 + /p/<id>/）。 */
  url: string;
}

/** 目标实例定位：remote 模式下发布到远端实例，使链接对外可访问。 */
export interface PublishTarget {
  base?: string;
  token?: string;
}

/** 将 base 归一化并拼出该实例下某根相对路径的完整绝对地址。 */
function absoluteUrl(base: string, rootRelative: string): string {
  const origin = (base || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/+$/, '');
  return rootRelative.startsWith('/') ? `${origin}${BASE_PREFIX}${rootRelative}` : rootRelative;
}

/**
 * 发布（或重新发布）一个会话的项目，返回可分享的公开地址。
 * remote 模式下传入 { base, token } 以发布到远端部署实例。
 */
export async function publishProject(
  sid: string,
  files: ProjectFile[],
  framework: Framework,
  title: string,
  target?: PublishTarget,
): Promise<PublishResult> {
  const base = (target?.base || '').replace(/\/+$/, '');
  const bearer = target?.token || _authToken || _apiToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const res = await fetch(`${base}${BASE_PREFIX}/api/publish/${encodeURIComponent(sid)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ files, framework, title }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) throw new Error(data.error || `发布失败 (${res.status})`);
  return { id: data.id as string, url: absoluteUrl(base, data.url as string) };
}

/** 查询某会话是否已发布，返回其可分享地址（未发布则 null）。 */
export async function getPublishInfo(sid: string, target?: PublishTarget): Promise<PublishResult | null> {
  const base = (target?.base || '').replace(/\/+$/, '');
  const bearer = target?.token || _authToken || _apiToken;
  const headers: Record<string, string> = {};
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;

  const res = await fetch(`${base}${BASE_PREFIX}/api/publish/${encodeURIComponent(sid)}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.published || !data.url) return null;
  return { id: data.id as string, url: absoluteUrl(base, data.url as string) };
}

// ---------- Projects (per-user registry + Git worktree, remote mode) ----------

export interface RemoteProject {
  id: string;
  name: string;
  workDir: string;
  framework?: Framework;
  createdAt: number;
  updatedAt: number;
}

/** 列出当前用户的项目（云端模式下自动打到远端实例）。 */
export async function listProjects(): Promise<RemoteProject[]> {
  const res = await fetch(apiUrl('/api/projects'), { headers: apiHeaders() });
  const data = await res.json().catch(() => ({ projects: [] }));
  if (!res.ok) throw new Error(data.error || `读取项目失败 (${res.status})`);
  return (data.projects || []) as RemoteProject[];
}

/** 新建项目（后端 git init + 初始提交）。 */
export async function createProject(name: string): Promise<RemoteProject> {
  const res = await fetch(apiUrl('/api/projects'), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.project) throw new Error(data.error || `新建项目失败 (${res.status})`);
  return data.project as RemoteProject;
}

/** 删除项目（后端移除项目目录并从注册表清除）。 */
export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(id)}`), {
    method: 'DELETE',
    headers: apiHeaders(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `删除项目失败 (${res.status})`);
}

/** 为会话创建（或复用）该项目的 worktree 分支，返回其绝对工作目录。 */
export async function checkoutProject(
  id: string,
  sid: string,
): Promise<{ workDir: string; branch: string }> {
  const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(id)}/checkout`), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.workDir) throw new Error(data.error || `创建工作树失败 (${res.status})`);
  return { workDir: data.workDir as string, branch: data.branch as string };
}

/** 把会话分支合并到主干并移除 worktree。 */
export async function mergeProject(id: string, sid: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/projects/${encodeURIComponent(id)}/merge`), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `合并到主干失败 (${res.status})`);
}

// ---------- Local Git worktree (本地模式，任意本地仓库目录) ----------

/** 本地模式：为会话在指定本地仓库目录创建（或复用）worktree 分支。 */
export async function checkoutLocalProject(
  dir: string,
  sid: string,
): Promise<{ workDir: string; branch: string }> {
  const res = await fetch(apiUrl('/api/local-git/checkout'), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ dir, sid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.workDir) throw new Error(data.error || `创建工作树失败 (${res.status})`);
  return { workDir: data.workDir as string, branch: data.branch as string };
}

/** 本地模式：把会话分支合并回该本地仓库的主干并移除 worktree。 */
export async function mergeLocalProject(dir: string, sid: string): Promise<void> {
  const res = await fetch(apiUrl('/api/local-git/merge'), {
    method: 'POST',
    headers: apiHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ dir, sid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `合并到主干失败 (${res.status})`);
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
  signal?: AbortSignal;
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Stream one agent turn from the backend generic chat endpoint.
 * The caller fully controls the system prompt and message list, so every
 * agent can act with its own role.
 */
export async function streamChat(
  system: string,
  messages: ChatTurn[],
  handlers: StreamHandlers,
): Promise<void> {
  const { onDelta, onDone, onError, signal } = handlers;

  const llmConfig = getLlmConfig();

  let res: Response;
  try {
    res = await fetch(apiUrl('/api/chat'), {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        system,
        messages,
        apiKey: llmConfig.apiKey,
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
      }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    onError((err as Error).message || '网络请求失败');
    return;
  }

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({ error: `请求失败 (${res.status})` }));
    onError(data.error || `请求失败 (${res.status})`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';

      for (const frame of frames) {
        let event = 'message';
        let dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;

        let payload: { text?: string; message?: string };
        try {
          payload = JSON.parse(dataLine);
        } catch {
          continue;
        }

        if (event === 'delta' && payload.text) onDelta(payload.text);
        else if (event === 'error') return onError(payload.message || '生成失败');
        else if (event === 'done') return onDone();
      }
    }
    onDone();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    onError((err as Error).message || '读取流失败');
  }
}
