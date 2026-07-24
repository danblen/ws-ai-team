import { useEffect, useRef, useState } from 'react';
import type { RunMode } from '../lib/orchestrator';
import type { QueueItem } from '../store/AppProvider';

interface Props {
  streaming: boolean;
  canIterate: boolean;
  queue: QueueItem[];
  onRemoveQueued: (itemId: string) => void;
  onSubmit: (prompt: string, mode: RunMode) => void;
  onStop: () => void;
}

export default function PromptInput({
  streaming,
  canIterate,
  queue,
  onRemoveQueued,
  onSubmit,
  onStop,
}: Props) {
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }, [value]);

  // 运行中提交则入队（由父组件决定），空闲则直接发送。始终允许提交。
  const send = () => {
    const text = value.trim();
    if (!text) return;
    onSubmit(text, canIterate ? 'iterate' : 'replan');
    setValue('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      {queue.length > 0 && (
        <div className="queue-list">
          <div className="queue-label">
            <span className="queue-dot" /> 队列 · {queue.length} 条待执行
          </div>
          {queue.map((q, i) => (
            <div key={q.id} className="queue-item" title={q.text}>
              <span className="queue-index">{i + 1}</span>
              <span className="queue-text">{q.text}</span>
              <button
                className="queue-remove"
                title="从队列中移除"
                onClick={() => onRemoveQueued(q.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-box">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            streaming
              ? '继续输入将加入队列，前面的任务完成后自动执行… (Enter 入队)'
              : canIterate
                ? '继续描述新的需求，让智能体在当前项目上迭代…'
                : '描述你想要的应用，例如：做一个待办清单… (Enter 发送 / Shift+Enter 换行)'
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
        />
        {streaming ? (
          <div className="composer-actions">
            <button className="btn stop" onClick={onStop} title="停止生成">
              <span className="stop-icon" /> 停止
            </button>
          </div>
        ) : (
          <button className="btn send" onClick={send} disabled={!value.trim()} title="发送">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
              <path
                d="M20 12l-16-8 6 8-6 8 16-8z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="composer-hint">
        {streaming
          ? '任务进行中 · 新消息将排队，完成后自动依次执行'
          : '由 AI 智能体驱动 · 生成的应用经后端 Vite 构建后在右侧预览'}
      </div>
    </div>
  );
}
