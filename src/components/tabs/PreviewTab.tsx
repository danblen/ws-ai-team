import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../store/AppProvider';


export default function PreviewTab() {
  const app = useApp();
  const url = app.current.previewUrl || '';
  const building = app.building;
  const files = app.current.files || [];
  const canBuild = files.length > 0;
  const [reloadKey, setReloadKey] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Reload the iframe when a new build finishes.
  useEffect(() => {
    if (url) setReloadKey((k) => k + 1);
  }, [url]);

  const openInBrowser = () => {
    if (url) window.open(url, '_blank');
  };

  // 合并「预览 / 刷新」：有代码则用当前代码重新构建预览（无需等待对话完成），
  // 否则仅刷新已有预览；构建完成后强制刷新 iframe（即使 URL 未变化）。
  const previewOrRefresh = async () => {
    if (canBuild) {
      await app.previewNow();
      setReloadKey((k) => k + 1);
    } else if (url) {
      setReloadKey((k) => k + 1);
    }
  };

  return (
    <div className="tab-pane">
      <div className="pane-toolbar">
        <span className="pane-title">
          预览
          {url && <span className="preview-url-chip">{url}</span>}
        </span>
        <div className="pane-actions">
          <button
            className="icon-btn text"
            title={canBuild ? '用当前代码构建并预览' : '刷新预览'}
            disabled={building || (!canBuild && !url)}
            onClick={previewOrRefresh}
          >
            {building ? '构建中…' : '刷新'}
          </button>
          <button className="icon-btn" title="在浏览器打开" disabled={!url} onClick={openInBrowser}>
            ↗
          </button>
        </div>
      </div>
      <div className="pane-body preview-body">
        {url ? (
          <div className="preview-wrap">
            <iframe
              key={reloadKey}
              ref={frameRef}
              className="preview-frame"
              title="项目预览"
              src={url}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
            />
          </div>
        ) : (
          <div className="pane-empty">
            <div className="pane-empty-glyph">◱</div>
            <p>暂无预览</p>
            {canBuild ? (
              <>
                <span>已有代码，可直接构建预览，无需等待对话完成。</span>
                <button className="btn-primary" disabled={building} onClick={previewOrRefresh}>
                  {building ? '构建中…' : '构建并预览'}
                </button>
              </>
            ) : (
              <span>生成代码后即可在此预览。</span>
            )}
          </div>
        )}
        {building && (
          <div className="preview-live-tag">
            <span className="spinner" /> Vite 构建中…
          </div>
        )}
      </div>
    </div>
  );
}
