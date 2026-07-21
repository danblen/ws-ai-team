import { useEffect, useRef, useState } from 'react';
import type { RunMode } from '../lib/orchestrator';

interface Props {
  streaming: boolean;
  canIterate: boolean;
  onSubmit: (prompt: string, mode: RunMode) => void;
  onStop: () => void;
}

export default function PromptInput({ streaming, canIterate, onSubmit, onStop }: Props) {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<RunMode>('iterate');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a max height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (!text || streaming) return;
    onSubmit(text, canIterate ? mode : 'replan');
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
      {canIterate && (
        <div className="mode-toggle" role="tablist" aria-label="生成模式">
          <button
            className={`mode-btn ${mode === 'iterate' ? 'active' : ''}`}
            onClick={() => setMode('iterate')}
            title="在当前项目基础上增量修改"
            disabled={streaming}
          >
            🔁 继续迭代
          </button>
          <button
            className={`mode-btn ${mode === 'replan' ? 'active' : ''}`}
            onClick={() => setMode('replan')}
            title="重新组织完整团队，从头规划"
            disabled={streaming}
          >
            🧭 重新规划
          </button>
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={taRef}
          className="composer-input"
          placeholder={
            canIterate
              ? '继续描述新的需求，让智能体在当前项目上迭代…'
              : '描述你想要的应用，例如：做一个待办清单… (Enter 发送 / Shift+Enter 换行)'
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={streaming}
        />
        {streaming ? (
          <button className="btn stop" onClick={onStop} title="停止生成">
            <span className="stop-icon" /> 停止
          </button>
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
        由 AI 智能体驱动 · 生成的应用经后端 Vite 构建后在右侧预览
      </div>
    </div>
  );
}
