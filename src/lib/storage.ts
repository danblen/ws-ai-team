import type { AgentRole, Framework, Session } from './types';
import { DEFAULT_AGENTS } from './agents';
import { defaultEnvConfig } from './env/types';
import type { EnvironmentConfig } from './env/types';

const K_SESSIONS = 'atoms.sessions.v1';
const K_AGENTS = 'atoms.agents.v1';
const K_CURRENT = 'atoms.current.v1';
const K_ENV = 'atoms.env.v1';
const K_LOCAL_PROJECTS = 'atoms.localprojects.v1';

let seq = 0;
export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * 由会话标题生成安全的项目目录名（单层文件名，不含路径分隔符）。
 * 每个会话对应工作根目录下的一个独立项目文件夹。
 */
export function projectSlug(title: string): string {
  const slug = (title || '').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'project';
}

/**
 * 由会话标题 + 会话 id 尾片段生成「唯一」的项目目录名。
 * 追加 sid 尾片段可保证：即使不同会话标题相同，也不会复用同一磁盘目录，
 * 从而让每个新会话都在干净、独立的目录中起步。
 */
export function projectDirName(title: string, sid: string): string {
  const slug = projectSlug(title);
  const suffix = (sid || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4);
  return suffix ? `${slug}-${suffix}` : slug;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

export function createSession(seed?: EnvironmentConfig): Session {
  const now = Date.now();
  return {
    id: uid('sess'),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    code: '',
    files: [],
    framework: 'react',
    logs: [],
    // 新会话继承当前默认模式模板（深拷贝），缺省用内置默认。
    envConfig: seed ? JSON.parse(JSON.stringify(seed)) : defaultEnvConfig(),
  };
}

export function loadAgents(): AgentRole[] {
  const agents = read<AgentRole[]>(K_AGENTS, []);
  if (!Array.isArray(agents) || agents.length === 0) return DEFAULT_AGENTS.map((a) => ({ ...a }));
  return agents;
}

export function saveAgents(agents: AgentRole[]) {
  write(K_AGENTS, agents);
}

export function loadSessions(): Session[] {
  const sessions = read<Session[]>(K_SESSIONS, []);
  if (!Array.isArray(sessions)) return [];
  // Backfill fields added in later versions.
  return sessions.map((s) => ({
    ...s,
    logs: Array.isArray(s.logs) ? s.logs : [],
    files: Array.isArray(s.files) ? s.files : [],
    framework: s.framework === 'html' ? 'html' : 'react',
  }));
}

export function saveSessions(sessions: Session[]) {
  write(K_SESSIONS, sessions);
}

export function loadCurrentId(): string | null {
  return read<string | null>(K_CURRENT, null);
}

export function saveCurrentId(id: string) {
  write(K_CURRENT, id);
}

/**
 * 加载执行环境配置。敏感字段（SSH 密码/私钥内容、Remote token）不落 localStorage，
 * 只保留非敏感的连接信息；密钥类数据由后端持有。
 */
export function loadEnvConfig(): EnvironmentConfig {
  const base = defaultEnvConfig();
  const stored = read<Partial<EnvironmentConfig> | null>(K_ENV, null);
  if (!stored || typeof stored !== 'object') return base;
  return {
    mode: stored.mode === 'ssh' || stored.mode === 'remote' ? stored.mode : 'local',
    local: { ...base.local, ...(stored.local || {}) },
    ssh: { ...base.ssh, ...(stored.ssh || {}), password: '', privateKeyPath: stored.ssh?.privateKeyPath || '' },
    remote: { ...base.remote, ...(stored.remote || {}), token: '' },
  };
}

export function saveEnvConfig(config: EnvironmentConfig) {
  // 持久化前剔除敏感字段，避免密钥进入 localStorage。
  const safe: EnvironmentConfig = {
    ...config,
    ssh: { ...config.ssh, password: '' },
    remote: { ...config.remote, token: '' },
  };
  write(K_ENV, safe);
}

/**
 * 本地项目注册表：本地模式下由用户选定的「工作目录 + 名称」构成的历史项目，
 * 持久化在浏览器 localStorage，供新会话在概览区直接选取继续开发。
 */
export interface LocalProject {
  id: string;
  name: string;
  workDir: string;
  framework?: Framework;
  createdAt: number;
  updatedAt: number;
}

export function loadLocalProjects(): LocalProject[] {
  const list = read<LocalProject[]>(K_LOCAL_PROJECTS, []);
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p.workDir === 'string' && typeof p.name === 'string');
}

export function saveLocalProjects(list: LocalProject[]) {
  write(K_LOCAL_PROJECTS, list);
}
