import { useState } from 'react';
import { useApp } from '../store/AppProvider';
import { newAgentTemplate, EMOJI_CHOICES, COLOR_CHOICES } from '../lib/agents';
import type { AgentRole } from '../lib/types';

export default function AgentManager() {
  const app = useApp();
  const agents = app.agents;
  const [selectedId, setSelectedId] = useState<string>(agents[0]?.id ?? '');

  const selected = agents.find((a) => a.id === selectedId) || agents[0];

  const patch = (id: string, changes: Partial<AgentRole>) => {
    app.updateAgents(agents.map((a) => (a.id === id ? { ...a, ...changes } : a)));
  };

  const addAgent = () => {
    const a = newAgentTemplate();
    app.updateAgents([...agents, a]);
    setSelectedId(a.id);
  };

  const removeAgent = (id: string) => {
    const next = agents.filter((a) => a.id !== id);
    app.updateAgents(next);
    if (id === selectedId && next.length) setSelectedId(next[0].id);
  };

  const move = (id: string, dir: -1 | 1) => {
    const i = agents.findIndex((a) => a.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= agents.length) return;
    const next = [...agents];
    [next[i], next[j]] = [next[j], next[i]];
    app.updateAgents(next);
  };

  const reset = () => {
    app.resetAgents();
  };

  return (
    <div className="tab-pane">
      <div className="pane-toolbar">
        <span className="pane-title">👥 团队</span>
        <div className="pane-actions">
          <button className="btn ghost" onClick={reset}>恢复默认团队</button>
        </div>
      </div>
      <div className="pane-body" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="agents-body">
          <div className="agents-list">
            {agents.map((a, i) => (
              <div
                key={a.id}
                className={`agent-row ${a.id === selectedId ? 'active' : ''} ${a.enabled ? '' : 'off'}`}
                onClick={() => setSelectedId(a.id)}
              >
                <span className="agent-emoji" style={{ background: a.color + '22', color: a.color }}>
                  {a.emoji}
                </span>
                <div className="agent-row-text">
                  <span className="agent-row-name">
                    {a.name}
                    {a.producesCode && <span className="code-tag">代码</span>}
                  </span>
                  <span className="agent-row-goal">{a.goal}</span>
                </div>
                <div className="agent-row-ctl" onClick={(e) => e.stopPropagation()}>
                  <button className="mini" title="上移" onClick={() => move(a.id, -1)} disabled={i === 0}>↑</button>
                  <button className="mini" title="下移" onClick={() => move(a.id, 1)} disabled={i === agents.length - 1}>↓</button>
                  <label className="switch" title="启用/停用">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={(e) => patch(a.id, { enabled: e.target.checked })}
                    />
                    <span />
                  </label>
                </div>
              </div>
            ))}
            <button className="add-agent" onClick={addAgent}>＋ 添加智能体</button>
          </div>

          {selected && (
            <div className="agent-editor">
              <div className="field-row">
                <div className="field">
                  <label>名称</label>
                  <input value={selected.name} onChange={(e) => patch(selected.id, { name: e.target.value })} />
                </div>
                <div className="field grow">
                  <label>职责（一句话）</label>
                  <input value={selected.goal} onChange={(e) => patch(selected.id, { goal: e.target.value })} />
                </div>
              </div>

              <div className="field">
                <label>图标</label>
                <div className="emoji-picker">
                  {EMOJI_CHOICES.map((e) => (
                    <button
                      key={e}
                      className={selected.emoji === e ? 'sel' : ''}
                      onClick={() => patch(selected.id, { emoji: e })}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label>主题色</label>
                <div className="color-picker">
                  {COLOR_CHOICES.map((col) => (
                    <button
                      key={col}
                      className={selected.color === col ? 'sel' : ''}
                      style={{ background: col }}
                      onClick={() => patch(selected.id, { color: col })}
                    />
                  ))}
                </div>
              </div>

              <div className="field">
                <label>系统提示词（定义该角色的行为）</label>
                <textarea
                  rows={6}
                  value={selected.systemPrompt}
                  onChange={(e) => patch(selected.id, { systemPrompt: e.target.value })}
                />
              </div>

              <label className="check-line">
                <input
                  type="checkbox"
                  checked={selected.producesCode}
                  onChange={(e) => patch(selected.id, { producesCode: e.target.checked })}
                />
                该角色负责产出最终可运行代码（工程师）
              </label>

              <button className="del-agent" onClick={() => removeAgent(selected.id)} disabled={agents.length <= 1}>
                删除该智能体
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
