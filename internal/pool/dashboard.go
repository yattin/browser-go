package pool

import "net/http"

func (gw *Gateway) handleDashboard(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(poolDashboardHTML))
}

const poolDashboardHTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Browser-Go Pool Console — 分布式 CDP 浏览器池控制台</title>
  <style>
    :root {
      --bg: #0b1120;
      --panel: #131c31;
      --panel-hover: #192540;
      --border: #24324d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-dark: #0284c7;
      --ok: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }
    header {
      background: rgba(19, 28, 49, 0.92); backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border); padding: 14px 28px;
      display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 20;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .logo-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 12px var(--accent); }
    .brand h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0.2px; }
    .brand span { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: rgba(56, 189, 248, 0.15); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.3); }
    .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    input, select {
      background: #090e1a; color: var(--text); border: 1px solid var(--border);
      border-radius: 6px; padding: 7px 11px; font-size: 13px; outline: none;
    }
    input:focus, select:focus { border-color: var(--accent); }
    button {
      background: var(--accent-dark); color: #fff; border: none; border-radius: 6px;
      padding: 7px 13px; font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.15s;
    }
    button:hover { opacity: 0.9; }
    button.secondary { background: #1e293b; border: 1px solid var(--border); color: var(--text); }
    button.takeover { background: rgba(56, 189, 248, 0.18); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.45); padding: 4px 10px; font-size: 12px; margin-right: 6px; }
    button.takeover:hover { background: var(--accent-dark); color: #fff; }
    button.danger { background: rgba(239, 68, 68, 0.18); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.4); padding: 4px 10px; font-size: 12px; }
    button.danger:hover { background: var(--danger); color: #fff; }
    main { max-width: 1280px; margin: 22px auto; padding: 0 24px 48px; display: flex; flex-direction: column; gap: 22px; }
    .alert { padding: 11px 16px; border-radius: 8px; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #fecaca; font-size: 13px; display: none; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; }
    .kpi .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .kpi .val { font-size: 30px; font-weight: 800; margin-top: 6px; color: var(--text); }
    .kpi .sub { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .bar-bg { height: 6px; background: #090e1a; border-radius: 999px; overflow: hidden; margin-top: 8px; }
    .bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); width: 0%; transition: width 0.3s ease; }
    .section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .section-hdr { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .section-hdr h2 { margin: 0; font-size: 16px; font-weight: 700; }
    .nodes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 14px; }
    .node-card { background: #0d1526; border: 1px solid var(--border); border-radius: 10px; padding: 15px 16px; transition: border-color 0.15s; }
    .node-card:hover { border-color: #3b527e; }
    .node-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .node-name { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
    .dot.ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.bad { background: var(--danger); }
    .badge-src { font-size: 11px; padding: 2px 7px; border-radius: 4px; background: #1e293b; color: #cbd5e1; font-family: monospace; }
    .node-metrics { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); margin: 8px 0; }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .tag {
      font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: pointer;
      background: rgba(56, 189, 248, 0.12); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .tag:hover { background: rgba(56, 189, 248, 0.28); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .empty { text-align: center; padding: 26px; color: var(--muted); font-size: 13px; }
    .builder-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .field input { width: 100%; }
    pre {
      background: #070b14; border: 1px solid var(--border); border-radius: 8px;
      padding: 14px; overflow-x: auto; font-size: 12.5px; line-height: 1.5; color: #e2e8f0; margin: 0;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="logo-dot"></div>
      <h1>Browser-Go Pool Console</h1>
      <span>ProxyForge Tunnel Edition</span>
    </div>
    <div class="toolbar">
      <input id="token-input" type="password" placeholder="Access Token (X-API-Token)" style="width: 200px;" />
      <button class="secondary" id="save-token-btn">保存令牌</button>
      <button class="secondary" id="toggle-auto-btn">自动刷新: 开 (3s)</button>
      <button id="refresh-btn">立即刷新</button>
    </div>
  </header>

  <main>
    <div id="err-banner" class="alert"></div>

    <div class="kpis">
      <div class="kpi">
        <div class="label">健康穿透节点 / 总节点</div>
        <div class="val" id="kpi-nodes">- / -</div>
        <div class="sub">支持内置 Bridge 与静态后端混合编排</div>
      </div>
      <div class="kpi">
        <div class="label">全池运行实例 / 总并发上限</div>
        <div class="val" id="kpi-instances">- / -</div>
        <div class="bar-bg"><div class="bar-fill" id="kpi-bar"></div></div>
      </div>
      <div class="kpi">
        <div class="label">剩余空闲槽位 (Available Slots)</div>
        <div class="val" id="kpi-slots" style="color: var(--ok);">-</div>
        <div class="sub">槽位满载自动进入平滑等待队列</div>
      </div>
      <div class="kpi">
        <div class="label">实时活跃 CDP WebSocket 流</div>
        <div class="val" id="kpi-ws" style="color: var(--accent);">-</div>
        <div class="sub" id="kpi-updated">等待首次同步...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-hdr">
        <h2>内网穿透节点矩阵 (Penetrated Worker Nodes)</h2>
        <span style="font-size: 12px; color: var(--muted);">点击节点标签可自动填入下方连接生成器</span>
      </div>
      <div id="nodes-container" class="nodes-grid">
        <div class="empty">加载中...</div>
      </div>
    </div>

    <div class="section">
      <div class="section-hdr">
        <h2>全池活跃浏览器会话 (Active Chrome Instances)</h2>
      </div>
      <div style="overflow-x: auto;">
        <table>
          <thead>
            <tr>
              <th>所属内网节点 (Node ID)</th>
              <th>会话标识 (User / Ephemeral ID)</th>
              <th>最近活跃时间</th>
              <th>空闲时长</th>
              <th style="text-align: right;">操作</th>
            </tr>
          </thead>
          <tbody id="instances-tbody">
            <tr><td colspan="5" class="empty">暂无运行中的浏览器实例</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-hdr">
        <h2>CDP 浏览器池连接代码生成器 (Playwright / Puppeteer)</h2>
        <button class="secondary" id="copy-code-btn">复制代码</button>
      </div>
      <div class="builder-grid">
        <div class="field">
          <label>节点标签筛选 (Tags, 如 region:shanghai)</label>
          <input id="b-tags" type="text" placeholder="留空则全池自动选取最空闲节点" />
        </div>
        <div class="field">
          <label>持久化用户目录 ID (launch.user, 可选)</label>
          <input id="b-user" type="text" placeholder="如 alice (跨次连接固定路由至同一节点)" />
        </div>
        <div class="field">
          <label>初始打开网址 (startingUrl)</label>
          <input id="b-url" type="text" value="https://example.com" />
        </div>
      </div>
      <pre id="code-preview"></pre>
    </div>
  </main>

  <script>
    const tokenInput = document.getElementById('token-input');
    const errBanner = document.getElementById('err-banner');
    let autoRefresh = true;

    tokenInput.value = localStorage.getItem('bg_pool_token') || 'browser-go-token';

    function getHeaders() {
      const t = tokenInput.value.trim();
      return t ? { 'X-API-Token': t } : {};
    }

    function showError(msg) {
      if (!msg) {
        errBanner.style.display = 'none';
        return;
      }
      errBanner.textContent = msg;
      errBanner.style.display = 'block';
    }

    function updateSnippet() {
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tok = tokenInput.value.trim() || '<YOUR_TOKEN>';
      const tags = document.getElementById('b-tags').value.trim();
      const user = document.getElementById('b-user').value.trim();
      const sUrl = document.getElementById('b-url').value.trim() || 'https://example.com';

      const params = new URLSearchParams();
      params.set('token', tok);
      params.set('startingUrl', sUrl);
      if (tags) params.set('tags', tags);
      if (user) params.set('launch', JSON.stringify({ user }));

      const fullWS = wsProto + '//' + location.host + '/?' + params.toString();
      document.getElementById('code-preview').textContent = [
        "import { chromium } from 'playwright';",
        "",
        "const browser = await chromium.connectOverCDP(" + JSON.stringify(fullWS) + ");",
        "const context = browser.contexts()[0] || await browser.newContext();",
        "const page = context.pages()[0] || await context.newPage();",
        "console.log('Connected page title:', await page.title());",
        "await browser.close();"
      ].join('\n');
    }

    async function stopInstance(nodeId, userId) {
      try {
        const q = new URLSearchParams({ user_id: userId, node_id: nodeId });
        const res = await fetch('/api/v1/browser/stop?' + q.toString(), { headers: getHeaders() });
        const data = await res.json();
        if (!res.ok || data.code !== 0) {
          showError('停止实例失败: ' + (data.msg || res.statusText));
        } else {
          await refreshAll();
        }
      } catch (e) {
        showError('请求异常: ' + e.message);
      }
    }

    async function refreshAll() {
      updateSnippet();
      try {
        const [statsRes, nodesRes, listRes] = await Promise.all([
          fetch('/api/v1/browser/stats', { headers: getHeaders() }),
          fetch('/api/v1/pool/nodes', { headers: getHeaders() }),
          fetch('/api/v1/browser/list', { headers: getHeaders() }),
        ]);

        if (statsRes.status === 401 || statsRes.status === 403) {
          showError('鉴权失败 (' + statsRes.status + ')：请在右上角输入正确的 Access Token 后点击「保存令牌」。');
          return;
        }
        showError('');

        const statsJson = await statsRes.json();
        const nodesJson = await nodesRes.json();
        const listJson = await listRes.json();

        const st = statsJson.data || {};
        const nodes = nodesJson.data || [];
        const instances = listJson.data || [];

        let activeWS = 0;
        for (const n of nodes) activeWS += (n.active_ws || 0);

        document.getElementById('kpi-nodes').textContent = (st.healthy_nodes ?? 0) + ' / ' + (st.total_nodes ?? 0);
        document.getElementById('kpi-instances').textContent = (st.current_instances ?? 0) + ' / ' + (st.max_instances ?? 0);
        document.getElementById('kpi-slots').textContent = st.available_slots ?? 0;
        document.getElementById('kpi-ws').textContent = activeWS;
        document.getElementById('kpi-updated').textContent = '最后同步: ' + new Date().toLocaleTimeString();

        const pct = st.max_instances > 0 ? Math.min(100, Math.round((st.current_instances / st.max_instances) * 100)) : 0;
        document.getElementById('kpi-bar').style.width = pct + '%';

        const nc = document.getElementById('nodes-container');
        if (nodes.length === 0) {
          nc.innerHTML = '<div class="empty" style="grid-column: 1 / -1;">暂无已穿透注册的内网节点（启动 browser-go node --pf-bridge=... 即可自动加入）</div>';
        } else {
          nc.innerHTML = '';
          for (const n of nodes) {
            const card = document.createElement('div');
            card.className = 'node-card';
            const usedPct = n.max_instances > 0 ? Math.min(100, Math.round((n.current_instances / n.max_instances) * 100)) : 0;
            const tagsObj = n.tags || {};
            const tagPills = Object.entries(tagsObj).map(([k, v]) =>
              '<span class="tag" data-tag="' + k + ':' + v + '">' + k + '=' + v + '</span>'
            ).join('');

            card.innerHTML =
              '<div class="node-top">' +
                '<div class="node-name"><span class="dot ' + (n.healthy ? 'ok' : 'bad') + '"></span>' + n.node_id + '</div>' +
                '<span class="badge-src">' + n.source + '</span>' +
              '</div>' +
              '<div class="node-metrics">' +
                '<span>槽位: <strong>' + n.current_instances + ' / ' + n.max_instances + '</strong> (余 ' + n.available_slots + ')</span>' +
                '<span>RTT: <strong>' + n.rtt_ms + ' ms</strong> · WS: ' + n.active_ws + '</span>' +
              '</div>' +
              '<div class="bar-bg"><div class="bar-fill" style="width:' + usedPct + '%"></div></div>' +
              (tagPills ? '<div class="tags">' + tagPills + '</div>' : '');

            card.querySelectorAll('.tag').forEach(el => {
              el.addEventListener('click', () => {
                document.getElementById('b-tags').value = el.getAttribute('data-tag');
                updateSnippet();
              });
            });
            nc.appendChild(card);
          }
        }

        const tbody = document.getElementById('instances-tbody');
        if (instances.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty">当前全池无活跃浏览器实例</td></tr>';
        } else {
          tbody.innerHTML = '';
          for (const item of instances) {
            const tr = document.createElement('tr');
            tr.innerHTML =
              '<td class="mono">' + item.node_id + '</td>' +
              '<td class="mono">' + item.user_id + '</td>' +
              '<td>' + new Date(item.last_activity).toLocaleString() + '</td>' +
              '<td>' + item.idle_time_seconds + 's</td>' +
              '<td style="text-align:right;white-space:nowrap;"><button class="takeover">实时接管</button><button class="danger">强制销毁</button></td>';
            tr.querySelector('.takeover').addEventListener('click', () => {
              if (window.BrowserGoLiveView) {
                window.BrowserGoLiveView.open({ userId: item.user_id, nodeId: item.node_id, token: tokenInput.value.trim() });
              }
            });
            tr.querySelector('.danger').addEventListener('click', () => stopInstance(item.node_id, item.user_id));
            tbody.appendChild(tr);
          }
        }
      } catch (e) {
        showError('无法连接池网关接口: ' + e.message);
      }
    }

    document.getElementById('save-token-btn').addEventListener('click', () => {
      localStorage.setItem('bg_pool_token', tokenInput.value.trim());
      refreshAll();
    });
    document.getElementById('refresh-btn').addEventListener('click', refreshAll);
    document.getElementById('toggle-auto-btn').addEventListener('click', (ev) => {
      autoRefresh = !autoRefresh;
      ev.target.textContent = '自动刷新: ' + (autoRefresh ? '开 (3s)' : '关');
    });
    ['b-tags', 'b-user', 'b-url'].forEach(id => {
      document.getElementById(id).addEventListener('input', updateSnippet);
    });
    document.getElementById('copy-code-btn').addEventListener('click', async (ev) => {
      await navigator.clipboard.writeText(document.getElementById('code-preview').textContent);
      const orig = ev.target.textContent;
      ev.target.textContent = '已复制!';
      setTimeout(() => { ev.target.textContent = orig; }, 1200);
    });

    refreshAll();
    setInterval(() => { if (autoRefresh) refreshAll(); }, 3000);
  </script>
  <script src="/liveview.js"></script>
</body>
</html>`
