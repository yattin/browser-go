package server

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pionwebrtc "github.com/pion/webrtc/v4"
	"go.yaml.in/yaml/v3"

	browsergo "browser-go"
	"browser-go/internal/cdpbridge"
	"browser-go/internal/chrome"
	"browser-go/internal/config"
	"browser-go/internal/liveview"
	"browser-go/internal/logger"
	bgwebrtc "browser-go/internal/webrtc"
	"browser-go/internal/wsutil"
)

type inprocAddr string

func (a inprocAddr) Network() string { return "inproc" }
func (a inprocAddr) String() string  { return string(a) }

type memListener struct {
	ch     chan net.Conn
	closed chan struct{}
	once   sync.Once
}

func newMemListener() *memListener {
	return &memListener{
		ch:     make(chan net.Conn, 128),
		closed: make(chan struct{}),
	}
}

func (m *memListener) Accept() (net.Conn, error) {
	select {
	case c := <-m.ch:
		return c, nil
	case <-m.closed:
		return nil, net.ErrClosed
	}
}

func (m *memListener) Close() error {
	m.once.Do(func() {
		close(m.closed)
	})
	return nil
}

func (m *memListener) Addr() net.Addr {
	return inprocAddr("127.0.0.1:0")
}

func (m *memListener) Dial() (net.Conn, error) {
	select {
	case <-m.closed:
		return nil, net.ErrClosed
	default:
	}
	c1, c2 := net.Pipe()
	select {
	case m.ch <- c1:
		return c2, nil
	case <-m.closed:
		_ = c1.Close()
		_ = c2.Close()
		return nil, net.ErrClosed
	}
}

// NodeServer serves Browser-Go's HTTP REST API, OpenAPI docs, Chrome launch CDP proxy, and Extension relay.
type NodeServer struct {
	cfg       config.NodeConfig
	log       *logger.Logger
	chromeMgr *chrome.Manager
	devMgr    *cdpbridge.DeviceManager
	bridge    *cdpbridge.Bridge

	httpSrv   *http.Server
	tcpLn     net.Listener
	memLn     *memListener
	openAPIJS []byte

	ActiveWSConns atomic.Int32
}

func NewNodeServer(cfg config.NodeConfig, log *logger.Logger, chromeMgr *chrome.Manager) *NodeServer {
	if log == nil {
		log = logger.Default()
	}
	devMgr := cdpbridge.NewDeviceManager(log)
	bridge := cdpbridge.NewBridge(devMgr, log, cfg.CDPLogging)

	s := &NodeServer{
		cfg:       cfg,
		log:       log,
		chromeMgr: chromeMgr,
		devMgr:    devMgr,
		bridge:    bridge,
		memLn:     newMemListener(),
		openAPIJS: compileOpenAPIToJSON(browsergo.OpenAPIYAML),
	}

	mux := http.NewServeMux()
	s.registerRoutes(mux)

	s.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	return s
}

func (s *NodeServer) Start() error {
	// Always serve the zero-port in-process listener for built-in pftunnel
	go func() {
		_ = s.httpSrv.Serve(s.memLn)
	}()

	if s.cfg.Port > 0 {
		bindAddr := net.JoinHostPort(s.cfg.Host, strconv.Itoa(s.cfg.Port))
		ln, err := net.Listen("tcp", bindAddr)
		if err != nil {
			return err
		}
		s.tcpLn = ln
		go func() {
			_ = s.httpSrv.Serve(ln)
		}()
		s.log.Infof("Browser-Go Node [%s] listening on http://%s", s.cfg.NodeID, ln.Addr().String())
		s.log.Infof("API Documentation: http://127.0.0.1:%d/api-docs", s.BoundPort())
	} else {
		s.log.Infof("Browser-Go Node [%s] started in stealth tunnel-only mode (--port=0)", s.cfg.NodeID)
	}
	return nil
}

func (s *NodeServer) BoundPort() int {
	if s.tcpLn != nil {
		if ta, ok := s.tcpLn.Addr().(*net.TCPAddr); ok {
			return ta.Port
		}
	}
	return s.cfg.Port
}

func (s *NodeServer) DialInProcess() (net.Conn, error) {
	return s.memLn.Dial()
}

