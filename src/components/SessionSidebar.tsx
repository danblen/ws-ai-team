import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { modeIcon } from './EnvironmentPicker';
import { LogoIcon } from './LogoIcon';
import { useApp } from '../store/AppProvider';
import { getLlmConfig } from '../lib/llm-config';
import type { HealthInfo } from '../lib/types';
import type { EnvironmentConfig } from '../lib/env/types';

interface SessionItemProps {
  id: string;
  title: string;
  projectName?: string;
  mode: EnvironmentConfig['mode'];
  active: boolean;
  running: boolean;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/**
 * 单个会话项。用 memo + 稳定的回调隔离重渲染：
 * 流式运行期间父组件因 context 频繁更新，但各项 props（含 running 布尔值）不变，
 * 故列表不再整体 reconcile，滚动不卡。重命名的编辑态收敛在本组件内部。
 */
const SessionItem = memo(function SessionItem({
  id,
  title,
  projectName,
  mode,
  active,
  running,
  onSwitch,
  onDelete,
  onRename,
}: SessionItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startRename = () => {
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    onRename(id, draft);
    setEditing(false);
  };

  return (
    <div
      className={`session-item ${active ? 'active' : ''}`}
      onClick={() => onSwitch(id)}
    >
      {running && (
        <span className="session-status running">
          <span className="session-spinner" />
        </span>
      )}
      <span className="session-mode" title={`模式：${mode}`}>
        {modeIcon(mode)}
      </span>
      {editing ? (
        <input
          className="session-rename"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="session-info">
          {projectName && <span className="session-project">{projectName}</span>}
          <span
            className="session-title"
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
          >
            {title}
          </span>
        </div>
      )}
      <button
        className="session-del"
        title="删除会话"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(id);
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
});

interface Props {
  health: HealthInfo | null;
  onToggleSidebar: () => void;
  onOpenConfig: () => void;
  onOpenAuth: () => void;
}

export default function SessionSidebar({ health, onToggleSidebar, onOpenConfig, onOpenAuth }: Props) {
  const app = useApp();
  const { authEmail, logout } = app;
  const llmConfig = getLlmConfig();
  const configured = Boolean(llmConfig.apiKey);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭浮窗
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setUserMenuOpen(false);
    }
  }, []);
  useEffect(() => {
    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [userMenuOpen, handleClickOutside]);

  return (
    <aside className="sidebar">
      {/* 顶部：Logo + 收起按钮 */}
      <div className="sidebar-brand">
        <LogoIcon size={30} className="brand-logo" />
        <span className="brand-name">AI Team</span>
        <button className="icon-btn sidebar-toggle" title="收起侧栏" onClick={onToggleSidebar}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18L9 12L15 6" />
          </svg>
        </button>
      </div>

      <button className="new-session" onClick={app.newSession}>
        <span className="plus">＋</span> 新建会话
      </button>

      <div className="session-list">
        {app.sessions.map((s) => (
          <SessionItem
            key={s.id}
            id={s.id}
            title={s.title}
            projectName={s.projectName}
            mode={s.envConfig?.mode || 'local'}
            active={s.id === app.current.id}
            running={app.isRunning(s.id)}
            onSwitch={app.switchSession}
            onDelete={app.deleteSession}
            onRename={app.renameSession}
          />
        ))}
      </div>

      {/* 底部：连接状态 + 用户区域 */}
      <div className="sidebar-foot-area">
        <button
          type="button"
          className={`status-pill ${configured ? 'ok' : 'warn'}`}
          title={health ? `模型: ${llmConfig.model}\n服务: ${llmConfig.baseUrl}` : '无法连接后端服务'}
          onClick={onOpenConfig}
        >
          <span className="status-dot" />
          {health
            ? configured
              ? `已连接 · ${llmConfig.model}`
              : '未配置 API Key'
            : '后端未连接'}
        </button>
        {authEmail ? (
          <div className="user-btn-wrap" ref={menuRef}>
            <button
              className="btn ghost user-btn"
              onClick={() => setUserMenuOpen((v) => !v)}
              title="用户菜单"
            >
              👤 {authEmail}
            </button>
            {userMenuOpen && (
              <div className="user-menu-popup">
                <div className="user-menu-header">
                  <span className="user-menu-email">{authEmail}</span>
                  <span className="user-menu-label">已登录</span>
                </div>
                <div className="user-menu-divider" />
                <button className="user-menu-item logout" onClick={logout}>
                  退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <button className="btn ghost user-btn" onClick={onOpenAuth} title="登录 / 注册">
            登录 / 注册
          </button>
        )}
      </div>
    </aside>
  );
}
