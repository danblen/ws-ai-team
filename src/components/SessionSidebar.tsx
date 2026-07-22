import { useState } from 'react';
import { useApp } from '../store/AppProvider';

export default function SessionSidebar() {
  const app = useApp();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (id: string, title: string) => {
    setEditingId(id);
    setDraft(title);
  };

  const commitRename = () => {
    if (editingId) app.renameSession(editingId, draft);
    setEditingId(null);
  };

  return (
    <aside className="sidebar">
      <button className="new-session" onClick={app.newSession}>
        <span className="plus">＋</span> 新建会话
      </button>

      <div className="session-list">
        {app.sessions.map((s) => {
          const active = s.id === app.current.id;
          const running = app.isRunning(s.id);
          const icon = running ? '' : s.files.length > 0 ? '🟢' : '💬';
          return (
            <div
              key={s.id}
              className={`session-item ${active ? 'active' : ''}`}
              onClick={() => app.switchSession(s.id)}
            >
              <span className="session-icon">
                {running ? <span className="session-spinner" /> : icon}
              </span>
              {editingId === s.id ? (
                <input
                  className="session-rename"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="session-info">
                  {s.projectName && (
                    <span className="session-project">{s.projectName}</span>
                  )}
                  <span
                    className="session-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(s.id, s.title);
                    }}
                  >
                    {s.title}
                  </span>
                </div>
              )}
              <button
                className="session-del"
                title="删除会话"
                onClick={(e) => {
                  e.stopPropagation();
                  app.deleteSession(s.id);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">双击标题可重命名</div>
    </aside>
  );
}
