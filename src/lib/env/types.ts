import type { ProjectFile } from '../types';

/** 执行环境模式：本机 / SSH 远程服务器 / 云端部署的同款实例 */
export type EnvironmentMode = 'local' | 'ssh' | 'remote';

/** Local 模式内部再分：内置多智能体团队 / 本机 CLI Agent（方案 A 整体替换） */
export type LocalEngine = 'builtin' | 'cli';

/** 一个可被当前环境执行的 Agent。 */
export interface AvailableAgent {
  id: string; // 'builtin' | 'claude' | 'opencode' | ...
  name: string; // 显示名
  kind: 'builtin' | 'cli';
  path?: string; // CLI 可执行文件绝对路径
  version?: string;
}

/** 环境执行任务的统一流式事件。 */
export interface AgentEvent {
  type: 'status' | 'delta' | 'file' | 'done' | 'error';
  text?: string; // status/delta/error 的文本
  file?: ProjectFile; // CLI 模式实时上报的文件
  /** done 事件携带的 CLI 产出文件清单。 */
  files?: ProjectFile[];
  /** done 事件携带的预览 URL（CLI 模式）。 */
  previewUrl?: string | null;
}

export interface EnvHealth {
  ok: boolean;
  detail: string;
}

/**
 * 执行环境抽象层。前端 UI 只跟这个接口打交道，
 * 具体「任务在哪跑、Agent 是谁、文件/预览从哪来」由实现决定。
 */
export interface ExecutionEnvironment {
  readonly mode: EnvironmentMode;
  /** 检测当前环境可用的 Agent（内置团队 / 本机或远程已安装的 CLI）。 */
  listAgents(): Promise<AvailableAgent[]>;
  /** 流式执行一次任务。CLI Agent 会绕开内置 orchestrator。 */
  run(task: string, agentId: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** 当前 session 的文件从哪读（内存 / 磁盘 / 远程）。 */
  readFiles(sid: string): Promise<ProjectFile[]>;
  /** 预览 URL 从哪来（本地构建 / 云端实例）。 */
  getPreviewUrl(sid: string): Promise<string | null>;
  healthCheck(): Promise<EnvHealth>;
}

// ---------- 配置模型 ----------

export interface LocalEnvConfig {
  engine: LocalEngine; // 'builtin' | 'cli'
  cliId: string; // engine='cli' 时：'claude' | 'opencode'
  workDir?: string; // CLI 工作目录，默认 server/.workspaces/<sid>
}

export interface SSHEnvConfig {
  host: string;
  port: number; // 默认 22
  username: string;
  authMethod: 'key' | 'password';
  privateKeyPath?: string; // 私钥路径（内容不进前端）
  password?: string; // 仅存后端
  cliId: string; // 远程服务器上装了哪个 CLI
  remoteWorkDir: string; // 远程工作目录
}

export interface RemoteEnvConfig {
  url: string; // https://siplgo.xyz
  token: string; // 会话令牌（登录后由 api.ts 持有，不落 localStorage envConfig）
  cliId: string; // 远端服务器上要跑的 CLI：'claude' | 'opencode' | 'aider'
  workDir?: string; // 远端项目工作目录（可选，缺省为服务端工作区）
}

export interface EnvironmentConfig {
  mode: EnvironmentMode;
  local: LocalEnvConfig;
  ssh: SSHEnvConfig;
  remote: RemoteEnvConfig;
}

export function defaultEnvConfig(): EnvironmentConfig {
  return {
    mode: 'remote',
    local: { engine: 'builtin', cliId: 'claude', workDir: '' },
    ssh: {
      host: '',
      port: 22,
      username: '',
      authMethod: 'key',
      privateKeyPath: '',
      password: '',
      cliId: 'opencode',
      remoteWorkDir: '~/aiteam-workspace',
    },
    remote: {
      url: typeof window !== 'undefined' ? window.location.origin : '',
      token: '',
      cliId: 'opencode',
      workDir: '',
    },
  };
}
