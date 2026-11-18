package cdpbridge

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"browser-go/internal/logger"
	"browser-go/internal/wsutil"
)

const pendingReqTTL = 60 * time.Second

type pendingRequest struct {
	clientID  string
	origMsgID json.RawMessage
	sentAt    time.Time
}

// ExtensionSession wraps an isolated Chrome Extension WebSocket connection (fixing single-socket overwrite bugs).
type ExtensionSession struct {
	sessionID string
	ws        *wsutil.Conn

	mu       sync.RWMutex
	deviceID string
	connInfo *ConnectionInfo
	pending  map[int64]pendingRequest

	seq atomic.Int64
}

func (es *ExtensionSession) getDeviceID() string {
	es.mu.RLock()
	defer es.mu.RUnlock()
	return es.deviceID
}

func (es *ExtensionSession) setDeviceID(id string) {
	es.mu.Lock()
	es.deviceID = id
	es.mu.Unlock()
}

func (es *ExtensionSession) getConnInfo() *ConnectionInfo {
	es.mu.RLock()
	defer es.mu.RUnlock()
	return es.connInfo
}

func (es *ExtensionSession) setConnInfo(ci *ConnectionInfo) {
	es.mu.Lock()
	es.connInfo = ci
	es.mu.Unlock()
}

func (es *ExtensionSession) IsConnected() bool {
	return es != nil && es.ws != nil && !es.ws.IsClosed()
}

type cdpClientSession struct {
	connID   string
	deviceID string
	ws       *wsutil.Conn
}

// BridgeStats reports active Playwright and Chrome Extension relay state.
type BridgeStats struct {
	PlaywrightConnected bool     `json:"playwrightConnected"`
	ExtensionConnected  bool     `json:"extensionConnected"`
	CDPConnections      int      `json:"cdpConnections"`
	ExtensionSessions   int      `json:"extensionSessions"`
	ActiveDevices       []string `json:"activeDevices"`
}

// Bridge implements multi-device concurrent-safe CDP WebSocket message relaying.
type Bridge struct {
	dm         *DeviceManager
	log        *logger.Logger
	cdpLogging bool

	mu         sync.RWMutex
	clients    map[string]*cdpClientSession
	extensions map[string]*ExtensionSession
	lastExtID  string // fallback only when Playwright omits ?deviceId=

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewBridge(dm *DeviceManager, log *logger.Logger, cdpLogging bool) *Bridge {
	if log == nil {
		log = logger.Default()
	}
	b := &Bridge{
		dm:         dm,
		log:        log,
		cdpLogging: cdpLogging,
		clients:    make(map[string]*cdpClientSession),
		extensions: make(map[string]*ExtensionSession),
		stopCh:     make(chan struct{}),
	}
	b.wg.Add(1)
	go b.cleanupPendingLoop()
	return b
}

func randomID(prefix string) string {
	var buf [6]byte
	_, _ = rand.Read(buf[:])
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), hex.EncodeToString(buf[:]))
}

// ServeCDPClient handles a Playwright / CDP client WebSocket until disconnect.
func (b *Bridge) ServeCDPClient(ws *wsutil.Conn, deviceID string) {
	connID := randomID("cdp")
	cli := &cdpClientSession{
		connID:   connID,
		deviceID: deviceID,
		ws:       ws,
	}

	b.mu.Lock()
	b.clients[connID] = cli
	b.mu.Unlock()

	b.log.Infof("CDP client connected (%s, deviceId=%q)", connID, deviceID)
	defer func() {
		b.mu.Lock()
		delete(b.clients, connID)
		b.mu.Unlock()
		b.purgePendingForClient(connID)
		_ = ws.Close(1000, "")
		b.log.Infof("CDP client disconnected (%s)", connID)
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(raw, &msg); err != nil {
			b.log.Warnf("Invalid JSON from CDP client %s: %v", connID, err)
			continue
		}
		b.handlePlaywrightMessage(cli, raw, msg)
	}
}

