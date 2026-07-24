import { useCallback, useEffect, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import WorkspacePanel from './components/WorkspacePanel';
import SessionSidebar from './components/SessionSidebar';
import ConfigModal from './components/ConfigModal';
import AuthModal from './components/AuthModal';
import { fetchHealth, readLocalDirFiles } from './lib/api';
import { projectDirName } from './lib/storage';
import { useApp } from './store/AppProvider';
import type { HealthInfo, ProjectFile } from './lib/types';
import { APP_VERSION, BUILD_NUM } from './version';

export default function App() {
  const app = useApp();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [diskFiles, setDiskFiles] = useState<ProjectFile[]>([]);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const refreshHealth = useCallback(() => {
    fetchHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  const handleConfigClose = useCallback(() => {
    setConfigOpen(false);
    refreshHealth();
  }, [refreshHealth]);

  // 会话选定目录时直接用它；否则沿用「工作根目录/项目名」。
  const projectDir = app.current.workDir
    ? app.current.workDir
    : app.envConfig?.local?.workDir
      ? `${app.envConfig.local.workDir}/${projectDirName(app.current.title, app.current.id)}`
      : undefined;

  // 选定工作目录后即“打开”它：从磁盘读取该目录现有文件，让代码区在智能体尚未
  // 生成前就展示当前工作目录的代码。会话内已有（生成 / 已载入）文件时优先展示它们。
  const sid = app.current.id;
  const hasSessionFiles = app.current.files.length > 0;
  useEffect(() => {
    if (app.running || hasSessionFiles || !projectDir) {
      setDiskFiles([]);
      return;
    }
    let cancelled = false;
    readLocalDirFiles(sid, projectDir)
      .then((files) => { if (!cancelled) setDiskFiles(files); })
      .catch(() => { if (!cancelled) setDiskFiles([]); });
    return () => { cancelled = true; };
  }, [sid, projectDir, app.running, hasSessionFiles]);

  const displayFiles = app.running && app.liveFiles.length
    ? app.liveFiles
    : hasSessionFiles
      ? app.current.files
      : diskFiles;

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`}>
      <main className="workbench">
        {sidebarOpen ? (
          <SessionSidebar
            health={health}
            onToggleSidebar={() => setSidebarOpen(false)}
            onOpenConfig={() => setConfigOpen(true)}
            onOpenAuth={() => setAuthOpen(true)}
          />
        ) : (
          <button
            className="sidebar-expand"
            title="展开侧栏"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18L15 12L9 6" />
            </svg>
          </button>
        )}
        <ChatPanel />
        <WorkspacePanel
          files={displayFiles}
          activeTab={app.activeTab}
          onTabChange={app.setActiveTab}
          streaming={app.running}
          projectDir={projectDir}
        />
      </main>
      {configOpen && (
        <ConfigModal
          health={health}
          onClose={handleConfigClose}
        />
      )}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      <div className="version-tag">v{APP_VERSION}.b{BUILD_NUM}</div>
    </div>
  );
}
