import EnvironmentPicker from './EnvironmentPicker';
import { useApp } from '../store/AppProvider';
import type { HealthInfo } from '../lib/types';

interface Props {
  health: HealthInfo | null;
  agentCount: number;
  sidebarOpen: boolean;
  onOpenAgents: () => void;
  onToggleSidebar: () => void;
  onOpenConfig: () => void;
  onOpenAuth: () => void;
}

export default function Header({ health, agentCount, sidebarOpen, onOpenAgents, onToggleSidebar, onOpenConfig, onOpenAuth }: Props) {
  const { envConfig, setEnvConfig, authEmail, logout } = useApp();
  const configured = health?.configured;

  return (
    <header className="header">
      <div className="brand">
        <button className="icon-btn sidebar-toggle" title={sidebarOpen ? '收起侧栏' : '展开侧栏'} onClick={onToggleSidebar}>
          {sidebarOpen ? (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18L9 12L15 6"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18L15 12L9 6"/>
            </svg>
          )}
        </button>
        <div className="brand-logo" aria-hidden>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M12 2.5L21.1 7.8L21.1 18.2L12 23.5L2.9 18.2L2.9 7.8Z"/>
            <circle cx="12" cy="13" r="3.5" fill="currentColor" stroke="none"/>
          </svg>
        </div>
        <div className="brand-text">
          <span className="brand-name">AI Team</span>
        </div>
      </div>

      <div className="header-right">
        <EnvironmentPicker config={envConfig} onChange={setEnvConfig} />
        <button
          type="button"
          className={`status-pill ${configured ? 'ok' : 'warn'}`}
          title={
            health
              ? `模型: ${health.model}\n服务: ${health.baseUrl}`
              : '无法连接后端服务'
          }
          onClick={onOpenConfig}
        >
          <span className="status-dot" />
          {health
            ? configured
              ? `已连接 · ${health.model}`
              : '未配置 API Key'
            : '后端未连接'}
        </button>
        <button className="btn ghost" onClick={onOpenAgents} title="管理智能体团队">
          <span className="team-badge">{agentCount}</span> 智能体团队
        </button>
        {authEmail ? (
          <button className="btn ghost" onClick={logout} title="点击退出登录">
            👤 {authEmail} · 退出
          </button>
        ) : (
          <button className="btn ghost" onClick={onOpenAuth} title="登录 / 注册">
            登录 / 注册
          </button>
        )}
      </div>
    </header>
  );
}
