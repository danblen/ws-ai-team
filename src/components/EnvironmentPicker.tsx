import { useState } from 'react';
import type { ReactNode } from 'react';
import type { EnvironmentConfig } from '../lib/env/types';
import EnvironmentConfigModal from './EnvironmentConfigModal';

interface Props {
  config: EnvironmentConfig;
  onChange: (config: EnvironmentConfig) => void;
  /** 锁定态：会话已开始后不允许切换模式。 */
  disabled?: boolean;
}

/** 简洁线性电脑图标（本地模式）。 */
const LocalIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);

/** 简洁线性锁图标（SSH 模式）。 */
const SSHIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const MODE_META: Record<EnvironmentConfig['mode'], { icon: ReactNode; label: string }> = {
  local: { icon: LocalIcon, label: '本地' },
  ssh: { icon: SSHIcon, label: 'SSH' },
  remote: { icon: '☁️', label: '云端' },
};

/** 当前环境摘要（picker 按钮上显示的一行小字）。 */
function summary(config: EnvironmentConfig): string {
  if (config.mode === 'local') {
    return config.local.engine === 'builtin' ? '内置团队' : `CLI · ${config.local.cliId}`;
  }
  if (config.mode === 'ssh') {
    return config.ssh.host ? `${config.ssh.username}@${config.ssh.host}` : '未配置主机';
  }
  return config.remote.url ? new URL(safeUrl(config.remote.url)).host : '未配置实例';
}

function safeUrl(url: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    return 'https://invalid';
  }
}

export default function EnvironmentPicker({ config, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const meta = MODE_META[config.mode];

  return (
    <>
      <button
        className={`env-picker${disabled ? ' is-locked' : ''}`}
        type="button"
        title={disabled ? '会话已开始，模式已锁定' : '切换执行环境（本地 / SSH / 云端）'}
        onClick={() => {
          if (!disabled) setOpen(true);
        }}
      >
        <span className="env-picker-icon">{meta.icon}</span>
        <span className="env-picker-text">
          <span className="env-picker-mode">{meta.label}</span>
          <span className="env-picker-summary">{summary(config)}</span>
        </span>
        {disabled && <span className="env-picker-lock" aria-hidden="true">🔒</span>}
      </button>

      {open && !disabled && (
        <EnvironmentConfigModal config={config} onSave={onChange} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

/** 模式对应的图标（供侧栏会话项徽标复用）。 */
export function modeIcon(mode: EnvironmentConfig['mode']): ReactNode {
  return MODE_META[mode].icon;
}

// 命名导出便于测试
export { summary as envSummary };
