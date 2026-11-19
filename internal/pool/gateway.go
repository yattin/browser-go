package pool

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	browsergo "browser-go"
	"browser-go/internal/chrome"
	"browser-go/internal/config"
	"browser-go/internal/liveview"
	"browser-go/internal/logger"
	bgwebrtc "browser-go/internal/webrtc"
	"browser-go/internal/wsutil"
	"browser-go/pkg/pftunnel"
	pionwebrtc "github.com/pion/webrtc/v4"
)

type backendNode struct {
	ID         string
	Source     string // "backend" or "pftunnel"
	BaseHTTP   string // e.g. "http://127.0.0.1:13001" or "http://127.0.0.1:3000"
	BaseWS     string // e.g. "ws://127.0.0.1:13001" or "ws://127.0.0.1:3000"
	TunnelKey  string // non-empty when Source == "pftunnel"
	TargetAddr string // target passed over tunnel stream (default "127.0.0.1:3000")
	dialFn     func(ctx context.Context, network, addr string) (net.Conn, error)
	httpClient *http.Client

	mu               sync.RWMutex
	Healthy          bool
	LastProbe        time.Time
	LastError        string
	RTTMs            int64
	CurrentInstances int
	MaxInstances     int
	AvailableSlots   int
	Tags             map[string]string

	inflightHandshakes atomic.Int32
	activeWS           atomic.Int32
}

func (n *backendNode) effectiveAvailableSlots() int {
	n.mu.RLock()
	defer n.mu.RUnlock()
	if !n.Healthy {
		return 0
	}
	if n.AvailableSlots < 0 {
		return 0
	}
	return n.AvailableSlots
}

func (n *backendNode) matchesTags(required map[string]string) bool {
	if len(required) == 0 {
		return true
	}
	n.mu.RLock()
	defer n.mu.RUnlock()
	for k, want := range required {
		if got, ok := n.Tags[k]; !ok || !strings.EqualFold(got, want) {
			return false
		}
	}
	return true
}

// NodeStatusView is returned by GET /api/v1/pool/nodes.
type NodeStatusView struct {
	NodeID           string            `json:"node_id"`
	Source           string            `json:"source"`
	Healthy          bool              `json:"healthy"`
	RTTMs            int64             `json:"rtt_ms"`
	CurrentInstances int               `json:"current_instances"`
	MaxInstances     int               `json:"max_instances"`
	AvailableSlots   int               `json:"available_slots"`
	ActiveWS         int32             `json:"active_ws"`
	Tags             map[string]string `json:"tags,omitempty"`
	LastProbe        string            `json:"last_probe,omitempty"`
	LastError        string            `json:"last_error,omitempty"`
}

// Gateway is the central multi-node CDP Browser Pool Scheduler & ProxyForge Bridge Gateway.
type Gateway struct {
	cfg     config.PoolConfig
	log     *logger.Logger
	bridge  *pftunnel.EmbeddedBridge
	turnSrv *bgwebrtc.EmbeddedTurnServer

	httpSrv *http.Server
	tcpLn   net.Listener

	mu           sync.RWMutex
	nodes        map[string]*backendNode
	userBindings map[string]string // sanitized user -> nodeID

	slotNotify chan struct{}
	ctx        context.Context
	cancel     context.CancelFunc
	wg         sync.WaitGroup
}

func NewGateway(cfg config.PoolConfig, log *logger.Logger) (*Gateway, error) {
	if log == nil {
		log = logger.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	gw := &Gateway{
		cfg:          cfg,
		log:          log,
		nodes:        make(map[string]*backendNode),
		userBindings: make(map[string]string),
		slotNotify:   make(chan struct{}, 1),
		ctx:          ctx,
		cancel:       cancel,
	}

	for idx, spec := range cfg.Backends {
		nd, err := gw.parseStaticBackend(idx+1, spec)
		if err != nil {
			cancel()
			return nil, err
		}
		gw.nodes[nd.ID] = nd
	}

	if strings.TrimSpace(cfg.PFListen) != "" {
		var allowed []string
		if cfg.PFClientKeys != "" {
			allowed = strings.Split(cfg.PFClientKeys, ",")
		}
		gw.bridge = pftunnel.NewEmbeddedBridge(pftunnel.EmbeddedBridgeConfig{
			ListenAddr: cfg.PFListen,
			Proto:      cfg.PFProto,
			AllowedKey: allowed,
			EnableP2P:  cfg.PFEnableP2P,
			Transport: pftunnel.TransportOptions{
				CertSpec:       cfg.PFCertFile,
				KeySpec:        cfg.PFKeyFile,
				SingleTLS:      cfg.PFSingleTLS,
				CustomPassword: cfg.PFPassword,
				Compress:       cfg.PFCompress,
				Timeout:        10 * time.Second,
			},
			Logger:     log,
			OnNodeJoin: gw.onTunnelNodeJoin,
			OnNodeExit: gw.onTunnelNodeExit,
		})
	}

	mux := http.NewServeMux()
	gw.registerRoutes(mux)
	gw.httpSrv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 15 * time.Second,
	}
	return gw, nil
}