func (s *NodeServer) Shutdown(ctx context.Context) error {
	_ = s.memLn.Close()
	if s.tcpLn != nil {
		_ = s.tcpLn.Close()
	}
	err := s.httpSrv.Shutdown(ctx)
	s.bridge.Shutdown()
	s.devMgr.Shutdown()
	s.chromeMgr.Shutdown()
	return err
}

func (s *NodeServer) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", s.handleHealth)
	mux.HandleFunc("/dashboard", s.handleNodeDashboard)
	mux.HandleFunc("/dashboard/", s.handleNodeDashboard)
	mux.HandleFunc("/liveview.js", liveview.ServeJS)
	mux.HandleFunc("/openapi.json", s.handleOpenAPIJSON)
	mux.HandleFunc("/api-docs", s.handleAPIDocs)
	mux.HandleFunc("/api-docs/", s.handleAPIDocs)

	mux.HandleFunc("/json/version", s.handleJSONVersion)
	mux.HandleFunc("/json", s.handleJSONList)
	mux.HandleFunc("/json/list", s.handleJSONList)

	mux.HandleFunc("/api/v1/browser/stop", s.handleBrowserStop)
	mux.HandleFunc("/api/v1/browser/list", s.handleBrowserList)
	mux.HandleFunc("/api/v1/browser/stats", s.handleBrowserStats)
	mux.HandleFunc("/api/v1/browser/targets", s.handleBrowserTargets)
	mux.HandleFunc("/api/v1/browser/attach", s.handleBrowserAttach)
	mux.HandleFunc("/api/v1/browser/webrtc/signal", s.handleWebRTCSignal)
	mux.HandleFunc("/api/v1/devices", s.handleDevicesList)
	mux.HandleFunc("/api/v1/devices/", s.handleDeviceByID)
	mux.HandleFunc("/api/v1/device/stats", s.handleDeviceStats)

	// Root & dynamic path/WebSocket handler (/cdp, /extension, /startingUrl/..., /devtools/browser, /)
	mux.HandleFunc("/", s.handleRootOrWebSocket)
}

func parsePathParams(pathname string) map[string]string {
	parts := strings.FieldsFunc(pathname, func(r rune) bool { return r == '/' })
	out := make(map[string]string)
	for i := 0; i < len(parts)-1; i += 2 {
		if u, err := url.PathUnescape(parts[i+1]); err == nil {
			out[parts[i]] = u
		} else {
			out[parts[i]] = parts[i+1]
		}
	}
	return out
}

func extractRequestToken(r *http.Request, pathParams map[string]string) string {
	if t := strings.TrimSpace(r.URL.Query().Get("token")); t != "" {
		return t
	}
	if pathParams != nil {
		if t := strings.TrimSpace(pathParams["token"]); t != "" {
			return t
		}
	}
	if t := strings.TrimSpace(r.Header.Get("X-API-Token")); t != "" {
		return t
	}
	authHdr := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHdr), "bearer ") {
		return strings.TrimSpace(authHdr[7:])
	}
	return ""
}

func isLoopbackOrInproc(remoteAddr string) bool {
	if remoteAddr == "" || strings.HasPrefix(remoteAddr, "127.0.0.1:") || remoteAddr == "127.0.0.1" || remoteAddr == "pipe" {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *NodeServer) tokenMatches(got string) bool {
	if s.cfg.Token == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.Token)) == 1
}

// authorizeManagement checks token auth: non-loopback requests or StrictAuth always require valid token;
// loopback requests without a token are permitted for legacy compatibility unless StrictAuth is enabled,
// while an explicitly provided wrong token is always rejected.
func (s *NodeServer) authorizeManagement(w http.ResponseWriter, r *http.Request) bool {
	tok := extractRequestToken(r, nil)
	if tok != "" {
		if !s.tokenMatches(tok) {
			writeJSON(w, http.StatusForbidden, map[string]any{"code": -1, "msg": "Invalid token"})
			return false
		}
		return true
	}
	if !s.cfg.StrictAuth && isLoopbackOrInproc(r.RemoteAddr) {
		return true
	}
	writeJSON(w, http.StatusUnauthorized, map[string]any{"code": -1, "msg": "Missing authentication token"})
	return false
}

