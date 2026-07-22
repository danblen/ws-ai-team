import { memo, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, LiveTurn } from '../lib/types';
import type { RunMode } from '../lib/orchestrator';
import { parseEngineerOutput } from '../lib/orchestrator';
import { EXAMPLES } from '../data/examples';
import PromptInput from './PromptInput';
import EnvironmentPicker from './EnvironmentPicker';
import { LogoIcon } from './LogoIcon';
import { useApp } from '../store/AppProvider';

function ChatPanel() {
  const app = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = app.current.messages;
  const isEmpty = messages.length === 0 && !app.running;
  const busy = app.running || app.building;
  // 会话开始后锁定模式（已发消息 / 运行中 / 已绑定项目）。
  const modeLocked = busy || messages.length > 0 || Boolean(app.current.projectLocked);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, app.live, app.error]);

  // 运行中提交的消息入队，空闲时直接执行。
  const handleSubmit = useCallback(
    (text: string, mode: RunMode) => {
      if (busy) app.enqueue(text, mode);
      else app.send(text, mode);
    },
    [busy, app],
  );

  return (
    <section className="chat">
      <div className="chat-topbar">
        <EnvironmentPicker config={app.envConfig} onChange={app.setEnvConfig} disabled={modeLocked} />
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {isEmpty ? (
          <EmptyState onPick={app.send} />
        ) : (
          <div className="messages">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}

            {app.live && <LiveBubble live={app.live} />}

            {app.error && (
              <div className="error-banner">
                <strong>出错了：</strong>
                {app.error}
              </div>
            )}
          </div>
        )}
      </div>

      <PromptInput
        streaming={busy}
        canIterate={app.current.files.length > 0}
        queue={app.queue}
        onRemoveQueued={app.removeQueued}
        onSubmit={handleSubmit}
        onStop={app.stop}
      />
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.kind === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
      </div>
    );
  }

  if (message.kind === 'system') {
    return (
      <div className="msg system">
        <div className="system-pill">
          <span className="orch-icon">🧠</span> Orchestrator · {message.content}
        </div>
      </div>
    );
  }

  // agent message
  const parsed = message.hasCode ? parseEngineerOutput(message.content) : null;
  const fileCount = parsed ? parsed.files.length : 0;
  const text = message.hasCode ? stripCode(message.content) : message.content;
  return (
    <div className="msg assistant">
      <div className="avatar ai" style={{ background: (message.color || '#5B9EFF') + '22', color: message.color }}>
        {message.emoji || '🤖'}
      </div>
      <div className="bubble">
        <div className="agent-head">
          <span className="agent-name" style={{ color: message.color }}>{message.agentName}</span>
        </div>
        <PlanView plan={text} />
        {fileCount > 0 && (
          <div className="code-chip done">
            <span className="check">✓</span> 已生成可运行应用 · {fileCount} 个文件
          </div>
        )}
      </div>
    </div>
  );
}

function LiveBubble({ live }: { live: LiveTurn }) {
  const { agent, content, phase } = live;
  const parsed = agent.producesCode ? parseEngineerOutput(content) : null;
  const fileCount = parsed ? parsed.files.length : 0;
  const text = agent.producesCode ? stripCode(content) : content;
  const badge = phase === 'thinking' ? '正在思考…' : agent.producesCode ? '正在编写代码…' : '正在协作…';

  return (
    <div className="msg assistant">
      <div className="avatar ai" style={{ background: agent.color + '22', color: agent.color }}>
        {agent.emoji}
      </div>
      <div className="bubble">
        <div className="agent-head">
          <span className="agent-name" style={{ color: agent.color }}>{agent.name}</span>
          <span className="typing-badge">
            {badge}
            <span className="dots"><i /><i /><i /></span>
          </span>
        </div>
        <PlanView plan={text} />
        {agent.producesCode && fileCount > 0 && (
          <div className="code-chip building">
            <span className="spinner" /> 生成应用中 · {fileCount} 个文件
          </div>
        )}
      </div>
    </div>
  );
}

function stripCode(raw: string): string {
  const i = raw.indexOf('```');
  return i >= 0 ? raw.slice(0, i).trim() : raw.trim();
}

function PlanView({ plan }: { plan: string }) {
  if (!plan) return null;
  const lines = plan.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="plan">
      {lines.map((line, i) => {
        const bullet = /^[-*•]\s?/.test(line);
        return (
          <p key={i} className={bullet ? 'plan-item' : 'plan-text'}>
            {bullet ? line.replace(/^[-*•]\s?/, '') : line}
          </p>
        );
      })}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  return (
    <div className="empty">
      <div className="empty-hero">
        <LogoIcon size={52} className="empty-mark" />
        <h1>多智能体协作，把想法变成应用</h1>
        <p>用一句话描述你想要的网页应用，产品、设计、评审、工程师智能体会依次协作，实时生成并预览。</p>
      </div>
      <div className="examples">
        <div className="examples-label">试试这些例子</div>
        <div className="examples-grid">
          {EXAMPLES.map((ex) => (
            <button key={ex.title} className="example-card" onClick={() => onPick(ex.prompt)}>
              <span className="example-icon">{ex.icon}</span>
              <span className="example-title">{ex.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// 侧栏展开/收起只改变 App 的 sidebarOpen（不在 Provider 里），
// ChatPanel 无 props，memo 后不会因父组件重渲染而重渲染，避免切换卡顿。
export default memo(ChatPanel);
