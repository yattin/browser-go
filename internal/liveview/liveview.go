package liveview

import "net/http"

// ServeJS serves the self-contained WebRTC Live View + Chinese IME Proxy + Clipboard + Auto-Fallback UI component.
func ServeJS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(liveViewScript))
}

const liveViewScript = `(function() {
  if (window.BrowserGoLiveView) return;

  const style = document.createElement('style');
  style.textContent = [
    '#lv-backdrop { position: fixed; inset: 0; background: #202124; z-index: 9999; display: none; flex-direction: column; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #e8eaed; }',
    '#lv-backdrop.open { display: flex; }',
    '/* Row 1: Authentic Chrome Dark Tab Strip */',
    '#lv-tabstrip { display: flex; align-items: flex-end; height: 40px; padding: 6px 10px 0 10px; background: #202124; gap: 2px; user-select: none; }',
    '#lv-tabs-wrap { display: flex; align-items: flex-end; flex: 1; min-width: 0; }',
    '#lv-tabs { display: flex; align-items: flex-end; gap: 2px; flex: 0 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }',
    '#lv-tabs::-webkit-scrollbar { display: none; }',
    '.lv-tab { position: relative; display: flex; align-items: center; gap: 8px; height: 34px; min-width: 96px; max-width: 230px; flex: 0 1 210px; padding: 0 10px 0 12px; border-radius: 10px 10px 0 0; background: transparent; color: #9aa0a6; font-size: 12px; cursor: pointer; transition: background 0.12s, color 0.12s; }',
    '.lv-tab:not(.active)::after { content: ""; position: absolute; right: 0; top: 8px; bottom: 8px; width: 1px; background: #3c4043; }',
    '.lv-tab:not(.active):hover { background: #2b2d30; color: #e8eaed; }',
    '.lv-tab:not(.active):hover::after { opacity: 0; }',
    '.lv-tab.active { background: #35363a; color: #e8eaed; font-weight: 500; z-index: 2; }',
    '.lv-tab.active::before, .lv-tab.active::after { content: ""; position: absolute; bottom: 0; width: 10px; height: 10px; pointer-events: none; }',
    '.lv-tab.active::before { left: -10px; background: radial-gradient(circle at 0 0, transparent 10px, #35363a 10.5px); }',
    '.lv-tab.active::after { right: -10px; background: radial-gradient(circle at 10px 0, transparent 10px, #35363a 10.5px); }',
    '.lv-tab-icon { width: 14px; height: 14px; flex: 0 0 14px; display: flex; align-items: center; justify-content: center; color: #8ab4f8; }',
    '.lv-tab-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.lv-tab-close { width: 18px; height: 18px; flex: 0 0 18px; border-radius: 50%; border: none; background: transparent; color: #9aa0a6; font-size: 13px; line-height: 18px; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; }',
    '.lv-tab-close:hover { background: rgba(232,234,237,0.16); color: #fff; }',
    '#lv-newtab { width: 28px; height: 28px; margin: 0 6px 3px 4px; flex: 0 0 28px; border-radius: 50%; border: none; background: transparent; color: #bdc1c6; font-size: 18px; line-height: 28px; cursor: pointer; display: flex; align-items: center; justify-content: center; }',
    '#lv-newtab:hover { background: rgba(232,234,237,0.12); color: #fff; }',
    '#lv-win-right { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex-shrink: 0; }',
    '#lv-status { display: inline-flex; align-items: center; gap: 5px; height: 22px; font-size: 11px; font-weight: 500; padding: 0 8px; border-radius: 999px; background: rgba(129, 201, 149, 0.12); color: #81c995; border: 1px solid rgba(129, 201, 149, 0.22); white-space: nowrap; cursor: default; letter-spacing: 0.2px; }',
    '#lv-status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 6px currentColor; }',
    '#lv-close { width: 26px; height: 26px; padding: 0; border-radius: 50%; border: none; background: transparent; color: #9aa0a6; font-size: 14px; line-height: 26px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.12s, color 0.12s; }',
    '#lv-close:hover { background: #e81123; color: #fff; }',
    '/* Row 2: Authentic Chrome Omnibox Toolbar */',
    '#lv-navbar { display: flex; align-items: center; gap: 6px; height: 44px; padding: 0 10px; background: #35363a; border-bottom: 1px solid #202124; }',
    '.lv-nav-btn { width: 30px; height: 30px; border-radius: 50%; border: none; background: transparent; color: #e8eaed; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; flex-shrink: 0; transition: background 0.12s; }',
    '.lv-nav-btn:hover { background: rgba(232,234,237,0.12); }',
    '.lv-nav-btn:active { background: rgba(232,234,237,0.2); }',
    '.lv-nav-btn svg { width: 16px; height: 16px; fill: currentColor; }',
    '#lv-omnibox { flex: 1; min-width: 180px; height: 30px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-radius: 999px; background: #202124; border: 1.5px solid transparent; transition: border-color 0.12s, background 0.12s; }',
    '#lv-omnibox:hover { background: #282a2e; }',
    '#lv-omnibox:focus-within { background: #202124; border-color: #8ab4f8; }',
    '#lv-sec-icon { width: 14px; height: 14px; flex: 0 0 14px; color: #9aa0a6; display: flex; align-items: center; justify-content: center; }',
    '#lv-sec-icon.https { color: #81c995; }',
    '#lv-url { flex: 1; min-width: 0; border: none; outline: none; background: transparent; color: #e8eaed; font-size: 13px; font-family: inherit; }',
    '#lv-url::placeholder { color: #9aa0a6; }',
    '.lv-sep { width: 1px; height: 16px; background: rgba(255,255,255,0.12); margin: 0 2px; flex-shrink: 0; }',
    '#lv-res-wrap { position: relative; display: inline-flex; align-items: center; flex-shrink: 0; }',
    '#lv-res-wrap::after { content: ""; position: absolute; right: 9px; width: 10px; height: 10px; pointer-events: none; background: no-repeat center/10px 10px url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%239aa0a6\'%3E%3Cpath d=\'M7 10l5 5 5-5z\'/%3E%3C/svg%3E"); }',
    '#lv-res { appearance: none; -webkit-appearance: none; height: 28px; padding: 0 24px 0 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.08); background: rgba(232,234,237,0.07); color: #e8eaed; font-size: 12px; font-weight: 500; outline: none; cursor: pointer; transition: background 0.12s, border-color 0.12s; }',
    '#lv-res:hover { background: rgba(232,234,237,0.14); border-color: rgba(255,255,255,0.16); }',
    '#lv-res option { background: #292a2d; color: #e8eaed; }',
    '.lv-tool-btn { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid transparent; background: transparent; color: #e8eaed; font-size: 12px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: background 0.12s, color 0.12s; }',
    '.lv-tool-btn:hover { background: rgba(232,234,237,0.12); }',
    '.lv-tool-btn:active { background: rgba(232,234,237,0.2); }',
    '.lv-tool-btn svg { width: 14px; height: 14px; fill: currentColor; opacity: 0.85; }',
    '.lv-tool-btn.accent svg { color: #8ab4f8; opacity: 1; }',
    '#lv-handoff-bar { display: none; align-items: center; justify-content: space-between; gap: 12px; padding: 7px 14px; background: linear-gradient(90deg, rgba(245,158,11,0.18), rgba(217,119,6,0.12)); border-bottom: 1px solid rgba(245,158,11,0.45); color: #fde68a; font-size: 12.5px; }',
    '#lv-handoff-bar.show { display: flex; }',
    '#lv-handoff-resume { height: 26px; padding: 0 12px; border-radius: 999px; border: none; background: #10b981; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }',
    '#lv-handoff-resume:hover { background: #059669; }',
    '#lv-stage { flex: 1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #121316; cursor: default; user-select: none; }',
    '#lv-video, #lv-canvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; outline: none; display: none; }',
    '#lv-video.active, #lv-canvas.active { display: block; }',
    '#lv-ime { position: fixed; left: 20px; top: 88px; width: 2px; height: 20px; opacity: 0; pointer-events: none; resize: none; border: none; padding: 0; margin: 0; background: transparent; color: transparent; caret-color: transparent; z-index: 10001; }',
    '#lv-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(32, 33, 36, 0.96); border: 1px solid #8ab4f8; color: #e8eaed; padding: 8px 16px; border-radius: 999px; font-size: 12.5px; box-shadow: 0 8px 24px rgba(0,0,0,0.45); display: none; z-index: 10002; }'
  ].join('\n');
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'lv-backdrop';
  root.innerHTML = [
    '<div id="lv-tabstrip">',
    '  <div id="lv-tabs-wrap">',
    '    <div id="lv-tabs" role="tablist"></div>',
    '    <button id="lv-newtab" title="新建标签页 (Ctrl+T)">+</button>',
    '  </div>',
    '  <div id="lv-win-right">',
    '    <span id="lv-status" title="连接状态">连接中</span>',
    '    <button id="lv-close" title="退出接管">✕</button>',
    '  </div>',
    '</div>',
    '<div id="lv-navbar">',
    '  <button id="lv-back" class="lv-nav-btn" title="后退"><svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></button>',
    '  <button id="lv-fwd" class="lv-nav-btn" title="前进"><svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg></button>',
    '  <button id="lv-reload" class="lv-nav-btn" title="重新加载"><svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg></button>',
    '  <div id="lv-omnibox">',
    '    <span id="lv-sec-icon" title="页面连接状态"></span>',
    '    <input id="lv-url" type="text" spellcheck="false" autocomplete="off" placeholder="在远端 Chrome 中搜索或输入网址，按 Enter 跳转..." />',
    '  </div>',
    '  <div id="lv-res-wrap">',
    '    <select id="lv-res" title="切换远端浏览器视口分辨率">',
    '      <option value="auto">自适应</option>',
    '      <option value="1920x1080">1920×1080</option>',
    '      <option value="1440x900">1440×900</option>',
    '      <option value="1280x800">1280×800</option>',
    '      <option value="1280x720">1280×720</option>',
    '      <option value="390x844m">390×844 手机</option>',
    '    </select>',
    '  </div>',
    '  <span class="lv-sep"></span>',
    '  <button id="lv-paste-btn" class="lv-tool-btn accent" title="将文本直接注入远端当前焦点输入框"><svg viewBox="0 0 24 24"><path d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/></svg>文本</button>',
    '  <button id="lv-devtools-btn" class="lv-tool-btn" title="复制 Chrome 原生 DevTools 调试链接"><svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>DevTools</button>',
    '</div>',
    '<div id="lv-handoff-bar">',
    '  <span id="lv-handoff-text">🤖 Agent 正在等待人工协助...</span>',
    '  <button id="lv-handoff-resume">✓ 完成并交还 Agent</button>',
    '</div>',
    '<div id="lv-stage">',
    '  <video id="lv-video" autoplay playsinline muted></video>',
    '  <canvas id="lv-canvas"></canvas>',
    '</div>',
    '<textarea id="lv-ime" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>',
    '<div id="lv-toast"></div>'
  ].join('');
  document.body.appendChild(root);

  const videoEl = document.getElementById('lv-video');
  const canvasEl = document.getElementById('lv-canvas');
  const ctx2d = canvasEl.getContext('2d');
  const stageEl = document.getElementById('lv-stage');
  const imeEl = document.getElementById('lv-ime');
  const urlEl = document.getElementById('lv-url');
  const resEl = document.getElementById('lv-res');
  const secIconEl = document.getElementById('lv-sec-icon');
  resEl.value = localStorage.getItem('bg_lv_res') || 'auto';

  function applySelectedResolution(showFeedback = false) {
    const val = resEl.value || 'auto';
    let w = 1280, h = 800, mobile = false;
    if (val === 'auto') {
      w = Math.max(800, Math.min(1920, Math.floor((stageEl.clientWidth || 1280) / 2) * 2));
      h = Math.max(540, Math.min(1080, Math.floor((stageEl.clientHeight || 800) / 2) * 2));
    } else {
      mobile = val.endsWith('m');
      const parts = val.replace('m', '').split('x');
      w = parseInt(parts[0], 10) || 1280;
      h = parseInt(parts[1], 10) || 800;
    }
    deviceW = w;
    deviceH = h;
    sendReliable({ type: 'resize', width: w, height: h, mobile });
    if (showFeedback) {
      showToast('分辨率已切换为 ' + w + '×' + h + (mobile ? ' (手机)' : ''));
    }
  }
  const tabsEl = document.getElementById('lv-tabs');
  const statusEl = document.getElementById('lv-status');
  const toastEl = document.getElementById('lv-toast');
  const handoffBarEl = document.getElementById('lv-handoff-bar');
  const handoffTextEl = document.getElementById('lv-handoff-text');
  const handoffResumeBtn = document.getElementById('lv-handoff-resume');

  function updateHandoffBanner(ho) {
    if (ho && ho.status === 'waiting') {
      handoffTextEl.textContent = '🤖 Agent 请求人工接管：' + (ho.reason || '请完成操作后交还');
      handoffBarEl.classList.add('show');
    } else {
      handoffBarEl.classList.remove('show');
    }
  }

  handoffResumeBtn.onclick = async () => {
    if (!currentOpts) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (currentOpts.token) headers['X-API-Token'] = currentOpts.token;
      const res = await fetch('/api/v1/browser/handoff/resume', {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: currentOpts.userId, node_id: currentOpts.nodeId || '', note: 'Human completed via Live View' })
      });
      if (res.ok) {
        updateHandoffBanner(null);
        showToast('已交还控制权给 Agent，自动化任务继续执行');
      } else {
        showToast('交还失败: HTTP ' + res.status);
      }
    } catch (e) {
      showToast('交还请求异常: ' + e.message);
    }
  };

  const SVG_LOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/></svg>';
  const SVG_GLOBE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

  function updateOmniboxURL(rawUrl) {
    if (typeof rawUrl === 'string' && document.activeElement !== urlEl) {
      urlEl.value = rawUrl;
    }
    const u = urlEl.value || '';
    if (u.startsWith('https://')) {
      secIconEl.innerHTML = SVG_LOCK;
      secIconEl.className = 'https';
    } else {
      secIconEl.innerHTML = SVG_GLOBE;
      secIconEl.className = '';
    }
  }
  updateOmniboxURL('');

  const clientOS = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : (/Win/i.test(navigator.platform) ? 'windows' : 'linux');

  let sigWS = null;
  let pc = null;
  let dcRT = null;
  let dcRel = null;
  let dcVideo = null;
  let fallbackTimer = null;
  let inFallback = false;
  let currentOpts = null;
  let activeTargetId = '';
  let tabOrder = [];
  let deviceW = 1280;
  let deviceH = 800;
  let isComposing = false;
  let pendingMove = null;
  let rafScheduled = false;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toastEl.style.display = 'none'; }, 2200);
  }

  function setStatus(text, ok = true, detail = '') {
    statusEl.textContent = text;
    statusEl.title = detail || text;
    statusEl.style.color = ok ? '#81c995' : '#fdd663';
    statusEl.style.borderColor = ok ? 'rgba(129, 201, 149, 0.22)' : 'rgba(253, 214, 99, 0.28)';
    statusEl.style.background = ok ? 'rgba(129, 201, 149, 0.12)' : 'rgba(253, 214, 99, 0.10)';
  }

  function sendReliable(ev) {
    ev.clientOS = clientOS;
    if (!inFallback && dcRel && dcRel.readyState === 'open') {
      dcRel.send(JSON.stringify(ev));
      return;
    }
    if (sigWS && sigWS.readyState === WebSocket.OPEN) {
      sigWS.send(JSON.stringify({ type: 'input', input: ev }));
    }
  }

  function sendRealtime(ev) {
    ev.clientOS = clientOS;
    if (!inFallback && dcRT && dcRT.readyState === 'open') {
      dcRT.send(JSON.stringify(ev));
      return;
    }
    if (sigWS && sigWS.readyState === WebSocket.OPEN) {
      sigWS.send(JSON.stringify({ type: 'input', input: ev }));
    }
  }

  function mapCoords(clientX, clientY) {
    const activeEl = videoEl.classList.contains('active') ? videoEl : canvasEl;
    const rect = activeEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };

    const srcW = (activeEl === videoEl) ? (videoEl.videoWidth || deviceW) : (canvasEl.width || deviceW);
    const srcH = (activeEl === videoEl) ? (videoEl.videoHeight || deviceH) : (canvasEl.height || deviceH);
    const elemRatio = rect.width / rect.height;
    const mediaRatio = srcW / srcH;

    let renderW = rect.width;
    let renderH = rect.height;
    let offsetX = 0;
    let offsetY = 0;
    if (elemRatio > mediaRatio) {
      renderW = rect.height * mediaRatio;
      offsetX = (rect.width - renderW) / 2;
    } else {
      renderH = rect.width / mediaRatio;
      offsetY = (rect.height - renderH) / 2;
    }

    const relX = Math.max(0, Math.min(1, (clientX - rect.left - offsetX) / renderW));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top - offsetY) / renderH));
    return {
      x: Math.round(relX * deviceW * 10) / 10,
      y: Math.round(relY * deviceH * 10) / 10
    };
  }

  function getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  function btnName(b) {
    if (b === 1) return 'middle';
    if (b === 2) return 'right';
    return 'left';
  }

  function focusIMEAt(clientX, clientY) {
    imeEl.style.left = Math.max(8, Math.min(window.innerWidth - 20, clientX)) + 'px';
    imeEl.style.top = Math.max(50, Math.min(window.innerHeight - 30, clientY)) + 'px';
    imeEl.focus({ preventScroll: true });
  }

  async function renderBinaryJPEG(blobOrBuf) {
    try {
      const blob = blobOrBuf instanceof Blob ? blobOrBuf : new Blob([blobOrBuf], { type: 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      if (canvasEl.width !== bmp.width || canvasEl.height !== bmp.height) {
        canvasEl.width = bmp.width;
        canvasEl.height = bmp.height;
      }
      ctx2d.drawImage(bmp, 0, 0);
      bmp.close();
    } catch {}
  }

  function activateCanvas() {
    videoEl.classList.remove('active');
    canvasEl.classList.add('active');
  }

  function activateVideo() {
    canvasEl.classList.remove('active');
    videoEl.classList.add('active');
  }

  function triggerTunnelFallback(reason) {
    if (inFallback) return;
    inFallback = true;
    clearTimeout(fallbackTimer);
    activateCanvas();
    setStatus('隧道', false, 'ProxyForge 隧道保底 (' + reason + ')');
    if (sigWS && sigWS.readyState === WebSocket.OPEN) {
      sigWS.send(JSON.stringify({ type: 'fallback' }));
    }
  }

  function renderTabs(targets, activeId) {
    if (!Array.isArray(targets) || targets.length === 0) return;

    // Preserve Chrome's stable left-to-right tab order (prevent tabs jumping left when clicked)
    const byId = new Map();
    for (const t of targets) byId.set(t.id, t);
    tabOrder = tabOrder.filter((id) => byId.has(id));
    for (const t of targets) {
      if (!tabOrder.includes(t.id)) tabOrder.push(t.id);
    }

    tabsEl.innerHTML = '';
    const total = tabOrder.length;
    for (const id of tabOrder) {
      const t = byId.get(id);
      if (!t) continue;
      const isAct = (t.id === activeId);
      const tab = document.createElement('div');
      tab.className = 'lv-tab' + (isAct ? ' active' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', isAct ? 'true' : 'false');
      tab.dataset.targetId = t.id;
      tab.title = (t.title || '新标签页') + (t.url ? ('\n' + t.url) : '');

      const icon = document.createElement('span');
      icon.className = 'lv-tab-icon';
      icon.innerHTML = (t.url && t.url.startsWith('https://')) ? SVG_LOCK : SVG_GLOBE;

      const title = document.createElement('span');
      title.className = 'lv-tab-title';
      title.textContent = t.title || (t.url === 'about:blank' ? '新标签页' : (t.url || '新标签页'));

      tab.appendChild(icon);
      tab.appendChild(title);

      if (total > 1) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'lv-tab-close';
        closeBtn.title = '关闭标签页';
        closeBtn.textContent = '×';
        closeBtn.onclick = (e) => {
          e.stopPropagation();
          const idx = tabOrder.indexOf(t.id);
          const remainingIds = tabOrder.filter((x) => x !== t.id);
          if (remainingIds.length === 0) return;

          // Optimistically remove closed tab from UI immediately (0ms feedback)
          tabOrder = remainingIds;
          tab.remove();
          sendReliable({ type: 'closeTab', targetId: t.id });

          if (t.id === activeTargetId) {
            // Immediately switch to Chrome-style neighbor tab (right if available, else left)
            const nextIdx = Math.min(idx, remainingIds.length - 1);
            const nextId = remainingIds[Math.max(0, nextIdx)];
            if (nextId) {
              setTimeout(() => {
                if (activeTargetId === t.id) {
                  switchTarget(nextId);
                }
              }, 80);
            }
          }
        };
        tab.appendChild(closeBtn);
      }

      tab.onclick = () => {
        if (t.id !== activeTargetId) {
          switchTarget(t.id);
        }
      };

      if (isAct) {
        activeTargetId = t.id;
        updateOmniboxURL(t.url || '');
      }
      tabsEl.appendChild(tab);
    }
  }

  function teardownTransport() {
    clearTimeout(fallbackTimer);
    if (pc) {
      pc.onconnectionstatechange = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      try { pc.close(); } catch {}
      pc = null;
    }
    if (sigWS) {
      sigWS.onclose = null;
      sigWS.onmessage = null;
      sigWS.onerror = null;
      try { sigWS.close(); } catch {}
      sigWS = null;
    }
    dcRT = null; dcRel = null; dcVideo = null;
    inFallback = false;
  }

  function closeSession() {
    teardownTransport();
    videoEl.srcObject = null;
    activeTargetId = '';
    tabOrder = [];
    isComposing = false;
    imeEl.value = '';
    root.classList.remove('open');
    document.body.style.overflow = '';
  }

  function switchTarget(newTargetId) {
    if (!currentOpts || !newTargetId || newTargetId === activeTargetId) return;
    activeTargetId = newTargetId;
    openSession({ ...currentOpts, targetId: newTargetId }, true);
  }

  async function openSession(opts, keepOpen = false) {
    if (keepOpen) {
      teardownTransport();
    } else {
      closeSession();
      root.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
    currentOpts = opts;
    if (opts.targetId) activeTargetId = opts.targetId;
    setStatus(keepOpen ? '切页中' : '连接中', true, keepOpen ? '正在切换标签页...' : '正在协商 WebRTC...');

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('user_id', opts.userId);
    if (opts.nodeId) q.set('node_id', opts.nodeId);
    if (opts.targetId) q.set('target_id', opts.targetId);
    if (opts.token) q.set('token', opts.token);

    const sigUrl = wsProto + '//' + location.host + '/api/v1/browser/webrtc/signal?' + q.toString();
    sigWS = new WebSocket(sigUrl);
    sigWS.binaryType = 'arraybuffer';

    sigWS.onmessage = async (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        await renderBinaryJPEG(ev.data);
        return;
      }
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 'hello': {
          renderTabs(msg.targets || [], msg.activeTargetId);
          updateHandoffBanner(msg.handoff || null);

          pc = new RTCPeerConnection({ iceServers: msg.iceServers || [] });
          if (msg.videoMode === 'rtp') {
            pc.addTransceiver('video', { direction: 'recvonly' });
            pc.ontrack = (trackEv) => {
              if (trackEv.streams && trackEv.streams[0]) {
                videoEl.srcObject = trackEv.streams[0];
              } else {
                const ms = new MediaStream();
                ms.addTrack(trackEv.track);
                videoEl.srcObject = ms;
              }
              activateVideo();
              videoEl.play().catch(() => {});
            };
          } else {
            activateCanvas();
          }

          dcRT = pc.createDataChannel('input-rt', { ordered: false, maxRetransmits: 0 });
          dcRel = pc.createDataChannel('input-reliable', { ordered: true });
          dcRel.onopen = () => {
            applySelectedResolution(false);
          };
          dcRel.onmessage = (dcEv) => {
            try {
              const m = JSON.parse(dcEv.data);
              if (m.type === 'clipboard' && m.clipboardText) {
                navigator.clipboard?.writeText(m.clipboardText).catch(() => {});
                showToast('已复制远端文本 (' + m.clipboardText.length + ' 字符)');
              }
            } catch {}
          };

          if (msg.videoMode !== 'rtp') {
            dcVideo = pc.createDataChannel('video-dc', { ordered: false, maxRetransmits: 0 });
            dcVideo.binaryType = 'arraybuffer';
            dcVideo.onmessage = (vEv) => renderBinaryJPEG(vEv.data);
          }

          pc.onicecandidate = (iceEv) => {
            if (iceEv.candidate && sigWS && sigWS.readyState === WebSocket.OPEN) {
              sigWS.send(JSON.stringify({ type: 'candidate', candidate: iceEv.candidate.toJSON() }));
            }
          };

          pc.onconnectionstatechange = () => {
            if (!pc) return;
            if (pc.connectionState === 'connected') {
              clearTimeout(fallbackTimer);
              const shortLabel = msg.videoMode === 'rtp' ? ('H.264 ' + msg.fps + 'fps') : 'RTC';
              const fullDetail = 'WebRTC ' + (msg.videoMode === 'rtp' ? ('H.264 ' + msg.encoder) : 'DataChannel') + ' · ' + msg.fps + 'fps';
              setStatus(shortLabel, true, fullDetail);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
              triggerTunnelFallback('ICE断开');
            }
          };

          // 5-second automatic fallback to ProxyForge tunnel if corporate firewall blocks UDP/TURN
          fallbackTimer = setTimeout(() => {
            if (!pc || pc.connectionState !== 'connected') {
              triggerTunnelFallback('UDP受限');
            }
          }, 5000);

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sigWS.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
          focusIMEAt(window.innerWidth / 2, window.innerHeight / 2);
          break;
        }
        case 'answer':
          if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          break;
        case 'candidate':
          if (pc && msg.candidate) {
            try { await pc.addIceCandidate(msg.candidate); } catch {}
          }
          break;
        case 'meta':
          if (msg.deviceWidth > 0) deviceW = msg.deviceWidth;
          if (msg.deviceHeight > 0) deviceH = msg.deviceHeight;
          break;
        case 'nav':
          if (msg.url) {
            updateOmniboxURL(msg.url);
          }
          if (msg.switchTargetId && msg.switchTargetId !== activeTargetId) {
            if (Array.isArray(msg.targets) && msg.targets.length > 0) {
              renderTabs(msg.targets, msg.switchTargetId);
            }
            showToast('已自动切换到新标签页');
            openSession({ ...currentOpts, targetId: msg.switchTargetId }, true);
            break;
          }
          if (Array.isArray(msg.targets) && msg.targets.length > 0) {
            renderTabs(msg.targets, msg.activeTargetId || activeTargetId);
          }
          break;
        case 'handoff':
          updateHandoffBanner(msg.handoff || null);
          break;
        case 'clipboard':
          if (msg.clipboardText) {
            navigator.clipboard?.writeText(msg.clipboardText).catch(() => {});
            showToast('已复制远端文本 (' + msg.clipboardText.length + ' 字符)');
          }
          break;
        case 'error':
          setStatus('错误: ' + msg.error, false);
          showToast(msg.error);
          break;
      }
    };

    sigWS.onclose = () => {
      if (root.classList.contains('open')) {
        setStatus('连接已断开', false);
      }
    };
  }

  // --- Mouse & Wheel Events (Ordered Drag Pipeline + Shift 0.25x Precision Micro-Adjust) ---
  let isDragging = false;
  let dragLastPos = null;
  let dragVirtualPos = null;

  function computeDragPos(e) {
    const raw = mapCoords(e.clientX, e.clientY);
    if (!isDragging || !dragLastPos || !dragVirtualPos) {
      return raw;
    }
    const dx = raw.x - dragLastPos.x;
    const dy = raw.y - dragLastPos.y;
    dragLastPos = raw;
    // Holding Shift switches to 0.25x precision drag so slider puzzles align to the exact pixel
    const scale = e.shiftKey ? 0.25 : 1.0;
    dragVirtualPos = {
      x: Math.max(0, Math.min(deviceW, Math.round((dragVirtualPos.x + dx * scale) * 10) / 10)),
      y: Math.max(0, Math.min(deviceH, Math.round((dragVirtualPos.y + dy * scale) * 10) / 10))
    };
    return dragVirtualPos;
  }

  function flushMoveNow(evPayload, reliable) {
    pendingMove = null;
    if (reliable) {
      sendReliable({ type: 'mousemove', ...evPayload });
    } else {
      sendRealtime({ type: 'mousemove', ...evPayload });
    }
  }

  function handlePointerMove(e) {
    if (!root.classList.contains('open')) return;
    if (!isDragging && e.target !== stageEl && !stageEl.contains(e.target)) return;

    const dragging = isDragging || e.buttons !== 0;
    const pos = dragging ? computeDragPos(e) : mapCoords(e.clientX, e.clientY);
    pendingMove = { x: pos.x, y: pos.y, buttons: e.buttons, modifiers: getModifiers(e), reliable: dragging };
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (pendingMove) {
          const mv = pendingMove;
          flushMoveNow({ x: mv.x, y: mv.y, buttons: mv.buttons, modifiers: mv.modifiers }, mv.reliable);
        }
      });
    }
  }

  window.addEventListener('mousemove', handlePointerMove);

  stageEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pos = mapCoords(e.clientX, e.clientY);
    isDragging = true;
    dragLastPos = pos;
    dragVirtualPos = { x: pos.x, y: pos.y };
    // Send exact pre-press cursor position over the SAME ordered reliable channel before mousedown
    flushMoveNow({ x: pos.x, y: pos.y, buttons: 0, modifiers: getModifiers(e) }, true);
    sendReliable({ type: 'mousedown', x: pos.x, y: pos.y, button: btnName(e.button), buttons: e.buttons || 1, clickCount: e.detail || 1, modifiers: getModifiers(e) });
    focusIMEAt(e.clientX, e.clientY);
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const pos = computeDragPos(e);
    const mods = getModifiers(e);
    // Critical: flush final alignment mousemove strictly BEFORE mouseup on the same ordered channel!
    flushMoveNow({ x: pos.x, y: pos.y, buttons: 1, modifiers: mods }, true);
    sendReliable({ type: 'mouseup', x: pos.x, y: pos.y, button: btnName(e.button), buttons: 0, clickCount: e.detail || 1, modifiers: mods });
    isDragging = false;
    dragLastPos = null;
    dragVirtualPos = null;
  });

  stageEl.addEventListener('contextmenu', (e) => e.preventDefault());

  stageEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = mapCoords(e.clientX, e.clientY);
    sendRealtime({ type: 'wheel', x: pos.x, y: pos.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: getModifiers(e) });
  }, { passive: false });

  // --- Chinese / CJK IME Composition + Anti-Double-Typing + Cross-Platform Clipboard ---
  imeEl.addEventListener('compositionstart', () => {
    isComposing = true;
  });

  imeEl.addEventListener('compositionend', (e) => {
    isComposing = false;
    const committed = e.data || imeEl.value;
    imeEl.value = '';
    if (committed) {
      sendReliable({ type: 'insertText', text: committed });
    }
  });

  imeEl.addEventListener('paste', (e) => {
    e.preventDefault();
    const txt = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    imeEl.value = '';
    if (txt) {
      sendReliable({ type: 'insertText', text: txt });
      showToast('已粘贴 ' + txt.length + ' 字符到远端浏览器');
    }
  });

  imeEl.addEventListener('input', () => {
    // Safety net for mobile virtual keyboards, emoji pickers, or voice input
    if (!isComposing && imeEl.value) {
      const txt = imeEl.value;
      imeEl.value = '';
      sendReliable({ type: 'insertText', text: txt });
    }
  });

  imeEl.addEventListener('keydown', (e) => {
    // Block all raw keys while local OS IME (Pinyin/Wubi/Japanese/Korean) is composing
    if (isComposing || e.isComposing || e.keyCode === 229) return;

    const isAccel = clientOS === 'darwin' ? e.metaKey : e.ctrlKey;
    // Let native paste event handle Ctrl/Cmd+V without sending duplicate keydown
    if (isAccel && e.key.toLowerCase() === 'v') return;
    // Handle Ctrl/Cmd+C by requesting remote selection copy
    if (isAccel && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      sendReliable({ type: 'copy' });
      return;
    }

    e.preventDefault();
    const printableASCII = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.charCodeAt(0) < 128;
    sendReliable({
      type: 'keydown',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode || e.which || 0,
      text: printableASCII ? e.key : '',
      modifiers: getModifiers(e),
      autoRepeat: !!e.repeat
    });
  });

  imeEl.addEventListener('keyup', (e) => {
    if (isComposing || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendReliable({
      type: 'keyup',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode || e.which || 0,
      modifiers: getModifiers(e)
    });
  });

  // --- Toolbar Controls ---
  document.getElementById('lv-close').onclick = closeSession;
  document.getElementById('lv-back').onclick = () => sendReliable({ type: 'back' });
  document.getElementById('lv-fwd').onclick = () => sendReliable({ type: 'forward' });
  document.getElementById('lv-reload').onclick = () => sendReliable({ type: 'reload' });
  urlEl.addEventListener('focus', () => {
    setTimeout(() => { try { urlEl.select(); } catch {} }, 0);
  });
  urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const targetUrl = urlEl.value.trim();
      if (targetUrl) {
        sendReliable({ type: 'navigate', url: targetUrl });
      }
      urlEl.blur();
      focusIMEAt(window.innerWidth / 2, window.innerHeight / 2);
    } else if (e.key === 'Escape') {
      urlEl.blur();
      focusIMEAt(window.innerWidth / 2, window.innerHeight / 2);
    }
  });
  document.getElementById('lv-newtab').onclick = () => {
    sendReliable({ type: 'createTab', url: 'about:blank' });
  };
  resEl.addEventListener('change', () => {
    localStorage.setItem('bg_lv_res', resEl.value);
    applySelectedResolution(true);
  });
  document.getElementById('lv-paste-btn').onclick = () => {
    const txt = prompt('输入或粘贴要发送到远端当前焦点的文本（支持中文/密码/多行）:');
    if (txt) {
      sendReliable({ type: 'insertText', text: txt });
      focusIMEAt(window.innerWidth / 2, window.innerHeight / 2);
    }
  };
  document.getElementById('lv-devtools-btn').onclick = async () => {
    if (!currentOpts) return;
    const q = new URLSearchParams({ user_id: currentOpts.userId });
    if (currentOpts.nodeId) q.set('node_id', currentOpts.nodeId);
    if (activeTargetId) q.set('target_id', activeTargetId);
    if (currentOpts.token) q.set('token', currentOpts.token);
    const dtUrl = 'devtools://devtools/bundled/inspector.html?ws=' + location.host + '/api/v1/browser/attach?' + q.toString();
    try { await navigator.clipboard.writeText(dtUrl); } catch {}
    showToast('已复制 DevTools 链接，粘贴到 Chrome 地址栏即可调试');
  };

  window.BrowserGoLiveView = { open: openSession, close: closeSession };
})();
`