func (s *NodeServer) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"node_id": s.cfg.NodeID,
		"version": browsergo.AppVersion,
	})
}

func (s *NodeServer) handleOpenAPIJSON(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(s.openAPIJS)
}

func (s *NodeServer) handleAPIDocs(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(apiDocsHTML))
}

func (s *NodeServer) handleJSONVersion(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	wsScheme := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		wsScheme = "wss"
	}
	host := r.Host
	if host == "" {
		host = fmt.Sprintf("127.0.0.1:%d", s.BoundPort())
	}
	q := url.Values{}
	if tok := extractRequestToken(r, nil); tok != "" {
		q.Set("token", tok)
	}
	if launch := r.URL.Query().Get("launch"); launch != "" {
		q.Set("launch", launch)
	}
	if su := r.URL.Query().Get("startingUrl"); su != "" {
		q.Set("startingUrl", su)
	}
	wsURL := fmt.Sprintf("%s://%s/devtools/browser", wsScheme, host)
	if enc := q.Encode(); enc != "" {
		wsURL += "?" + enc
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"Browser":              "Chrome/Browser-Go-" + browsergo.AppVersion,
		"Protocol-Version":     "1.3",
		"User-Agent":           "Browser-Go/" + browsergo.AppVersion,
		"webSocketDebuggerUrl": wsURL,
	})
}

func (s *NodeServer) handleJSONList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, []any{})
}

func (s *NodeServer) handleBrowserStop(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"code": -1,
			"msg":  "Missing user_id parameter",
		})
		return
	}
	if !s.chromeMgr.HasInstance(userID) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"code": -1,
			"msg":  "Browser instance not found for this user_id",
		})
		return
	}
	killed, err := s.chromeMgr.KillInstance(userID)
	if err != nil || !killed {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"code": -1,
			"msg":  "Failed to close browser instance",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
	})
}

func (s *NodeServer) handleBrowserList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	list := s.chromeMgr.ListInstances()
	st := s.chromeMgr.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"code":    0,
		"msg":     "success",
		"node_id": s.cfg.NodeID,
		"data":    list,
		"stats": map[string]any{
			"current_instances":   st.CurrentInstances,
			"max_instances":       st.MaxInstances,
			"instance_timeout_ms": st.InstanceTimeoutMs,
		},
	})
}

func (s *NodeServer) handleBrowserStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	st := s.chromeMgr.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": map[string]any{
			"node_id":                 s.cfg.NodeID,
			"tags":                    s.cfg.Tags,
			"current_instances":       st.CurrentInstances,
			"max_instances":           st.MaxInstances,
			"available_slots":         st.AvailableSlots,
			"active_ws_connections":   s.ActiveWSConns.Load(),
			"instance_timeout_ms":     st.InstanceTimeoutMs,
			"inactive_check_interval": st.InactiveCheckInterval,
		},
	})
}

func (s *NodeServer) handleBrowserTargets(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"code": -1, "msg": "Missing user_id parameter"})
		return
	}
	targets, err := s.chromeMgr.ListTargets(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"code": -1, "msg": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": targets,
	})
}

func (s *NodeServer) handleBrowserAttach(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		http.Error(w, "Missing user_id parameter", http.StatusBadRequest)
		return
	}
	inst, release, err := s.chromeMgr.AttachExisting(userID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	defer release()

	targetWS := inst.WSURL
	if tid := strings.TrimSpace(r.URL.Query().Get("target_id")); tid != "" {
		if targets, tErr := s.chromeMgr.ListTargets(r.Context(), userID); tErr == nil {
			for _, t := range targets {
				if t.ID == tid && t.WebSocketDebuggerURL != "" {
					targetWS = t.WebSocketDebuggerURL
					break
				}
			}
		}
	}

	s.ActiveWSConns.Add(1)
	defer s.ActiveWSConns.Add(-1)
	_ = wsutil.ProxyRawWebSocket(r.Context(), w, r, targetWS, nil, inst.Touch)
}

