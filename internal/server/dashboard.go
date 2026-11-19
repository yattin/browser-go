package server

import "net/http"

func (s *NodeServer) handleNodeDashboard(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(nodeDashboardHTML))
}

const nodeDashboardHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browser-Go Node Console — 工作节点控制台</title>
  <style>
    :root { --bg: #0b1120; --panel: #131c31; --border: #24324d; --text: #f1f5f9; --muted: #94a3b8; --accent: #38bdf8; --ok: #10b981; --danger: #ef4444; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); }
    header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 14px 28px; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 18px; color: var(--accent); }
    .toolbar { display: flex; gap: 10px; align-items: center; }
    input { background: #090e1a; color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-size: 13px; }
    button { background: #0284c7; color: #fff; border: none; border-radius: 6px; padding: 7px 13px; font-size: 13px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #1e293b; border: 1px solid var(--border); }
    button.takeover { background: rgba(56,189,248,0.18); color: #7dd3fc; border: 1px solid rgba(56,189,248,0.45); padding: 4px 10px; font-size: 12px; margin-right: 6px; }
    button.takeover:hover { background: #0284c7; color: #fff; }
    button.danger { background: rgba(239,68,68,0.2); color: #fca5a5; border: 1px solid rgba(239,68,68,0.4); padding: 4px 10px; font-size: 12px; }
    main { max-width: 1120px; margin: 22px auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 20px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
    .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .val { font-size: 28px; font-weight: 800; margin-top: 6px; }
    .section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
    h2 { margin: 0 0 12px; font-size: 15px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 12px; }
    .mono { font-family: monospace; }
    .empty { text-align: center; padding: 20px; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="node-title">Browser-Go Worker Node</h1>
    </div>
    <div class="toolbar">
      <input id="tok" type="password" placeholder="Access Token" />
      <button class="secondary" id="save-btn">保存令牌</button>
      <button id="ref-btn">立即刷新</button>
      <a href="/api-docs" style="color:var(--accent);font-size:13px;margin-left:8px;">API Docs ↗</a>
    </div>
  </header>
  <main>
    <div class="kpis">
      <div class="kpi"><div class="label">节点标识 (Node ID)</div><div class="val mono" id="k-id" style="font-size:20px;">-</div></div>
      <div class="kpi"><div class="label">本机运行实例 / 上限</div><div class="val" id="k-inst">- / -</div></div>
      <div class="kpi"><div class="label">剩余空闲槽位</div><div class="val" id="k-slots" style="color:var(--ok);">-</div></div>
      <div class="kpi"><div class="label">活跃 WebSocket / 扩展设备</div><div class="val" id="k-ws">- / -</div></div>
    </div>

    <div class="section">
      <h2>本机 Chrome 实例池 (Local Managed Browsers)</h2>
      <table>
        <thead><tr><th>会话标识</th><th>当前页面网址 (URL)</th><th>调试端口</th><th>活跃连接数</th><th>类型</th><th>空闲秒数</th><th style="text-align:right;">操作</th></tr></thead>
        <tbody id="inst-body"><tr><td colspan="7" class="empty">暂无实例</td></tr></tbody>
      </table>
    </div>

    <div class="section">
      <h2>已注册 Chrome 扩展设备 (Extension Relay Devices)</h2>
      <table>
        <thead><tr><th>Device ID</th><th>状态</th><th>共享标签页标题 / URL</th><th>最近心跳</th></tr></thead>
        <tbody id="dev-body"><tr><td colspan="4" class="empty">暂无连接中的扩展设备</td></tr></tbody>
      </table>
    </div>
  </main>
  <script>
    const tokEl = document.getElementById('tok');
    tokEl.value = localStorage.getItem('bg_node_token') || 'browser-go-token';
    const hdrs = () => tokEl.value.trim() ? { 'X-API-Token': tokEl.value.trim() } : {};

    async function load() {
      const [stR, lsR, dvR] = await Promise.all([
        fetch('/api/v1/browser/stats', { headers: hdrs() }),
        fetch('/api/v1/browser/list', { headers: hdrs() }),
        fetch('/api/v1/devices', { headers: hdrs() }),
      ]);
      if (!stR.ok) return;
      const st = (await stR.json()).data || {};
      const ls = (await lsR.json()).data || [];
      const dv = ((await dvR.json()).data || {}).devices || [];

      document.getElementById('k-id').textContent = st.node_id || '-';
      document.getElementById('k-inst').textContent = (st.current_instances ?? 0) + ' / ' + (st.max_instances ?? 0);
      document.getElementById('k-slots').textContent = st.available_slots ?? 0;
      document.getElementById('k-ws').textContent = (st.active_ws_connections ?? 0) + ' / ' + dv.length;

      const ib = document.getElementById('inst-body');
      ib.innerHTML = ls.length ? '' : '<tr><td colspan="7" class="empty">暂无活跃 Chrome 实例</td></tr>';
      const esc = (s) => String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      for (const it of ls) {
        const tr = document.createElement('tr');
        const curUrl = it.current_url || '-';
        const curTitle = it.current_title || '';
        tr.innerHTML = '<td class="mono">' + esc(it.user_id) + '</td>' +
          '<td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(curTitle ? (curTitle + ' — ' + curUrl) : curUrl) + '">' +
            '<div class="mono" style="color:var(--accent);overflow:hidden;text-overflow:ellipsis;">' + esc(curUrl) + '</div>' +
            (curTitle ? '<div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;">' + esc(curTitle) + '</div>' : '') +
          '</td>' +
          '<td class="mono">' + (it.debug_port || '-') + '</td><td>' + (it.active_conns || 0) + '</td><td>' + (it.ephemeral ? '临时' : '持久化') + '</td><td>' + it.idle_time_seconds + 's</td><td style="text-align:right;white-space:nowrap;"><button class="takeover">实时接管</button><button class="danger">停止</button></td>';
        tr.querySelector('.takeover').onclick = () => {
          if (window.BrowserGoLiveView) {
            window.BrowserGoLiveView.open({ userId: it.user_id, token: tokEl.value.trim() });
          }
        };
        tr.querySelector('.danger').onclick = async () => {
          await fetch('/api/v1/browser/stop?user_id=' + encodeURIComponent(it.user_id), { headers: hdrs() });
          load();
        };
        ib.appendChild(tr);
      }

      const db = document.getElementById('dev-body');
      db.innerHTML = dv.length ? '' : '<tr><td colspan="4" class="empty">暂无连接中的扩展设备</td></tr>';
      for (const d of dv) {
        const ti = d.connectionInfo?.targetInfo || {};
        const tr = document.createElement('tr');
        tr.innerHTML = '<td class="mono">' + d.deviceId + '</td><td>' + (d.isConnected ? '🟢 在线' : '🔴 离线') + '</td><td>' + (ti.title || '-') + ' <span class="mono" style="color:var(--muted);">' + (ti.url || '') + '</span></td><td>' + new Date(d.lastSeen).toLocaleTimeString() + '</td>';
        db.appendChild(tr);
      }
    }

    document.getElementById('save-btn').onclick = () => { localStorage.setItem('bg_node_token', tokEl.value.trim()); load(); };
    document.getElementById('ref-btn').onclick = load;
    load();
    setInterval(load, 3000);
  </script>
  <script src="/liveview.js"></script>
</body>
</html>`