// ServeExtension handles a Chrome Extension WebSocket until disconnect.
func (b *Bridge) ServeExtension(ws *wsutil.Conn, initialDeviceID string) {
	sessID := randomID("ext")
	ext := &ExtensionSession{
		sessionID: sessID,
		ws:        ws,
		deviceID:  initialDeviceID,
		pending:   make(map[int64]pendingRequest),
	}

	b.mu.Lock()
	b.extensions[sessID] = ext
	b.lastExtID = sessID
	b.mu.Unlock()

	if initialDeviceID != "" {
		b.dm.Register(initialDeviceID, DeviceInfo{Name: "Chrome Extension"}, ext, nil)
	}

	b.log.Infof("Extension connected (%s, initialDeviceId=%q)", sessID, initialDeviceID)
	defer func() {
		devID := ext.getDeviceID()
		if devID != "" {
			b.dm.Unregister(devID, ext)
		}
		b.mu.Lock()
		delete(b.extensions, sessID)
		if b.lastExtID == sessID {
			b.lastExtID = ""
			for id := range b.extensions {
				b.lastExtID = id
				break
			}
		}
		b.mu.Unlock()
		_ = ws.Close(1000, "")
		b.log.Infof("Extension disconnected (%s, deviceId=%q)", sessID, devID)
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		b.handleExtensionMessage(ext, raw)
	}
}

func (b *Bridge) resolveExtensionForClient(deviceID string) (*ExtensionSession, *ConnectionInfo) {
	if deviceID != "" {
		if d := b.dm.Get(deviceID); d != nil && d.Session != nil && !d.Session.ws.IsClosed() {
			ci := d.ConnectionInfo
			if ci == nil {
				ci = d.Session.getConnInfo()
			}
			return d.Session, ci
		}
		return nil, nil
	}

	// Single-device fallback mode when no ?deviceId= was requested
	b.mu.RLock()
	ext := b.extensions[b.lastExtID]
	b.mu.RUnlock()
	if ext != nil && !ext.ws.IsClosed() {
		return ext, ext.getConnInfo()
	}
	return nil, nil
}

func (b *Bridge) handlePlaywrightMessage(cli *cdpClientSession, raw []byte, msg map[string]any) {
	method, _ := msg["method"].(string)
	b.logCDP("←", "Playwright("+cli.connID+")", "Bridge", method, raw)

	if len(method) >= 8 && method[:8] == "Browser." {
		b.handleBrowserDomain(cli, method, msg)
		return
	}
	if len(method) >= 7 && method[:7] == "Target." {
		b.handleTargetDomain(cli, method, msg)
		return
	}
	if method != "" {
		b.forwardToExtension(cli, method, msg)
	}
}

func (b *Bridge) handleBrowserDomain(cli *cdpClientSession, method string, msg map[string]any) {
	switch method {
	case "Browser.getVersion":
		_ = cli.ws.WriteJSON(map[string]any{
			"id": msg["id"],
			"result": map[string]any{
				"protocolVersion": "1.3",
				"product":         "Chrome/Browser-Go-Bridge",
				"userAgent":       "Browser-Go-Bridge/2.0.0",
			},
		})
	case "Browser.setDownloadBehavior":
		_ = cli.ws.WriteJSON(map[string]any{
			"id":     msg["id"],
			"result": map[string]any{},
		})
	default:
		b.forwardToExtension(cli, method, msg)
	}
}

func (b *Bridge) handleTargetDomain(cli *cdpClientSession, method string, msg map[string]any) {
	_, ci := b.resolveExtensionForClient(cli.deviceID)

	switch method {
	case "Target.setAutoAttach":
		sessID, _ := msg["sessionId"].(string)
		if ci != nil && sessID == "" {
			ti := make(map[string]any, len(ci.TargetInfo)+1)
			for k, v := range ci.TargetInfo {
				ti[k] = v
			}
			ti["attached"] = true

			_ = cli.ws.WriteJSON(map[string]any{
				"method": "Target.attachedToTarget",
				"params": map[string]any{
					"sessionId":          ci.SessionID,
					"targetInfo":         ti,
					"waitingForDebugger": false,
				},
			})
			_ = cli.ws.WriteJSON(map[string]any{
				"id":     msg["id"],
				"result": map[string]any{},
			})
			return
		}
		b.forwardToExtension(cli, method, msg)

	case "Target.getTargets":
		targetInfos := make([]any, 0, 1)
		if ci != nil && ci.TargetInfo != nil {
			ti := make(map[string]any, len(ci.TargetInfo)+1)
			for k, v := range ci.TargetInfo {
				ti[k] = v
			}
			ti["attached"] = true
			targetInfos = append(targetInfos, ti)
		}
		_ = cli.ws.WriteJSON(map[string]any{
			"id": msg["id"],
			"result": map[string]any{
				"targetInfos": targetInfos,
			},
		})

	default:
		b.forwardToExtension(cli, method, msg)
	}
}