func (s *NodeServer) handleWebRTCSignal(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		http.Error(w, "Missing user_id parameter", http.StatusBadRequest)
		return
	}
	targetID := strings.TrimSpace(r.URL.Query().Get("target_id"))

	var extraICE []pionwebrtc.ICEServer
	if rawB64 := strings.TrimSpace(r.URL.Query().Get("ice_b64")); rawB64 != "" {
		if decoded, err := base64.RawURLEncoding.DecodeString(rawB64); err == nil {
			_ = json.Unmarshal(decoded, &extraICE)
		}
	}

	ws, err := wsutil.UpgradeHTTP(w, r)
	if err != nil {
		return
	}
	defer ws.Close(1000, "")

	s.ActiveWSConns.Add(1)
	defer s.ActiveWSConns.Add(-1)
	bgwebrtc.ServeTakeoverSession(r.Context(), ws, s.chromeMgr, userID, targetID, s.cfg.WebRTC, extraICE, s.log)
}

func (s *NodeServer) handleDevicesList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	devs := s.devMgr.List()
	items := make([]map[string]any, 0, len(devs))
	for _, d := range devs {
		items = append(items, map[string]any{
			"deviceId":       d.DeviceID,
			"deviceInfo":     d.DeviceInfo,
			"connectionInfo": d.ConnectionInfo,
			"registeredAt":   d.RegisteredAt.UTC().Format(time.RFC3339Nano),
			"lastSeen":       d.LastSeen.UTC().Format(time.RFC3339Nano),
			"isConnected":    d.Session != nil && d.Session.IsConnected(),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": map[string]any{
			"devices": items,
			"stats":   s.devMgr.Stats(),
		},
	})
}

func (s *NodeServer) handleDeviceByID(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	devID := strings.TrimPrefix(r.URL.Path, "/api/v1/devices/")
	devID = strings.TrimSpace(devID)
	d := s.devMgr.Get(devID)
	if d == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"code": 404,
			"msg":  "Device not found",
			"data": nil,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": map[string]any{
			"deviceId":       d.DeviceID,
			"deviceInfo":     d.DeviceInfo,
			"connectionInfo": d.ConnectionInfo,
			"registeredAt":   d.RegisteredAt.UTC().Format(time.RFC3339Nano),
			"lastSeen":       d.LastSeen.UTC().Format(time.RFC3339Nano),
			"isConnected":    d.Session != nil && d.Session.IsConnected(),
		},
	})
}

func (s *NodeServer) handleDeviceStats(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeManagement(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": s.devMgr.Stats(),
	})
}

func (s *NodeServer) handleRootOrWebSocket(w http.ResponseWriter, r *http.Request) {
	if !wsutil.IsWebSocketUpgrade(r) {
		if r.URL.Path == "/" {
			writeJSON(w, http.StatusOK, map[string]any{
				"service":   "browser-go",
				"mode":      "node",
				"node_id":   s.cfg.NodeID,
				"version":   browsergo.AppVersion,
				"dashboard": "/dashboard",
				"docs":      "/api-docs",
			})
			return
		}
		http.NotFound(w, r)
		return
	}

	switch r.URL.Path {
	case "/cdp":
		if !s.authorizeManagement(w, r) {
			return
		}
		ws, err := wsutil.UpgradeHTTP(w, r)
		if err != nil {
			return
		}
		s.ActiveWSConns.Add(1)
		defer s.ActiveWSConns.Add(-1)
		s.bridge.ServeCDPClient(ws, strings.TrimSpace(r.URL.Query().Get("deviceId")))
		return

	case "/extension":
		if !s.authorizeManagement(w, r) {
			return
		}
		ws, err := wsutil.UpgradeHTTP(w, r)
		if err != nil {
			return
		}
		s.ActiveWSConns.Add(1)
		defer s.ActiveWSConns.Add(-1)
		s.bridge.ServeExtension(ws, strings.TrimSpace(r.URL.Query().Get("deviceId")))
		return
	}

	s.handleBrowserLaunchWS(w, r)
}