// parseStaticBackend parses `node1=http://127.0.0.1:13001#region=shanghai&isp=telecom` or `http://127.0.0.1:13001`.
func (gw *Gateway) parseStaticBackend(idx int, raw string) (*backendNode, error) {
	s := strings.TrimSpace(raw)
	tags := make(map[string]string)
	if hashIdx := strings.IndexByte(s, '#'); hashIdx >= 0 {
		tagPart := s[hashIdx+1:]
		s = s[:hashIdx]
		for k, v := range config.ParseTagsCSV(strings.ReplaceAll(tagPart, "&", ",")) {
			tags[k] = v
		}
	}

	nodeID := fmt.Sprintf("backend-%d", idx)
	if eqIdx := strings.IndexByte(s, '='); eqIdx > 0 && !strings.Contains(s[:eqIdx], "://") {
		nodeID = strings.TrimSpace(s[:eqIdx])
		s = strings.TrimSpace(s[eqIdx+1:])
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("invalid --backends entry %q", raw)
	}
	wsScheme := "ws"
	httpScheme := "http"
	if strings.EqualFold(u.Scheme, "https") || strings.EqualFold(u.Scheme, "wss") {
		wsScheme = "wss"
		httpScheme = "https"
	}

	return &backendNode{
		ID:       nodeID,
		Source:   "backend",
		BaseHTTP: httpScheme + "://" + u.Host,
		BaseWS:   wsScheme + "://" + u.Host,
		Tags:     tags,
		httpClient: &http.Client{
			Timeout: 3 * time.Second,
		},
	}, nil
}

func (gw *Gateway) onTunnelNodeJoin(clientKey string, tags map[string]string) {
	dialFn := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return gw.bridge.DialNode(ctx, clientKey, "127.0.0.1:3000")
	}
	tr := &http.Transport{
		DialContext:     dialFn,
		MaxIdleConns:    16,
		IdleConnTimeout: 30 * time.Second,
	}
	copiedTags := make(map[string]string, len(tags))
	for k, v := range tags {
		copiedTags[k] = v
	}
	nd := &backendNode{
		ID:               clientKey,
		Source:           "pftunnel",
		BaseHTTP:         "http://127.0.0.1:3000",
		BaseWS:           "ws://127.0.0.1:3000",
		TunnelKey:        clientKey,
		TargetAddr:       "127.0.0.1:3000",
		dialFn:           dialFn,
		httpClient:       &http.Client{Transport: tr, Timeout: 4 * time.Second},
		Healthy:          true,
		MaxInstances:     10,
		AvailableSlots:   10,
		Tags:             copiedTags,
	}

	gw.mu.Lock()
	gw.nodes[clientKey] = nd
	gw.mu.Unlock()

	// Trigger immediate probe so real slot capacity is populated right away
	go func() {
		gw.probeSingleNode(nd)
		gw.notifySlotFreed()
	}()
}

func (gw *Gateway) onTunnelNodeExit(clientKey string) {
	gw.mu.Lock()
	if nd, ok := gw.nodes[clientKey]; ok && nd.Source == "pftunnel" {
		delete(gw.nodes, clientKey)
	}
	gw.mu.Unlock()
}

