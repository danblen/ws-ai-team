import { useMemo } from 'react';
import { useApp } from '../../store/AppProvider';
import ProjectPicker from '../ProjectPicker';

function fmtDate(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function OverviewTab() {
  const app = useApp();
  const s = app.current;

  const features = useMemo(() => {
    if (!s.summary) return [];
    return s.summary
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*•]/.test(l))
      .map((l) => l.replace(/^[-*•]\s?/, ''))
      .slice(0, 8);
  }, [s.summary]);

  const history = useMemo(
    () => s.messages.filter((m) => m.kind === 'user').map((m) => m.content),
    [s.messages],
  );

  const componentCount = s.files.filter((f) => /\.(jsx|tsx)$/.test(f.path)).length;
  const hasProject = s.files.length > 0;

  if (!hasProject && s.messages.length === 0) {
    return (
      <div className="tab-pane">
        <div className="pane-toolbar">
          <span className="pane-title">项目概览</span>
        </div>
        <div className="pane-body overview-body">
        <ProjectPicker />
        <div className="ov-empty-hint">
          <div className="pane-empty-glyph">📋</div>
          <p>项目概览</p>
          <span>在左侧描述你的需求，这里会汇总项目的产品说明、技术栈、历史工作与记忆。</span>
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="tab-pane">
      <div className="pane-toolbar">
        <span className="pane-title">项目概览</span>
        <span className="pane-sub">更新于 {fmtDate(s.updatedAt)}</span>
      </div>
      <div className="pane-body overview-body">
        <div className="ov-hero">
          <h2>{s.title}</h2>
          <div className="ov-badges">
            <span className="ov-badge">{s.framework === 'react' ? '⚛️ React + Vite' : '🌐 HTML'}</span>
            <span className="ov-badge">{s.files.length} 个文件</span>
            {componentCount > 0 && <span className="ov-badge">{componentCount} 个组件</span>}
            <span className={`ov-badge ${s.previewUrl ? 'ok' : ''}`}>
              {s.previewUrl ? '● 已构建' : '未构建'}
            </span>
          </div>
        </div>

        <div className="ov-grid">
          {s.messages.length === 0 && <ProjectPicker />}
          <section className="ov-card">
            <h3>产品描述</h3>
            {s.summary ? (
              <p className="ov-summary">{stripBullets(s.summary)}</p>
            ) : (
              <p className="ov-muted">尚无产品说明，发送一次需求即可由产品经理智能体生成。</p>
            )}
            {features.length > 0 && (
              <ul className="ov-features">
                {features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="ov-card">
            <h3>技术栈</h3>
            <ul className="ov-stack">
              <li>⚛️ React 18</li>
              <li>⚡ Vite 构建</li>
              <li>🎨 组件化 CSS</li>
              <li>🧠 多智能体协作生成</li>
            </ul>
          </section>

          <section className="ov-card">
            <h3>统计</h3>
            <div className="ov-stats">
              <div className="ov-stat">
                <strong>{history.length}</strong>
                <span>需求轮次</span>
              </div>
              <div className="ov-stat">
                <strong>{s.files.length}</strong>
                <span>文件</span>
              </div>
              <div className="ov-stat">
                <strong>{app.agents.filter((a) => a.enabled).length}</strong>
                <span>启用智能体</span>
              </div>
              <div className="ov-stat">
                <strong>{s.messages.length}</strong>
                <span>消息</span>
              </div>
            </div>
            <p className="ov-muted ov-created">创建于 {fmtDate(s.createdAt)}</p>
          </section>

          <section className="ov-card ov-card-wide">
            <h3>历史工作 / 记忆</h3>
            {history.length === 0 ? (
              <p className="ov-muted">还没有历史需求。</p>
            ) : (
              <ol className="ov-history">
                {history.map((h, i) => (
                  <li key={i}>
                    <span className="ov-step">{i + 1}</span>
                    <span className="ov-step-text">{h}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function stripBullets(text: string): string {
  const nonBullet = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*•]/.test(l));
  return nonBullet.join(' ') || text.trim();
}
