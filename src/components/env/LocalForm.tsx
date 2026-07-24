import type { AvailableAgent, LocalEnvConfig } from '../../lib/env/types';

interface Props {
  config: LocalEnvConfig;
  agents: AvailableAgent[]; // 本机检测到的 Agent
  loading: boolean;
  onChange: (patch: Partial<LocalEnvConfig>) => void;
}

export default function LocalForm({ config, agents, loading, onChange }: Props) {
  const cliAgents = agents.filter((a) => a.kind === 'cli');

  return (
    <div className="env-form">
      <div className="env-field">
        <label className="env-label">执行引擎</label>
        <div className="env-seg">
          <button
            type="button"
            className={`env-seg-btn ${config.engine === 'builtin' ? 'on' : ''}`}
            onClick={() => onChange({ engine: 'builtin' })}
          >
            内置智能体团队
          </button>
          <button
            type="button"
            className={`env-seg-btn ${config.engine === 'cli' ? 'on' : ''}`}
            onClick={() => onChange({ engine: 'cli' })}
          >
            本机 CLI Agent
          </button>
        </div>
        <p className="env-hint">
          {config.engine === 'builtin'
            ? '由 PM / 设计师 / 审查 / 工程师团队依次协作，走当前 LLM 管线。'
            : '把任务整体交给一个本机 CLI（如 Claude Code），它自主读写文件、产出真实工程。'}
        </p>
      </div>

      {config.engine === 'cli' && (
        <>
          <div className="env-field">
            <label className="env-label">选择本机 Agent</label>
            {loading ? (
              <p className="env-hint">正在检测本机已安装的 CLI…</p>
            ) : cliAgents.length === 0 ? (
              <p className="env-hint warn">
                未检测到可用的 CLI（claude / opencode / aider）。请先在终端安装其一。
              </p>
            ) : (
              <select
                className="env-input"
                value={config.cliId}
                onChange={(e) => onChange({ cliId: e.target.value })}
              >
                {cliAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.path ? ` · ${a.path}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        </>
      )}
    </div>
  );
}
