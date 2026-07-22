import type { WorkTab } from '../store/AppProvider';
import type { ProjectFile } from '../lib/types';
import OverviewTab from './tabs/OverviewTab';
import PreviewTab from './tabs/PreviewTab';
import CodeTab from './tabs/CodeTab';
import CloudTab from './tabs/CloudTab';
import FilesTab from './tabs/FilesTab';
import TerminalTab from './tabs/TerminalTab';
import PublishTab from './tabs/PublishTab';
import AgentManager from './AgentManager';

interface Props {
  files: ProjectFile[];
  activeTab: WorkTab;
  streaming: boolean;
  projectDir?: string;
  onTabChange: (tab: WorkTab) => void;
}

const TABS: { id: WorkTab; label: string; icon: string }[] = [
  { id: 'overview', label: '概览', icon: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="1.5" y="1.5" width="12" height="5.5" rx="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="1.5" y="8.5" width="5.5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="8.5" y="8.5" width="5" height="5" rx="1.2" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>' },
  { id: 'preview', label: '预览', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>' },
  { id: 'code', label: '代码', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 4L2 8l4 4M10 4l4 4-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { id: 'cloud', label: '云端', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 11.5a3 3 0 01.5-5.5 3.5 3.5 0 016.6.3 2.5 2.5 0 01.4 5.2H4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none"/></svg>' },
  { id: 'files', label: '文件', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 13V3a1 1 0 011-1h4l4 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2v4h4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
  { id: 'terminal', label: '终端', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 12l5-4-5-4M9 12h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { id: 'publish', label: '发布', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4 6l4-4 4 4M2 12v2h12v-2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { id: 'team', label: '团队', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="5.5" cy="5" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/><circle cx="11" cy="5" r="2" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M1 14v-1a3.5 3.5 0 013.5-3.5h2A3.5 3.5 0 0110 13v1M9 14v-1a3 3 0 013-3h1a3 3 0 013 3v1" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>' },
];

export default function WorkspacePanel({ files, activeTab, streaming, projectDir, onTabChange }: Props) {
  return (
    <section className="workspace">
      <div className="workspace-bar">
        <div className="tabs wtabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => onTabChange(t.id)}
            >
              <span className="tab-ico" dangerouslySetInnerHTML={{ __html: t.icon }} />
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="workspace-body">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'preview' && <PreviewTab />}
        {activeTab === 'code' && <CodeTab files={files} streaming={streaming} projectDir={projectDir} />}
        {activeTab === 'cloud' && <CloudTab />}
        {activeTab === 'files' && <FilesTab onOpenInEditor={() => onTabChange('code')} />}
        {activeTab === 'terminal' && <TerminalTab />}
        {activeTab === 'publish' && <PublishTab />}
        {activeTab === 'team' && <AgentManager />}
      </div>
    </section>
  );
}
