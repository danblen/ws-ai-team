import { useCallback, useEffect, useState } from 'react';
import Header from './components/Header';
import ChatPanel from './components/ChatPanel';
import WorkspacePanel from './components/WorkspacePanel';
import SessionSidebar from './components/SessionSidebar';
import AgentManager from './components/AgentManager';
import ConfigModal from './components/ConfigModal';
import AuthModal from './components/AuthModal';
import { fetchHealth } from './lib/api';
import { projectDirName } from './lib/storage';
import { useApp } from './store/AppProvider';
import type { HealthInfo } from './lib/types';

export default function App() {
  const app = useApp();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  const displayFiles =
    app.running && app.liveFiles.length ? app.liveFiles : app.current.files;

  const projectDir = app.envConfig?.local?.workDir
    ? `${app.envConfig.local.workDir}/${projectDirName(app.current.title, app.current.id)}`
    : undefined;

  return (
    <div className={`app ${sidebarOpen ? '' : 'no-sidebar'}`}>
      <Header
        health={health}
        agentCount={app.agents.filter((a) => a.enabled).length}
        sidebarOpen={sidebarOpen}
        onOpenAgents={() => setManagerOpen(true)}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        onOpenConfig={() => setConfigOpen(true)}
        onOpenAuth={() => setAuthOpen(true)}
      />
      <main className="workbench">
        {sidebarOpen && <SessionSidebar />}
        <ChatPanel />
        <WorkspacePanel
          files={displayFiles}
          activeTab={app.activeTab}
          onTabChange={app.setActiveTab}
          streaming={app.running}
          projectDir={projectDir}
        />
      </main>
      {managerOpen && <AgentManager onClose={() => setManagerOpen(false)} />}
      {configOpen && (
        <ConfigModal
          health={health}
          onClose={handleConfigClose}
        />
      )}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
    </div>
  );
}
