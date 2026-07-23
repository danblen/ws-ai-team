import { useEffect } from 'react';
import type { RemoteEnvConfig } from '../../lib/env/types';
import { useApp } from '../../store/AppProvider';

interface Props {
  config: RemoteEnvConfig;
  onChange: (patch: Partial<RemoteEnvConfig>) => void;
}

// 云端 = 当前应用部署所在的站点，直接连接当前源。
const apiBase = typeof window !== 'undefined' ? window.location.origin : '';

export default function RemoteForm({ config, onChange }: Props) {
  const { authEmail } = useApp();

  // 将 remote.url 同步为当前源（云端即本应用自身所在站点）。
  useEffect(() => {
    if (config.url !== apiBase) onChange({ url: apiBase });
  }, [config.url]);

  return (
    <div className="env-form">
      <div className="env-field">
        <label className="env-label">云端实例</label>
        <p className="env-hint">
          将连接到当前部署的这套 AI Team 应用（<b>{apiBase || '当前站点'}</b>）。任务发送到该服务端，由它<b>直接在服务器上运行 CLI 修改代码</b>并回流预览。
        </p>
      </div>

      <div className="env-field">
        <label className="env-label">登录状态</label>
        <p className="env-hint">
          {authEmail
            ? `已登录 · ${authEmail}`
            : '未登录。请点击右上角「登录 / 注册」后再执行云端任务。'}
        </p>
      </div>

      <div className="env-field">
        <label className="env-label">云端服务器上的 Agent CLI</label>
        <select
          className="env-input"
          value={config.cliId}
          onChange={(e) => onChange({ cliId: e.target.value })}
        >
          <option value="opencode">OpenCode CLI</option>
          <option value="claude">Claude Code CLI</option>
          <option value="aider">Aider</option>
        </select>
        <p className="env-hint">需已在云端服务器安装。任务将在远端由该 CLI 执行。</p>
      </div>

      <div className="env-field">
        <label className="env-label">云端工作目录（可选）</label>
        <input
          className="env-input"
          placeholder="留空则使用服务端默认工作区"
          value={config.workDir || ''}
          onChange={(e) => onChange({ workDir: e.target.value })}
        />
      </div>
    </div>
  );
}