func (b *Bridge) forwardToExtension(cli *cdpClientSession, method string, msg map[string]any) {
	ext, _ := b.resolveExtensionForClient(cli.deviceID)
	if ext == nil {
		errText := "No extension connected and no deviceId specified"
		if cli.deviceID != "" {
			errText = fmt.Sprintf("Device %s not connected", cli.deviceID)
		}
		if idVal, hasID := msg["id"]; hasID && idVal != nil {
			_ = cli.ws.WriteJSON(map[string]any{
				"id": idVal,
				"error": map[string]any{
					"code":    -32000,
					"message": errText,
				},
			})
		}
		return
	}

	outMsg := make(map[string]any, len(msg))
	for k, v := range msg {
		outMsg[k] = v
	}

	var seqID int64
	if idVal, hasID := msg["id"]; hasID && idVal != nil {
		origBytes, _ := json.Marshal(idVal)
		seqID = ext.seq.Add(1)
		outMsg["id"] = seqID

		ext.mu.Lock()
		ext.pending[seqID] = pendingRequest{
			clientID:  cli.connID,
			origMsgID: origBytes,
			sentAt:    time.Now(),
		}
		ext.mu.Unlock()
	}

	encoded, err := json.Marshal(outMsg)
	if err != nil {
		return
	}
	b.logCDP("→", "Bridge", "Extension("+ext.sessionID+")", method, encoded)

	if err := ext.ws.WriteText(encoded); err != nil {
		if seqID > 0 {
			ext.mu.Lock()
			delete(ext.pending, seqID)
			ext.mu.Unlock()
			_ = cli.ws.WriteJSON(map[string]any{
				"id": msg["id"],
				"error": map[string]any{
					"code":    -32000,
					"message": "Failed to send command to extension: " + err.Error(),
				},
			})
		}
	}
}