func (gw *Gateway) Start() error {
	if gw.bridge != nil {
		if err := gw.bridge.Start(); err != nil {
			return err
		}
	}

	if strings.TrimSpace(gw.cfg.WebRTC.TURNListen) != "" {
		ts, err := bgwebrtc.StartEmbeddedTurnServer(
			gw.cfg.WebRTC.TURNListen,
			gw.cfg.WebRTC.TURNPublicIP,
			gw.cfg.WebRTC.TURNSecret,
			gw.log,
		)
		if err != nil {
			if gw.bridge != nil {
				gw.bridge.Stop()
			}
			return fmt.Errorf("start embedded TURN server: %w", err)
		}
		gw.turnSrv = ts
	}

	bindAddr := net.JoinHostPort(gw.cfg.Host, strconv.Itoa(gw.cfg.Port))
	ln, err := net.Listen("tcp", bindAddr)
	if err != nil {
		if gw.turnSrv != nil {
			_ = gw.turnSrv.Close()
		}
		if gw.bridge != nil {
			gw.bridge.Stop()
		}
		return err
	}
	gw.tcpLn = ln

	// Perform initial probe synchronously before accepting traffic
	gw.probeAllNodes()

	gw.wg.Add(1)
	go gw.probeLoop()

	go func() {
		_ = gw.httpSrv.Serve(ln)
	}()

	gw.log.Infof("Browser-Go Pool Gateway listening on http://%s", ln.Addr().String())
	return nil
}

func (gw *Gateway) BoundAddr() string {
	if gw.tcpLn != nil {
		return gw.tcpLn.Addr().String()
	}
	return net.JoinHostPort(gw.cfg.Host, strconv.Itoa(gw.cfg.Port))
}

func (gw *Gateway) BridgeAddr() string {
	if gw.bridge != nil {
		return gw.bridge.Addr()
	}
	return ""
}

func (gw *Gateway) Shutdown(ctx context.Context) error {
	gw.cancel()
	if gw.tcpLn != nil {
		_ = gw.tcpLn.Close()
	}
	err := gw.httpSrv.Shutdown(ctx)
	if gw.turnSrv != nil {
		_ = gw.turnSrv.Close()
	}
	if gw.bridge != nil {
		gw.bridge.Stop()
	}
	gw.wg.Wait()
	return err
}

func (gw *Gateway) notifySlotFreed() {
	select {
	case gw.slotNotify <- struct{}{}:
	default:
	}
}

func (gw *Gateway) probeLoop() {
	defer gw.wg.Done()
	interval := gw.cfg.ProbeEvery
	if interval <= 0 {
		interval = 3 * time.Second
	}
	tk := time.NewTicker(interval)
	defer tk.Stop()

	for {
		select {
		case <-tk.C:
			gw.probeAllNodes()
		case <-gw.ctx.Done():
			return
		}
	}
}

func (gw *Gateway) probeAllNodes() {
	gw.mu.RLock()
	list := make([]*backendNode, 0, len(gw.nodes))
	for _, nd := range gw.nodes {
		list = append(list, nd)
	}
	gw.mu.RUnlock()

	var pwg sync.WaitGroup
	freed := atomic.Bool{}
	for _, nd := range list {
		pwg.Add(1)
		go func(target *backendNode) {
			defer pwg.Done()
			if gw.probeSingleNode(target) > 0 {
				freed.Store(true)
			}
		}(nd)
	}
	pwg.Wait()
	if freed.Load() {
		gw.notifySlotFreed()
	}
}

