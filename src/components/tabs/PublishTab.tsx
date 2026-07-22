import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../../store/AppProvider';
import { humanSize } from '../../lib/files';
import { publishProject, getPublishInfo } from '../../lib/api';
import type { PublishTarget } from '../../lib/api';

type Phase = 'idle' | 'building' | 'done';

export default function PublishTab() {
  const app = useApp();
  const files = app.current.files;
  const sid = app.current.id;
  const hasFiles = files.length > 0;
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);

  // 远程模式发布到远端部署实例，链接才对外可访问；其余模式发到当前实例。
  const target: PublishTarget | undefined =
    app.envConfig.mode === 'remote' && app.envConfig.remote.url
      ? { base: app.envConfig.remote.url, token: app.envConfig.remote.token }
      : undefined;

  // 切换会话时复位，并查询该会话是否已发布过。
  useEffect(() => {
    setPhase('idle');
    setUrl('');
    setError(null);
    setCopied(false);
    let cancelled = false;
    getPublishInfo(sid, target)
      .then((info) => {
        if (!cancelled && info) {
          setUrl(info.url);
          setPhase('done');
        }
      })
      .catch(() => {
        /* 未发布或查询失败，保持 idle */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  const publish = useCallback(async () => {
    if (!hasFiles) return;
    setPhase('building');
    setError(null);
    setCopied(false);
    try {
      const res = await publishProject(
        sid,
        files,
        app.current.framework,
        app.current.title || 'AI Team App',
        target,
      );
      setUrl(res.url);
      setPhase('done');
    } catch (e) {
      setError((e as Error).message || '发布失败');
      setPhase('idle');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasFiles, sid, files, app.current.framework, app.current.title]);

  const copyLink = () => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => {
        /* 剪贴板不可用时忽略 */
      },
    );
  };

  const downloadProject = () => {
    // Bundle the project as a single readable text manifest.
    const manifest = files
      .map((f) => `/* ==== ${f.path} ==== */\n${f.content}`)
      .join('\n\n');
    const blob = new Blob([manifest], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${app.current.title || 'ai-team-project'}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="tab-pane">
      <div className="pane-toolbar">
        <span className="pane-title">发布网站</span>
      </div>
      <div className="pane-body publish-body">
        {!hasFiles ? (
          <div className="pane-empty">
            <div className="pane-empty-glyph">🚀</div>
            <p>还没有可发布的应用</p>
            <span>先在左侧描述需求，让智能体生成应用后即可一键发布。</span>
          </div>
        ) : (
          <div className="publish-card">
            <div className="publish-preview">
              <span className="publish-glyph">🚀</span>
              <strong>{app.current.title || 'AI Team App'}</strong>
              <span className="publish-hint">
                {app.current.framework === 'react' ? 'React 项目' : '单页应用'} · {files.length} 个文件 ·{' '}
                {humanSize(totalBytes)}
              </span>
            </div>

            {error && <p className="publish-error">⚠️ {error}</p>}

            {phase === 'done' ? (
              <div className="publish-result">
                <span className="publish-live">● 已上线</span>
                <a className="publish-url" href={url} target="_blank" rel="noreferrer">
                  {url}
                </a>
                <div className="publish-actions">
                  <button className="btn-primary" onClick={copyLink}>
                    {copied ? '已复制 ✓' : '复制链接'}
                  </button>
                  <a className="btn-ghost" href={url} target="_blank" rel="noreferrer">
                    打开
                  </a>
                  <button className="btn-ghost" onClick={publish}>
                    重新发布
                  </button>
                </div>
              </div>
            ) : (
              <div className="publish-actions">
                <button className="btn-primary" disabled={phase === 'building'} onClick={publish}>
                  {phase === 'building' ? '正在构建并发布…' : '一键发布'}
                </button>
                <button className="btn-ghost" disabled={phase === 'building'} onClick={downloadProject}>
                  下载源码
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