func (s *NodeServer) handleBrowserLaunchWS(w http.ResponseWriter, r *http.Request) {
	pathParams := parsePathParams(r.URL.Path)
	reqToken := extractRequestToken(r, pathParams)
	if reqToken == "" {
		http.Error(w, "Missing token parameter", http.StatusBadRequest)
		return
	}
	if !s.tokenMatches(reqToken) {
		http.Error(w, "Invalid token", http.StatusForbidden)
		return
	}

	startingURL := strings.TrimSpace(r.URL.Query().Get("startingUrl"))
	if startingURL == "" {
		startingURL = strings.TrimSpace(pathParams["startingUrl"])
	}
	if startingURL == "" && strings.HasPrefix(r.URL.Path, "/devtools/browser") {
		startingURL = "about:blank"
	}
	if startingURL == "" {
		http.Error(w, "Missing startingUrl parameter", http.StatusBadRequest)
		return
	}

	var lp chrome.LaunchParams
	if rawLaunch := strings.TrimSpace(r.URL.Query().Get("launch")); rawLaunch != "" {
		if err := json.Unmarshal([]byte(rawLaunch), &lp); err != nil {
			http.Error(w, "Invalid launch JSON parameter", http.StatusBadRequest)
			return
		}
	}

	inst, release, err := s.chromeMgr.Acquire(r.Context(), startingURL, lp)
	if err != nil {
		if errors.Is(err, chrome.ErrMaxInstancesReached) {
			http.Error(w, "Maximum concurrent instances limit reached, please try again later", http.StatusServiceUnavailable)
			return
		}
		s.log.Errorf("Failed to launch/acquire Chrome instance: %v", err)
		http.Error(w, "Failed to launch Chrome: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer release()

	s.ActiveWSConns.Add(1)
	defer s.ActiveWSConns.Add(-1)

	if err := wsutil.ProxyRawWebSocket(r.Context(), w, r, inst.WSURL, nil, inst.Touch); err != nil {
		s.log.Debugf("CDP WebSocket proxy ended for [%s]: %v", inst.Key, err)
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func compileOpenAPIToJSON(rawYAML []byte) []byte {
	var node any
	if err := yaml.Unmarshal(rawYAML, &node); err != nil {
		return []byte(`{"openapi":"3.0.3","info":{"title":"Browser-Go API","version":"2.0.0"}}`)
	}
	b, err := json.MarshalIndent(normalizeYAMLValue(node), "", "  ")
	if err != nil {
		return []byte(`{"openapi":"3.0.3","info":{"title":"Browser-Go API","version":"2.0.0"}}`)
	}
	return b
}

func normalizeYAMLValue(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = normalizeYAMLValue(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[fmt.Sprint(k)] = normalizeYAMLValue(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = normalizeYAMLValue(val)
		}
		return out
	default:
		return v
	}
}

const apiDocsHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Browser-Go API Documentation</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    header { padding: 20px 32px; background: #1e293b; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    h1 { margin: 0; font-size: 20px; color: #38bdf8; }
    main { max-width: 1080px; margin: 24px auto; padding: 0 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; }
    .method { display: inline-block; padding: 3px 8px; border-radius: 4px; font-weight: 700; font-size: 12px; background: #0284c7; color: #fff; margin-right: 10px; }
    .path { font-family: monospace; font-size: 15px; color: #f8fafc; }
    pre { background: #090d16; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 13px; color: #cbd5e1; }
    a { color: #38bdf8; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <h1>Browser-Go CDP Service &amp; Pool API</h1>
    <a href="/openapi.json" target="_blank">Raw OpenAPI JSON ↗</a>
  </header>
  <main id="endpoints">Loading specification...</main>
  <script>
    fetch('/openapi.json').then(r => r.json()).then(spec => {
      const root = document.getElementById('endpoints');
      root.innerHTML = '';
      const info = document.createElement('div');
      info.className = 'card';
      info.innerHTML = '<strong>' + (spec.info?.title || 'Browser-Go') + ' v' + (spec.info?.version || '2.0') + '</strong><p>' + (spec.info?.description || '') + '</p>';
      root.appendChild(info);
      for (const [p, ops] of Object.entries(spec.paths || {})) {
        for (const [m, detail] of Object.entries(ops)) {
          const el = document.createElement('div');
          el.className = 'card';
          el.innerHTML = '<div><span class="method">' + m.toUpperCase() + '</span><span class="path">' + p + '</span></div><p>' + (detail.summary || '') + ' — ' + (detail.description || '') + '</p>';
          root.appendChild(el);
        }
      }
    }).catch(e => { document.getElementById('endpoints').textContent = 'Failed to load /openapi.json: ' + e; });
  </script>
</body>
</html>`
