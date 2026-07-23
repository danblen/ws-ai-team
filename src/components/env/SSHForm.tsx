import type { SSHEnvConfig } from '../../lib/env/types';

interface Props {
  config: SSHEnvConfig;
  onChange: (patch: Partial<SSHEnvConfig>) => void;
}

export default function SSHForm({ config, onChange }: Props) {
  return (
    <div className="env-form">
      <div className="env-row">
        <div className="env-field grow">
          <label className="env-label">主机</label>
          <input
            className="env-input"
            placeholder="例如 47.98.x.x 或 ecs.example.com"
            value={config.host}
            onChange={(e) => onChange({ host: e.target.value })}
          />
        </div>
        <div className="env-field" style={{ width: 96 }}>
          <label className="env-label">端口</label>
          <input
            className="env-input"
            type="number"
            value={config.port}
            onChange={(e) => onChange({ port: Number(e.target.value) || 22 })}
          />
        </div>
      </div>

      <div className="env-field">
        <label className="env-label">用户名</label>
        <input
          className="env-input"
          placeholder="例如 root / ubuntu"
          value={config.username}
          onChange={(e) => onChange({ username: e.target.value })}
        />
      </div>

      <div className="env-field">
        <label className="env-label">认证方式</label>
        <div className="env-seg">
          <button
            type="button"
            className={`env-seg-btn ${config.authMethod === 'key' ? 'on' : ''}`}
            onClick={() => onChange({ authMethod: 'key' })}
          >
            私钥
          </button>
          <button
            type="button"
            className={`env-seg-btn ${config.authMethod === 'password' ? 'on' : ''}`}
            onClick={() => onChange({ authMethod: 'password' })}
          >
            密码
          </button>
        </div>
      </div>

      {config.authMethod === 'key' ? (
        <div className="env-field">
          <label className="env-label">私钥路径</label>
          <input
            className="env-input"
            placeholder="~/.ssh/id_rsa"
            value={config.privateKeyPath || ''}
            onChange={(e) => onChange({ privateKeyPath: e.target.value })}
          />
        </div>
      ) : (
        <div className="env-field">
          <label className="env-label">密码</label>
          <input
            className="env-input"
            type="password"
            placeholder="仅存后端，不会写入浏览器"
            value={config.password || ''}
            onChange={(e) => onChange({ password: e.target.value })}
          />
        </div>
      )}

      <div className="env-field">
        <label className="env-label">远程服务器上的 Agent CLI</label>
        <select
          className="env-input"
          value={config.cliId}
          onChange={(e) => onChange({ cliId: e.target.value })}
        >
          <option value="opencode">OpenCode CLI</option>
          <option value="claude">Claude Code CLI</option>
          <option value="aider">Aider</option>
        </select>
        <p className="env-hint">需已在远程服务器安装。Agent 只跑在远程，「选 Agent」= 选远程装了哪个 CLI。</p>
      </div>

      <div className="env-field">
        <label className="env-label">远程工作目录</label>
        <input
          className="env-input"
          placeholder="~/ai-team-workspace"
          value={config.remoteWorkDir}
          onChange={(e) => onChange({ remoteWorkDir: e.target.value })}
        />
      </div>
    </div>
  );
}