func (b *Bridge) handleExtensionMessage(ext *ExtensionSession, raw []byte) {
	var envelope struct {
		Type       string          `json:"type"`
		DeviceID   string          `json:"deviceId"`
		SessionID  string          `json:"sessionId"`
		TargetInfo map[string]any  `json:"targetInfo"`
		DeviceInfo *DeviceInfo     `json:"deviceInfo"`
		ID         *int64          `json:"id"`
		Method     string          `json:"method"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		b.log.Warnf("Malformed JSON from extension %s: %v", ext.sessionID, err)
		return
	}

	switch envelope.Type {
	case "connection_info":
		ci := &ConnectionInfo{
			SessionID:  envelope.SessionID,
			TargetInfo: envelope.TargetInfo,
		}
		ext.setConnInfo(ci)
		devID := envelope.DeviceID
		if devID == "" {
			devID = ext.getDeviceID()
		}
		if devID != "" {
			ext.setDeviceID(devID)
			info := DeviceInfo{Name: "Chrome Extension", UserAgent: "Browser-Go-Extension"}
			if envelope.DeviceInfo != nil {
				info = *envelope.DeviceInfo
			}
			b.dm.Register(devID, info, ext, ci)
			b.dm.UpdateConnectionInfo(devID, ci)
		}
		b.log.Infof("Extension %s updated tab connection_info (deviceId=%q, session=%q)", ext.sessionID, devID, ci.SessionID)
		return

	case "ping":
		devID := envelope.DeviceID
		if devID != "" {
			prevID := ext.getDeviceID()
			if prevID != devID {
				ext.setDeviceID(devID)
			}
			existing := b.dm.Get(devID)
			if existing == nil || existing.Session != ext {
				b.dm.Register(devID, DeviceInfo{
					Name:      "Chrome Extension",
					Version:   "1.0.0",
					UserAgent: "Browser-Go-Extension",
				}, ext, ext.getConnInfo())
			} else {
				b.dm.TouchHeartbeat(devID)
			}
		}
		_ = ext.ws.WriteJSON(map[string]any{
			"type":      "pong",
			"deviceId":  devID,
			"timestamp": time.Now().UnixMilli(),
		})
		return
	}

	b.logCDP("←", "Extension("+ext.sessionID+")", "Bridge", envelope.Method, raw)

	// 1. Response frame (`id` present): remap monotonic seqID -> original client & original message ID
	if envelope.ID != nil {
		seqID := *envelope.ID
		ext.mu.Lock()
		pend, ok := ext.pending[seqID]
		if ok {
			delete(ext.pending, seqID)
		}
		ext.mu.Unlock()
		if !ok {
			return
		}

		b.mu.RLock()
		cli := b.clients[pend.clientID]
		b.mu.RUnlock()
		if cli == nil || cli.ws.IsClosed() {
			return
		}

		var full map[string]any
		if err := json.Unmarshal(raw, &full); err != nil {
			return
		}
		full["id"] = pend.origMsgID
		rewritten, err := json.Marshal(full)
		if err != nil {
			return
		}
		b.logCDP("→", "Bridge", "Playwright("+cli.connID+")", "", rewritten)
		_ = cli.ws.WriteText(rewritten)
		return
	}

	// 2. Event frame (`id` absent): deliver ONLY to clients bound to this extension's device (no cross-talk!)
	extDevID := ext.getDeviceID()
	b.mu.RLock()
	isDefaultFallback := b.lastExtID == ext.sessionID
	targets := make([]*cdpClientSession, 0, len(b.clients))
	for _, cli := range b.clients {
		if cli.ws.IsClosed() {
			continue
		}
		if extDevID != "" && cli.deviceID == extDevID {
			targets = append(targets, cli)
		} else if cli.deviceID == "" && isDefaultFallback {
			targets = append(targets, cli)
		}
	}
	b.mu.RUnlock()

	for _, cli := range targets {
		b.logCDP("→", "Bridge", "Playwright("+cli.connID+")", envelope.Method, raw)
		_ = cli.ws.WriteText(raw)
	}
}

func (b *Bridge) purgePendingForClient(clientID string) {
	b.mu.RLock()
	exts := make([]*ExtensionSession, 0, len(b.extensions))
	for _, e := range b.extensions {
		exts = append(exts, e)
	}
	b.mu.RUnlock()

	for _, e := range exts {
		e.mu.Lock()
		for k, p := range e.pending {
			if p.clientID == clientID {
				delete(e.pending, k)
			}
		}
		e.mu.Unlock()
	}
}

func (b *Bridge) cleanupPendingLoop() {
	defer b.wg.Done()
	tk := time.NewTicker(30 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-tk.C:
			now := time.Now()
			b.mu.RLock()
			exts := make([]*ExtensionSession, 0, len(b.extensions))
			for _, e := range b.extensions {
				exts = append(exts, e)
			}
			b.mu.RUnlock()

			for _, e := range exts {
				e.mu.Lock()
				for seq, p := range e.pending {
					if now.Sub(p.sentAt) > pendingReqTTL {
						delete(e.pending, seq)
					}
				}
				e.mu.Unlock()
			}
		case <-b.stopCh:
			return
		}
	}
}

func (b *Bridge) logCDP(dir, src, dst, method string, raw []byte) {
	label := method
	if label == "" {
		label = "response"
	}
	if b.cdpLogging {
		preview := string(raw)
		if len(preview) > 1200 {
			preview = preview[:1200] + "...(truncated)"
		}
		b.log.Infof("[CDP] %s %s -> %s (%s, %dB): %s", dir, src, dst, label, len(raw), preview)
	} else {
		b.log.Debugf("%s %s -> %s: %s (%dB)", dir, src, dst, label, len(raw))
	}
}

func (b *Bridge) Stats() BridgeStats {
	b.mu.RLock()
	defer b.mu.RUnlock()

	devSet := make(map[string]struct{})
	activeCDP := 0
	for _, cli := range b.clients {
		if !cli.ws.IsClosed() {
			activeCDP++
			if cli.deviceID != "" {
				devSet[cli.deviceID] = struct{}{}
			}
		}
	}
	activeExt := 0
	for _, ext := range b.extensions {
		if !ext.ws.IsClosed() {
			activeExt++
		}
	}
	devs := make([]string, 0, len(devSet))
	for d := range devSet {
		devs = append(devs, d)
	}
	return BridgeStats{
		PlaywrightConnected: activeCDP > 0,
		ExtensionConnected:  activeExt > 0,
		CDPConnections:      activeCDP,
		ExtensionSessions:   activeExt,
		ActiveDevices:       devs,
	}
}

func (b *Bridge) Shutdown() {
	select {
	case <-b.stopCh:
		return
	default:
		close(b.stopCh)
	}
	b.wg.Wait()

	b.mu.Lock()
	clis := make([]*cdpClientSession, 0, len(b.clients))
	for _, c := range b.clients {
		clis = append(clis, c)
	}
	exts := make([]*ExtensionSession, 0, len(b.extensions))
	for _, e := range b.extensions {
		exts = append(exts, e)
	}
	b.clients = make(map[string]*cdpClientSession)
	b.extensions = make(map[string]*ExtensionSession)
	b.mu.Unlock()

	for _, c := range clis {
		_ = c.ws.Close(1000, "Server shutdown")
	}
	for _, e := range exts {
		_ = e.ws.Close(1000, "Server shutdown")
	}
}
