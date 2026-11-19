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
    '#lv-backdrop { position: fixed; inset: 0; background: rgba(5, 10, 22, 0.92); backdrop-filter: blur(6px); z-index: 9999; display: none; flex-direction: column; font-family: system-ui, -apple-system, sans-serif; color: #f1f5f9; }',
    '#lv-backdrop.open { display: flex; }',
    '#lv-bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: #131c31; border-bottom: 1px solid #24324d; flex-wrap: wrap; }',
    '#lv-bar button { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; font-weight: 600; }',
    '#lv-bar button:hover { background: #334155; }',
    '#lv-bar button.primary { background: #0284c7; border-color: #0284c7; color: #fff; }',
    '#lv-bar button.close-btn { background: rgba(239,68,68,0.22); border-color: rgba(239,68,68,0.5); color: #fecaca; margin-left: auto; }',
    '#lv-bar button.close-btn:hover { background: #ef4444; color: #fff; }',
    '#lv-url { flex: 1; min-width: 220px; background: #090e1a; color: #f8fafc; border: 1px solid #334155; border-radius: 6px; padding: 6px 10px; font-size: 13px; }',
    '#lv-tabs { max-width: 220px; background: #090e1a; color: #f8fafc; border: 1px solid #334155; border-radius: 6px; padding: 5px 8px; font-size: 12.5px; }',
    '#lv-status { font-size: 11.5px; padding: 3px 9px; border-radius: 999px; background: rgba(16, 185, 129, 0.16); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35); white-space: nowrap; }',
    '#lv-stage { flex: 1; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #050811; cursor: default; user-select: none; }',
    '#lv-video, #lv-canvas { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; outline: none; display: none; }',
    '#lv-video.active, #lv-canvas.active { display: block; }',
    '#lv-ime { position: fixed; left: 20px; top: 60px; width: 2px; height: 20px; opacity: 0; pointer-events: none; resize: none; border: none; padding: 0; margin: 0; background: transparent; color: transparent; caret-color: transparent; z-index: 10001; }',
    '#lv-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: rgba(15, 23, 42, 0.95); border: 1px solid #38bdf8; color: #e0f2fe; padding: 8px 16px; border-radius: 8px; font-size: 13px; display: none; z-index: 10002; }'
  ].join('\n');
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'lv-backdrop';
  root.innerHTML = [
    '<div id="lv-bar">',
    '  <button id="lv-back" title="后退">←</button>',
    '  <button id="lv-fwd" title="前进">→</button>',
    '  <button id="lv-reload" title="刷新">↻</button>',
    '  <select id="lv-tabs" title="切换标签页"></select>',
    '  <input id="lv-url" type="text" placeholder="输入网址按 Enter 跳转..." />',
    '  <span id="lv-status">连接中...</span>',
    '  <button id="lv-paste-btn" class="primary" title="将文本直接注入远端当前焦点输入框">发送文本</button>',
    '  <button id="lv-devtools-btn" title="复制 Chrome 原生 DevTools 调试链接">DevTools</button>',
    '  <button id="lv-close" class="close-btn">退出接管</button>',
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
  const tabsEl = document.getElementById('lv-tabs');
  const statusEl = document.getElementById('lv-status');
  const toastEl = document.getElementById('lv-toast');

  const clientOS = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? 'darwin' : (/Win/i.test(navigator.platform) ? 'windows' : 'linux');

  let sigWS = null;
  let pc = null;
  let dcRT = null;
  let dcRel = null;
  let dcVideo = null;
  let fallbackTimer = null;
  let inFallback = false;
  let currentOpts = null;
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

  function setStatus(text, ok = true) {
    statusEl.textContent = text;
    statusEl.style.color = ok ? '#6ee7b7' : '#fcd34d';
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

    const srcW = (activeEl === videoEl && videoEl.videoWidth > 0) ? videoEl.videoWidth : (canvasEl.width || deviceW);
    const srcH = (activeEl === videoEl && videoEl.videoHeight > 0) ? videoEl.videoHeight : (canvasEl.height || deviceH);
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
      x: Math.round(relX * deviceW),
      y: Math.round(relY * deviceH)
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
    setStatus('ProxyForge 隧道保底 (' + reason + ')', false);
    if (sigWS && sigWS.readyState === WebSocket.OPEN) {
      sigWS.send(JSON.stringify({ type: 'fallback' }));
    }
  }

  function closeSession() {
    clearTimeout(fallbackTimer);
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (sigWS) { try { sigWS.close(); } catch {} sigWS = null; }
    dcRT = null; dcRel = null; dcVideo = null;
    videoEl.srcObject = null;
    inFallback = false;
    isComposing = false;
    imeEl.value = '';
    root.classList.remove('open');
  }

  async function openSession(opts) {
    closeSession();
    currentOpts = opts;
    root.classList.add('open');
    setStatus('正在协商 WebRTC...');

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
          // Populate tab selector
          tabsEl.innerHTML = '';
          for (const t of (msg.targets || [])) {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = (t.title || t.url || t.id).slice(0, 38);
            if (t.id === msg.activeTargetId) {
              opt.selected = true;
              urlEl.value = t.url || '';
            }
            tabsEl.appendChild(opt);
          }

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
              setStatus('WebRTC ' + (msg.videoMode === 'rtp' ? ('H.264 ' + msg.encoder) : 'DataChannel') + ' · ' + msg.fps + 'fps', true);
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

  // --- Mouse & Wheel Events (60Hz rAF coalescing for ultra-smooth cursor) ---
  stageEl.addEventListener('mousemove', (e) => {
    pendingMove = { ...mapCoords(e.clientX, e.clientY), buttons: e.buttons, modifiers: getModifiers(e) };
    if (!rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (pendingMove) {
          sendRealtime({ type: 'mousemove', ...pendingMove });
          pendingMove = null;
        }
      });
    }
  });

  stageEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pos = mapCoords(e.clientX, e.clientY);
    sendReliable({ type: 'mousedown', x: pos.x, y: pos.y, button: btnName(e.button), buttons: e.buttons, clickCount: e.detail || 1, modifiers: getModifiers(e) });
    focusIMEAt(e.clientX, e.clientY);
  });

  stageEl.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const pos = mapCoords(e.clientX, e.clientY);
    sendReliable({ type: 'mouseup', x: pos.x, y: pos.y, button: btnName(e.button), buttons: e.buttons, clickCount: e.detail || 1, modifiers: getModifiers(e) });
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
  urlEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendReliable({ type: 'navigate', url: urlEl.value.trim() });
      focusIMEAt(window.innerWidth / 2, window.innerHeight / 2);
    }
  });
  tabsEl.addEventListener('change', () => {
    if (currentOpts && tabsEl.value) {
      openSession({ ...currentOpts, targetId: tabsEl.value });
    }
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
    if (tabsEl.value) q.set('target_id', tabsEl.value);
    if (currentOpts.token) q.set('token', currentOpts.token);
    const dtUrl = 'devtools://devtools/bundled/inspector.html?ws=' + location.host + '/api/v1/browser/attach?' + q.toString();
    try { await navigator.clipboard.writeText(dtUrl); } catch {}
    showToast('已复制 DevTools 链接，粘贴到 Chrome 地址栏即可调试');
  };

  window.BrowserGoLiveView = { open: openSession, close: closeSession };
})();
`