func (gw *Gateway) probeSingleNode(nd *backendNode) int {
	start := time.Now()
	req, err := http.NewRequestWithContext(gw.ctx, http.MethodGet, nd.BaseHTTP+"/api/v1/browser/stats", nil)
	if err != nil {
		return 0
	}
	if gw.cfg.Token != "" {
		req.Header.Set("X-API-Token", gw.cfg.Token)
	}
	resp, err := nd.httpClient.Do(req)
	rtt := time.Since(start).Milliseconds()

	if err != nil {
		nd.mu.Lock()
		nd.Healthy = false
		nd.LastProbe = time.Now()
		nd.LastError = err.Error()
		nd.AvailableSlots = 0
		nd.mu.Unlock()
		return 0
	}
	defer resp.Body.Close()

	var payload struct {
		Code int `json:"code"`
		Data struct {
			NodeID           string            `json:"node_id"`
			Tags             map[string]string `json:"tags"`
			CurrentInstances int               `json:"current_instances"`
			MaxInstances     int               `json:"max_instances"`
			AvailableSlots   int               `json:"available_slots"`
		} `json:"data"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&payload) != nil {
		nd.mu.Lock()
		nd.Healthy = false
		nd.LastProbe = time.Now()
		nd.LastError = fmt.Sprintf("probe HTTP %d", resp.StatusCode)
		nd.AvailableSlots = 0
		nd.mu.Unlock()
		return 0
	}

	nd.mu.Lock()
	nd.Healthy = true
	nd.LastProbe = time.Now()
	nd.LastError = ""
	nd.RTTMs = rtt
	// Only overwrite optimistic slot counts when no upgrade handshake is mid-flight to this node
	if nd.inflightHandshakes.Load() == 0 {
		nd.CurrentInstances = payload.Data.CurrentInstances
		nd.MaxInstances = payload.Data.MaxInstances
		nd.AvailableSlots = payload.Data.AvailableSlots
	} else {
		nd.MaxInstances = payload.Data.MaxInstances
		if payload.Data.AvailableSlots < nd.AvailableSlots {
			nd.CurrentInstances = payload.Data.CurrentInstances
			nd.AvailableSlots = payload.Data.AvailableSlots
		}
	}
	if len(payload.Data.Tags) > 0 {
		if nd.Tags == nil {
			nd.Tags = make(map[string]string)
		}
		for k, v := range payload.Data.Tags {
			nd.Tags[k] = v
		}
	}
	avail := nd.AvailableSlots
	nd.mu.Unlock()
	return avail
}

// selectNode chooses the best healthy node honoring sticky `user` affinity, tag filters, and wait queue.
func (gw *Gateway) selectNode(ctx context.Context, user string, requiredTags map[string]string, explicitNode string) (*backendNode, func(), func(), error) {
	deadline := time.Now().Add(gw.cfg.QueueTimeout)

	for {
		nd, consumedNewSlot, err := gw.tryPickNodeOnce(user, requiredTags, explicitNode)
		if nd != nil {
			nd.inflightHandshakes.Add(1)
			nd.activeWS.Add(1)
			var handshookOnce sync.Once
			markHandshook := func() {
				handshookOnce.Do(func() {
					nd.inflightHandshakes.Add(-1)
				})
			}
			var releaseOnce sync.Once
			release := func() {
				markHandshook()
				releaseOnce.Do(func() {
					nd.activeWS.Add(-1)
					go func() {
						gw.probeSingleNode(nd)
						gw.notifySlotFreed()
					}()
				})
			}
			_ = consumedNewSlot
			return nd, markHandshook, release, nil
		}
		if err != nil {
			return nil, nil, nil, err
		}

		if gw.cfg.QueueTimeout <= 0 || time.Now().After(deadline) {
			return nil, nil, nil, chrome.ErrMaxInstancesReached
		}

		waitDur := time.Until(deadline)
		if waitDur > 1500*time.Millisecond {
			waitDur = 1500 * time.Millisecond
		}
		t := time.NewTimer(waitDur)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil, nil, nil, ctx.Err()
		case <-gw.slotNotify:
			t.Stop()
		case <-t.C:
			gw.probeAllNodes()
		}
	}
}

func (gw *Gateway) tryPickNodeOnce(user string, requiredTags map[string]string, explicitNode string) (*backendNode, bool, error) {
	gw.mu.Lock()
	defer gw.mu.Unlock()

	if len(gw.nodes) == 0 {
		return nil, false, errors.New("no browser nodes registered in pool")
	}

	if explicitNode != "" {
		nd, ok := gw.nodes[explicitNode]
		if !ok {
			return nil, false, fmt.Errorf("requested node %q not found", explicitNode)
		}
		nd.mu.Lock()
		h := nd.Healthy
		if h && nd.AvailableSlots > 0 {
			nd.CurrentInstances++
			nd.AvailableSlots--
		}
		nd.mu.Unlock()
		if !h {
			return nil, false, fmt.Errorf("requested node %q is unhealthy", explicitNode)
		}
		return nd, true, nil
	}

	// 1. Check sticky user binding first (reusing warm persistent user profile doesn't consume a new slot!)
	if user != "" {
		if boundID, exists := gw.userBindings[user]; exists {
			if boundNode, ok := gw.nodes[boundID]; ok {
				boundNode.mu.RLock()
				healthy := boundNode.Healthy
				boundNode.mu.RUnlock()
				if healthy && boundNode.matchesTags(requiredTags) {
					return boundNode, false, nil
				}
			}
			delete(gw.userBindings, user)
		}
	}

	// 2. Pick least-loaded healthy node matching tags (highest effective available slots, tie-break lowest RTT)
	var best *backendNode
	bestSlots := 0
	var bestRTT int64 = 1<<62 - 1
	anyMatchingNode := false

	for _, nd := range gw.nodes {
		nd.mu.RLock()
		healthy := nd.Healthy
		rtt := nd.RTTMs
		nd.mu.RUnlock()
		if !healthy || !nd.matchesTags(requiredTags) {
			continue
		}
		anyMatchingNode = true
		slots := nd.effectiveAvailableSlots()
		if slots <= 0 {
			continue
		}
		if best == nil || slots > bestSlots || (slots == bestSlots && rtt < bestRTT) {
			best = nd
			bestSlots = slots
			bestRTT = rtt
		}
	}

	if !anyMatchingNode {
		return nil, false, errors.New("no healthy browser nodes match requested tags")
	}
	if best != nil {
		best.mu.Lock()
		if best.AvailableSlots > 0 {
			best.CurrentInstances++
			best.AvailableSlots--
		}
		best.mu.Unlock()
		if user != "" {
			gw.userBindings[user] = best.ID
		}
	}
	return best, best != nil, nil
}

func (gw *Gateway) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", gw.handleHealth)
	mux.HandleFunc("/dashboard", gw.handleDashboard)
	mux.HandleFunc("/dashboard/", gw.handleDashboard)
	mux.HandleFunc("/liveview.js", liveview.ServeJS)
	mux.HandleFunc("/json/version", gw.handleJSONVersion)
	mux.HandleFunc("/api/v1/pool/nodes", gw.handlePoolNodes)
	mux.HandleFunc("/api/v1/browser/stats", gw.handlePoolStats)
	mux.HandleFunc("/api/v1/browser/list", gw.handlePoolList)
	mux.HandleFunc("/api/v1/browser/stop", gw.handlePoolStop)
	mux.HandleFunc("/api/v1/browser/targets", gw.handlePoolTargets)
	mux.HandleFunc("/api/v1/browser/attach", gw.handlePoolAttach)
	mux.HandleFunc("/api/v1/browser/webrtc/signal", gw.handlePoolWebRTCSignal)
	mux.HandleFunc("/", gw.handleRootOrCDPProxy)
}

func (gw *Gateway) extractToken(r *http.Request, pathParams map[string]string) string {
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

func (gw *Gateway) tokenValid(got string) bool {
	if gw.cfg.Token == "" {
		return true
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(gw.cfg.Token)) == 1
}

func (gw *Gateway) checkManagementAuth(w http.ResponseWriter, r *http.Request) bool {
	tok := gw.extractToken(r, nil)
	if tok != "" {
		if !gw.tokenValid(tok) {
			writePoolJSON(w, http.StatusForbidden, map[string]any{"code": -1, "msg": "Invalid token"})
			return false
		}
		return true
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if !gw.cfg.StrictAuth && ip != nil && ip.IsLoopback() {
		return true
	}
	writePoolJSON(w, http.StatusUnauthorized, map[string]any{"code": -1, "msg": "Missing authentication token"})
	return false
}

func (gw *Gateway) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writePoolJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"mode":    "pool",
		"version": browsergo.AppVersion,
	})
}

func (gw *Gateway) handleJSONVersion(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	wsScheme := "ws"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		wsScheme = "wss"
	}
	q := r.URL.Query()
	if q.Get("token") == "" {
		if tok := gw.extractToken(r, nil); tok != "" {
			q.Set("token", tok)
		}
	}
	wsURL := fmt.Sprintf("%s://%s/devtools/browser", wsScheme, r.Host)
	if enc := q.Encode(); enc != "" {
		wsURL += "?" + enc
	}
	writePoolJSON(w, http.StatusOK, map[string]any{
		"Browser":              "Chrome/Browser-Go-Pool-" + browsergo.AppVersion,
		"Protocol-Version":     "1.3",
		"User-Agent":           "Browser-Go-Pool/" + browsergo.AppVersion,
		"webSocketDebuggerUrl": wsURL,
	})
}

func (gw *Gateway) handlePoolNodes(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	gw.mu.RLock()
	out := make([]NodeStatusView, 0, len(gw.nodes))
	for _, nd := range gw.nodes {
		nd.mu.RLock()
		lp := ""
		if !nd.LastProbe.IsZero() {
			lp = nd.LastProbe.UTC().Format(time.RFC3339)
		}
		tagsCopy := make(map[string]string, len(nd.Tags))
		for k, v := range nd.Tags {
			tagsCopy[k] = v
		}
		v := NodeStatusView{
			NodeID:           nd.ID,
			Source:           nd.Source,
			Healthy:          nd.Healthy,
			RTTMs:            nd.RTTMs,
			CurrentInstances: nd.CurrentInstances,
			MaxInstances:     nd.MaxInstances,
			AvailableSlots:   nd.effectiveAvailableSlots(),
			ActiveWS:         nd.activeWS.Load(),
			Tags:             tagsCopy,
			LastProbe:        lp,
			LastError:        nd.LastError,
		}
		nd.mu.RUnlock()
		out = append(out, v)
	}
	gw.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool { return out[i].NodeID < out[j].NodeID })
	writePoolJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": out,
	})
}

func (gw *Gateway) handlePoolStats(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	gw.mu.RLock()
	var totalCur, totalMax, totalAvail, healthyNodes int
	totalNodes := len(gw.nodes)
	for _, nd := range gw.nodes {
		nd.mu.RLock()
		if nd.Healthy {
			healthyNodes++
			totalCur += nd.CurrentInstances
			totalMax += nd.MaxInstances
		}
		nd.mu.RUnlock()
		totalAvail += nd.effectiveAvailableSlots()
	}
	gw.mu.RUnlock()

	writePoolJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": map[string]any{
			"total_nodes":       totalNodes,
			"healthy_nodes":     healthyNodes,
			"current_instances": totalCur,
			"max_instances":     totalMax,
			"available_slots":   totalAvail,
		},
	})
}

func (gw *Gateway) handlePoolList(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	gw.mu.RLock()
	nodes := make([]*backendNode, 0, len(gw.nodes))
	for _, nd := range gw.nodes {
		nd.mu.RLock()
		h := nd.Healthy
		nd.mu.RUnlock()
		if h {
			nodes = append(nodes, nd)
		}
	}
	gw.mu.RUnlock()

	type itemWithNode struct {
		NodeID          string `json:"node_id"`
		UserID          string `json:"user_id"`
		CurrentURL      string `json:"current_url,omitempty"`
		CurrentTitle    string `json:"current_title,omitempty"`
		LastActivity    string `json:"last_activity"`
		IdleTimeSeconds int64  `json:"idle_time_seconds"`
	}

	var mu sync.Mutex
	var allItems []itemWithNode
	var totalCur, totalMax int
	var lwg sync.WaitGroup

	for _, nd := range nodes {
		lwg.Add(1)
		go func(target *backendNode) {
			defer lwg.Done()
			req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.BaseHTTP+"/api/v1/browser/list", nil)
			if err != nil {
				return
			}
			if gw.cfg.Token != "" {
				req.Header.Set("X-API-Token", gw.cfg.Token)
			}
			resp, err := target.httpClient.Do(req)
			if err != nil {
				return
			}
			defer resp.Body.Close()

			var body struct {
				Data  []chrome.InstanceSnapshot `json:"data"`
				Stats struct {
					CurrentInstances int `json:"current_instances"`
					MaxInstances     int `json:"max_instances"`
				} `json:"stats"`
			}
			if json.NewDecoder(resp.Body).Decode(&body) == nil {
				mu.Lock()
				totalCur += body.Stats.CurrentInstances
				totalMax += body.Stats.MaxInstances
				for _, it := range body.Data {
					allItems = append(allItems, itemWithNode{
						NodeID:          target.ID,
						UserID:          it.UserID,
						CurrentURL:      it.CurrentURL,
						CurrentTitle:    it.CurrentTitle,
						LastActivity:    it.LastActivity,
						IdleTimeSeconds: it.IdleTimeSeconds,
					})
				}
				mu.Unlock()
			}
		}(nd)
	}
	lwg.Wait()

	if allItems == nil {
		allItems = []itemWithNode{}
	}
	writePoolJSON(w, http.StatusOK, map[string]any{
		"code": 0,
		"msg":  "success",
		"data": allItems,
		"stats": map[string]any{
			"current_instances": totalCur,
			"max_instances":     totalMax,
		},
	})
}

func (gw *Gateway) handlePoolStop(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writePoolJSON(w, http.StatusBadRequest, map[string]any{"code": -1, "msg": "Missing user_id parameter"})
		return
	}
	nodeFilter := strings.TrimSpace(r.URL.Query().Get("node_id"))

	var candidates []*backendNode
	gw.mu.RLock()
	if nodeFilter != "" {
		if nd, ok := gw.nodes[nodeFilter]; ok {
			candidates = append(candidates, nd)
		}
	} else if boundID, ok := gw.userBindings[userID]; ok {
		if nd, exists := gw.nodes[boundID]; exists {
			candidates = append(candidates, nd)
		}
	}
	if len(candidates) == 0 {
		for _, nd := range gw.nodes {
			candidates = append(candidates, nd)
		}
	}
	gw.mu.RUnlock()

	stoppedAny := false
	for _, nd := range candidates {
		u := nd.BaseHTTP + "/api/v1/browser/stop?user_id=" + url.QueryEscape(userID)
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
		if err != nil {
			continue
		}
		if gw.cfg.Token != "" {
			req.Header.Set("X-API-Token", gw.cfg.Token)
		}
		resp, err := nd.httpClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				stoppedAny = true
				go gw.probeSingleNode(nd)
			}
		}
	}

	if stoppedAny {
		gw.mu.Lock()
		delete(gw.userBindings, userID)
		gw.mu.Unlock()
		gw.notifySlotFreed()
		writePoolJSON(w, http.StatusOK, map[string]any{"code": 0, "msg": "success"})
		return
	}
	writePoolJSON(w, http.StatusNotFound, map[string]any{"code": -1, "msg": "Browser instance not found across pool"})
}

func (gw *Gateway) resolveNodeForUser(ctx context.Context, userID, explicitNode string) (*backendNode, error) {
	gw.mu.RLock()
	if explicitNode != "" {
		nd, ok := gw.nodes[explicitNode]
		gw.mu.RUnlock()
		if !ok {
			return nil, fmt.Errorf("node %q not found", explicitNode)
		}
		return nd, nil
	}
	if userID != "" {
		if boundID, ok := gw.userBindings[userID]; ok {
			if nd, exists := gw.nodes[boundID]; exists {
				gw.mu.RUnlock()
				return nd, nil
			}
		}
	}
	allNodes := make([]*backendNode, 0, len(gw.nodes))
	for _, nd := range gw.nodes {
		nd.mu.RLock()
		h := nd.Healthy
		nd.mu.RUnlock()
		if h {
			allNodes = append(allNodes, nd)
		}
	}
	gw.mu.RUnlock()

	for _, nd := range allNodes {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, nd.BaseHTTP+"/api/v1/browser/list", nil)
		if err != nil {
			continue
		}
		if gw.cfg.Token != "" {
			req.Header.Set("X-API-Token", gw.cfg.Token)
		}
		resp, err := nd.httpClient.Do(req)
		if err != nil {
			continue
		}
		var body struct {
			Data []chrome.InstanceSnapshot `json:"data"`
		}
		decErr := json.NewDecoder(resp.Body).Decode(&body)
		_ = resp.Body.Close()
		if decErr != nil {
			continue
		}
		for _, it := range body.Data {
			if it.UserID == userID {
				return nd, nil
			}
		}
	}
	return nil, fmt.Errorf("browser instance %q not found across pool", userID)
}

func (gw *Gateway) handlePoolTargets(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		writePoolJSON(w, http.StatusBadRequest, map[string]any{"code": -1, "msg": "Missing user_id parameter"})
		return
	}
	nodeID := strings.TrimSpace(r.URL.Query().Get("node_id"))
	nd, err := gw.resolveNodeForUser(r.Context(), userID, nodeID)
	if err != nil {
		writePoolJSON(w, http.StatusNotFound, map[string]any{"code": -1, "msg": err.Error()})
		return
	}

	u := nd.BaseHTTP + "/api/v1/browser/targets?user_id=" + url.QueryEscape(userID)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u, nil)
	if err != nil {
		writePoolJSON(w, http.StatusInternalServerError, map[string]any{"code": -1, "msg": err.Error()})
		return
	}
	if gw.cfg.Token != "" {
		req.Header.Set("X-API-Token", gw.cfg.Token)
	}
	resp, err := nd.httpClient.Do(req)
	if err != nil {
		writePoolJSON(w, http.StatusBadGateway, map[string]any{"code": -1, "msg": err.Error()})
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (gw *Gateway) handlePoolAttach(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		http.Error(w, "Missing user_id parameter", http.StatusBadRequest)
		return
	}
	nodeID := strings.TrimSpace(r.URL.Query().Get("node_id"))
	nd, err := gw.resolveNodeForUser(r.Context(), userID, nodeID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	upQuery := r.URL.Query()
	upQuery.Del("node_id")
	if gw.cfg.Token != "" {
		upQuery.Set("token", gw.cfg.Token)
	}
	targetWS := nd.BaseWS + "/api/v1/browser/attach?" + upQuery.Encode()
	w.Header().Set("X-Browser-Node", nd.ID)
	_ = wsutil.ProxyRawWebSocket(r.Context(), w, r, targetWS, nd.dialFn, nil)
}

func (gw *Gateway) handlePoolWebRTCSignal(w http.ResponseWriter, r *http.Request) {
	if !gw.checkManagementAuth(w, r) {
		return
	}
	userID := strings.TrimSpace(r.URL.Query().Get("user_id"))
	if userID == "" {
		http.Error(w, "Missing user_id parameter", http.StatusBadRequest)
		return
	}
	nodeID := strings.TrimSpace(r.URL.Query().Get("node_id"))
	nd, err := gw.resolveNodeForUser(r.Context(), userID, nodeID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}

	upQuery := r.URL.Query()
	upQuery.Del("node_id")
	if gw.cfg.Token != "" {
		upQuery.Set("token", gw.cfg.Token)
	}

	// Inject short-lived embedded TURN credentials + configured external STUN/TURN servers into node signal URL
	var extraICE []pionwebrtc.ICEServer
	if gw.turnSrv != nil {
		extraICE = append(extraICE, gw.turnSrv.IssueICEServer(time.Hour))
	}
	for _, rawTurn := range gw.cfg.WebRTC.TURNServers {
		if srv, ok := bgwebrtc.ParseExternalTURN(rawTurn); ok {
			extraICE = append(extraICE, srv)
		}
	}
	if len(gw.cfg.WebRTC.STUNServers) > 0 {
		extraICE = append(extraICE, pionwebrtc.ICEServer{URLs: gw.cfg.WebRTC.STUNServers})
	}
	if len(extraICE) > 0 {
		if rawJSON, mErr := json.Marshal(extraICE); mErr == nil {
			upQuery.Set("ice_b64", base64.RawURLEncoding.EncodeToString(rawJSON))
		}
	}

	targetWS := nd.BaseWS + "/api/v1/browser/webrtc/signal?" + upQuery.Encode()
	gw.log.Infof("Routing WebRTC Live View (user=%q) -> node [%s] (%s)", userID, nd.ID, nd.Source)
	w.Header().Set("X-Browser-Node", nd.ID)
	_ = wsutil.ProxyRawWebSocket(r.Context(), w, r, targetWS, nd.dialFn, nil)
}

func parsePoolPathParams(pathname string) map[string]string {
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

func (gw *Gateway) handleRootOrCDPProxy(w http.ResponseWriter, r *http.Request) {
	if !wsutil.IsWebSocketUpgrade(r) {
		if r.URL.Path == "/" {
			writePoolJSON(w, http.StatusOK, map[string]any{
				"service":   "browser-go",
				"mode":      "pool",
				"version":   browsergo.AppVersion,
				"dashboard": "/dashboard",
				"nodes":     "/api/v1/pool/nodes",
			})
			return
		}
		http.NotFound(w, r)
		return
	}

	pathParams := parsePoolPathParams(r.URL.Path)
	tok := gw.extractToken(r, pathParams)
	if tok == "" {
		http.Error(w, "Missing token parameter", http.StatusBadRequest)
		return
	}
	if !gw.tokenValid(tok) {
		http.Error(w, "Invalid token", http.StatusForbidden)
		return
	}

	var lp chrome.LaunchParams
	if rawLaunch := strings.TrimSpace(r.URL.Query().Get("launch")); rawLaunch != "" {
		if err := json.Unmarshal([]byte(rawLaunch), &lp); err != nil {
			http.Error(w, "Invalid launch JSON parameter", http.StatusBadRequest)
			return
		}
	}

	reqTags := config.ParseTagsCSV(r.URL.Query().Get("tags"))
	explicitNode := strings.TrimSpace(r.URL.Query().Get("node"))

	nd, markHandshook, release, err := gw.selectNode(r.Context(), strings.TrimSpace(lp.User), reqTags, explicitNode)
	if err != nil {
		if errors.Is(err, chrome.ErrMaxInstancesReached) {
			http.Error(w, "All browser pool slots are currently busy", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "Pool scheduling error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer release()

	// Forward WebSocket upgrade transparently to the chosen node, rewriting token to gateway's node token
	upQuery := r.URL.Query()
	upQuery.Set("token", gw.cfg.Token)
	upPath := r.URL.Path
	if upPath == "" {
		upPath = "/"
	}
	targetWS := nd.BaseWS + upPath
	if enc := upQuery.Encode(); enc != "" {
		targetWS += "?" + enc
	}

	gw.log.Infof("Routing CDP session (user=%q, tags=%v) -> node [%s] (%s)", lp.User, reqTags, nd.ID, nd.Source)
	w.Header().Set("X-Browser-Node", nd.ID)
	var activityOnce sync.Once
	onFirstActivity := func() {
		activityOnce.Do(markHandshook)
	}
	_ = wsutil.ProxyRawWebSocket(r.Context(), w, r, targetWS, nd.dialFn, onFirstActivity)
}

func writePoolJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
