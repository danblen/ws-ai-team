import { useState } from 'react';

type Status = 'disconnected' | 'connecting' | 'connected';

interface Provider {
  id: string;
  name: string;
  icon: string;
  desc: string;
}

const PROVIDERS: Provider[] = [
  { id: 'aiteam', name: 'AI Team Cloud', icon: '☁', desc: '托管静态应用与函数，零配置部署' },
  { id: 'vercel', name: 'Vercel', icon: '▲', desc: '前端应用与边缘函数部署平台' },
  { id: 'github', name: 'GitHub', icon: '🐙', desc: '同步代码仓库、创建 Pages' },
  { id: 'supabase', name: 'Supabase', icon: '⚡', desc: '数据库、认证与存储后端' },
];

export default function CloudTab() {
  const [status, setStatus] = useState<Status>('disconnected');
  const [active, setActive] = useState<Provider | null>(null);

  const connect = (p: Provider) => {
    setActive(p);
    setStatus('connecting');
    setTimeout(() => setStatus('connected'), 1200);
  };

  const disconnect = () => {
    setStatus('disconnected');
    setActive(null);
  };

  return (
    <div className="tab-pane">
      <div className="pane-toolbar">
        <span className="pane-title">云端连接</span>
        <span className={`cloud-badge ${status}`}>
          {status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '未连接'}
        </span>
      </div>

      <div className="pane-body cloud-body">
        {status === 'connected' && active ? (
          <div className="cloud-connected">
            <div className="cloud-connected-head">
              <span className="cloud-ico">{active.icon}</span>
              <div>
                <strong>{active.name}</strong>
                <p>连接成功，可以进行部署与资源管理。</p>
              </div>
            </div>
            <div className="cloud-ops">
              <button className="cloud-op">📦 部署当前应用</button>
              <button className="cloud-op">🗄 管理数据库</button>
              <button className="cloud-op">🔑 环境变量</button>
              <button className="cloud-op">📊 查看日志</button>
            </div>
            <button className="btn-ghost" onClick={disconnect}>断开连接</button>
          </div>
        ) : (
          <div className="cloud-grid">
            {PROVIDERS.map((p) => (
              <div key={p.id} className="cloud-card">
                <span className="cloud-ico">{p.icon}</span>
                <div className="cloud-info">
                  <strong>{p.name}</strong>
                  <span>{p.desc}</span>
                </div>
                <button
                  className="btn-connect"
                  disabled={status === 'connecting'}
                  onClick={() => connect(p)}
                >
                  {status === 'connecting' && active?.id === p.id ? '连接中…' : '连接'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
