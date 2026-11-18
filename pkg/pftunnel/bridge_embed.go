package pftunnel

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"browser-go/internal/logger"
)

// NodePeerInfo describes an intranet node currently connected to EmbeddedBridge.
type NodePeerInfo struct {
	ClientKey   string            `json:"client_key"`
	RemoteAddr  string            `json:"remote_addr"`
	Sessions    int               `json:"sessions"`
	Tags        map[string]string `json:"tags,omitempty"`
	ConnectedAt time.Time         `json:"connected_at"`
}

type p2pMappedEntry struct {
	addr string
	seen time.Time
}

type muxNodeGroup struct {
	sessions    []*MuxSession
	tags        map[string]string
	remoteAddr  string
	connectedAt time.Time
	rr          atomic.Uint64
}

// EmbeddedBridgeConfig configures Browser-Go Pool's built-in ProxyForge-compatible Bridge listener.
type EmbeddedBridgeConfig struct {
	ListenAddr string
	Proto      string
	AllowedKey []string
	EnableP2P  bool
	Transport  TransportOptions
	Logger     *logger.Logger
	OnNodeJoin func(clientKey string, tags map[string]string)
	OnNodeExit func(clientKey string)
}

// EmbeddedBridge is a wire-compatible ProxyForge Bridge server embedded directly inside `browser-go pool`.
// It accepts both `browser-go node --pf-bridge=...` AND vanilla `proxyforge client -P ...` workers!
type EmbeddedBridge struct {
	cfg     EmbeddedBridgeConfig
	log     *logger.Logger
	allowed map[string]bool

	ln     net.Listener
	udpLn  *net.UDPConn
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu    sync.RWMutex
	nodes map[string]*muxNodeGroup

	p2pMu        sync.RWMutex
	p2pEndpoints map[string]p2pMappedEntry
}

func NewEmbeddedBridge(cfg EmbeddedBridgeConfig) *EmbeddedBridge {
	log := cfg.Logger
	if log == nil {
		log = logger.Default()
	}
	allow := make(map[string]bool)
	for _, k := range cfg.AllowedKey {
		for _, sub := range strings.Split(k, ",") {
			sub = strings.TrimSpace(sub)
			if sub != "" {
				allow[sub] = true
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &EmbeddedBridge{
		cfg:          cfg,
		log:          log,
		allowed:      allow,
		ctx:          ctx,
		cancel:       cancel,
		nodes:        make(map[string]*muxNodeGroup),
		p2pEndpoints: make(map[string]p2pMappedEntry),
	}
}

func (eb *EmbeddedBridge) Start() error {
	ln, err := Listen(eb.cfg.Proto, eb.cfg.ListenAddr, eb.cfg.Transport)
	if err != nil {
		return err
	}
	eb.ln = ln

	if eb.cfg.Proto != "kcp" {
		if uAddr, err := net.ResolveUDPAddr("udp", ln.Addr().String()); err == nil {
			if uConn, err := net.ListenUDP("udp", uAddr); err == nil {
				eb.udpLn = uConn
				eb.wg.Add(1)
				go func() {
					defer eb.wg.Done()
					eb.serveSTUNReflector(uConn)
				}()
			}
		}
	}

	eb.log.Infof("Embedded ProxyForge Bridge listening on %s (%s, whitelist=%d)", ln.Addr().String(), eb.cfg.Proto, len(eb.allowed))
	eb.wg.Add(1)
	go func() {
		defer eb.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go eb.handleConn(c)
		}
	}()
	return nil
}

func (eb *EmbeddedBridge) Addr() string {
	if eb.ln != nil {
		return eb.ln.Addr().String()
	}
	return eb.cfg.ListenAddr
}

func (eb *EmbeddedBridge) Stop() {
	eb.cancel()
	if eb.ln != nil {
		_ = eb.ln.Close()
	}
	if eb.udpLn != nil {
		_ = eb.udpLn.Close()
	}
	eb.mu.Lock()
	for _, grp := range eb.nodes {
		for _, s := range grp.sessions {
			_ = s.Close()
		}
	}
	eb.nodes = make(map[string]*muxNodeGroup)
	eb.mu.Unlock()
	eb.wg.Wait()
}

func (eb *EmbeddedBridge) keyAllowed(k string) bool {
	if len(eb.allowed) == 0 {
		return true
	}
	return eb.allowed[k]
}

// ListPeers returns a snapshot of all currently connected intranet tunnel nodes.
func (eb *EmbeddedBridge) ListPeers() []NodePeerInfo {
	eb.mu.RLock()
	out := make([]NodePeerInfo, 0, len(eb.nodes))
	for k, g := range eb.nodes {
		tagsCopy := make(map[string]string, len(g.tags))
		for tk, tv := range g.tags {
			tagsCopy[tk] = tv
		}
		out = append(out, NodePeerInfo{
			ClientKey:   k,
			RemoteAddr:  g.remoteAddr,
			Sessions:    len(g.sessions),
			Tags:        tagsCopy,
			ConnectedAt: g.connectedAt,
		})
	}
	eb.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool {
		return out[i].ClientKey < out[j].ClientKey
	})
	return out
}

// DialNode opens a multiplexed TCP stream directly to a registered intranet node's targetAddr.
func (eb *EmbeddedBridge) DialNode(ctx context.Context, clientKey, targetAddr string) (net.Conn, error) {
	eb.mu.RLock()
	grp := eb.nodes[clientKey]
	var sess *MuxSession
	if grp != nil && len(grp.sessions) > 0 {
		idx := grp.rr.Add(1) - 1
		sess = grp.sessions[int(idx)%len(grp.sessions)]
	}
	eb.mu.RUnlock()

	if sess == nil || sess.IsClosed() {
		return nil, fmt.Errorf("tunnel node %q is offline", clientKey)
	}

	if targetAddr == "" {
		targetAddr = "127.0.0.1:3000"
	}

	st, err := sess.OpenStream()
	if err != nil {
		return nil, err
	}
	reqBytes, _ := json.Marshal(TunnelOpenReq{
		ClientKey: clientKey,
		Proto:     "tcp",
		Target:    targetAddr,
	})
	reqBytes = append(reqBytes, '\n')
	if _, err := st.Write(reqBytes); err != nil {
		_ = st.Close()
		return nil, err
	}

	dl := time.Now().Add(10 * time.Second)
	if ctxDL, ok := ctx.Deadline(); ok && ctxDL.Before(dl) {
		dl = ctxDL
	}
	_ = st.SetReadDeadline(dl)
	br := bufio.NewReader(st)
	line, err := br.ReadString('\n')
	_ = st.SetReadDeadline(time.Time{})
	if err != nil || !strings.HasPrefix(line, "OK") {
		_ = st.Close()
		return nil, fmt.Errorf("tunnel node %q target %q connect failed: %s", clientKey, targetAddr, strings.TrimSpace(line))
	}
	return newPeekConn(st, br), nil
}

func (eb *EmbeddedBridge) handleConn(raw net.Conn) {
	_ = raw.SetReadDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(raw)
	line, err := br.ReadBytes('\n')
	_ = raw.SetReadDeadline(time.Time{})
	if err != nil {
		_ = raw.Close()
		return
	}

	var hs TunnelHandshake
	if err := json.Unmarshal(bytes.TrimSpace(line), &hs); err != nil {
		_ = raw.Close()
		return
	}
	conn := newPeekConn(raw, br)

	switch hs.Action {
	case "mux_client":
		key := strings.TrimSpace(hs.ClientKey)
		if key == "" {
			key = "default"
		}
		if !eb.keyAllowed(key) {
			_, _ = conn.Write([]byte("ERR forbidden client key\n"))
			_ = conn.Close()
			return
		}
		if _, err := conn.Write([]byte("OK\n")); err != nil {
			_ = conn.Close()
			return
		}

		sess := NewMuxSession(conn, true)
		rAddr := ""
		if conn.RemoteAddr() != nil {
			rAddr = conn.RemoteAddr().String()
		}

		firstJoin := false
		eb.mu.Lock()
		grp, exists := eb.nodes[key]
		if !exists {
			grp = &muxNodeGroup{
				tags:        hs.NodeTags,
				remoteAddr:  rAddr,
				connectedAt: time.Now(),
			}
			eb.nodes[key] = grp
			firstJoin = true
		} else if len(hs.NodeTags) > 0 {
			grp.tags = hs.NodeTags
		}
		grp.sessions = append(grp.sessions, sess)
		eb.mu.Unlock()

		eb.log.Infof("Bridge node [%s] registered from %s (tags=%v)", key, rAddr, hs.NodeTags)
		if firstJoin && eb.cfg.OnNodeJoin != nil {
			eb.cfg.OnNodeJoin(key, hs.NodeTags)
		}

		<-sess.Done()

		lastExit := false
		eb.mu.Lock()
		if curGrp, ok := eb.nodes[key]; ok {
			rem := curGrp.sessions[:0]
			for _, item := range curGrp.sessions {
				if item != sess && !item.IsClosed() {
					rem = append(rem, item)
				}
			}
			if len(rem) == 0 {
				delete(eb.nodes, key)
				lastExit = true
			} else {
				curGrp.sessions = rem
			}
		}
		eb.mu.Unlock()

		if lastExit {
			eb.log.Infof("Bridge node [%s] went offline", key)
			if eb.cfg.OnNodeExit != nil {
				eb.cfg.OnNodeExit(key)
			}
		}

	case "mux_server":
		// Also compatible with external `proxyforge server` connecting into EmbeddedBridge!
		if _, err := conn.Write([]byte("OK\n")); err != nil {
			_ = conn.Close()
			return
		}
		sess := NewMuxSession(conn, false)
		for {
			srvStream, err := sess.AcceptStream()
			if err != nil {
				return
			}
			go eb.handleMuxServerStream(srvStream)
		}

	default:
		_ = conn.Close()
	}
}

func (eb *EmbeddedBridge) handleMuxServerStream(srvStream net.Conn) {
	defer func() { _ = srvStream.Close() }()
	_ = srvStream.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(srvStream)
	line, err := br.ReadBytes('\n')
	_ = srvStream.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}

	var req TunnelOpenReq
	if err := json.Unmarshal(bytes.TrimSpace(line), &req); err != nil {
		return
	}
	key := req.ClientKey
	if key == "" {
		key = "default"
	}
	if !eb.keyAllowed(key) {
		_, _ = srvStream.Write([]byte("ERR forbidden client key\n"))
		return
	}

	if req.Mode == "p2p_offer" {
		eb.brokerP2POffer(srvStream, key, req)
		return
	}

	cliStream, err := eb.DialNode(eb.ctx, key, req.Target)
	if err != nil {
		_, _ = srvStream.Write([]byte("ERR " + err.Error() + "\n"))
		return
	}
	defer func() { _ = cliStream.Close() }()

	if _, err := srvStream.Write([]byte("OK\n")); err != nil {
		return
	}
	RelayBidirectional(newPeekConn(srvStream, br), cliStream)
}

func (eb *EmbeddedBridge) brokerP2POffer(srvStream net.Conn, key string, req TunnelOpenReq) {
	eb.mu.RLock()
	grp := eb.nodes[key]
	var cliSess *MuxSession
	if grp != nil && len(grp.sessions) > 0 {
		idx := grp.rr.Add(1) - 1
		cliSess = grp.sessions[int(idx)%len(grp.sessions)]
	}
	eb.mu.RUnlock()

	if cliSess == nil {
		ans, _ := json.Marshal(p2pAnswer{OK: false, Error: "client offline"})
		_, _ = srvStream.Write(append(ans, '\n'))
		return
	}

	eb.p2pMu.RLock()
	if mapped, ok := eb.p2pEndpoints[req.P2PToken]; ok {
		req.P2PCandidates = appendUniqueAddr(req.P2PCandidates, mapped.addr)
	}
	eb.p2pMu.RUnlock()

	var secBytes [16]byte
	_, _ = rand.Read(secBytes[:])
	req.P2PSecret = hex.EncodeToString(secBytes[:])
	var convBuf [4]byte
	_, _ = rand.Read(convBuf[:])
	req.P2PConvID = (binary.BigEndian.Uint32(convBuf[:]) % 90000000) + 1000

	cliStream, err := cliSess.OpenStream()
	if err != nil {
		ans, _ := json.Marshal(p2pAnswer{OK: false, Error: "client stream failed"})
		_, _ = srvStream.Write(append(ans, '\n'))
		return
	}
	defer func() { _ = cliStream.Close() }()

	reqBytes, _ := json.Marshal(req)
	if _, err := cliStream.Write(append(reqBytes, '\n')); err != nil {
		return
	}
	cliBR := bufio.NewReader(cliStream)
	_ = cliStream.SetReadDeadline(time.Now().Add(6 * time.Second))
	ansLine, err := cliBR.ReadBytes('\n')
	_ = cliStream.SetReadDeadline(time.Time{})
	if err != nil {
		ans, _ := json.Marshal(p2pAnswer{OK: false, Error: "client p2p answer timeout"})
		_, _ = srvStream.Write(append(ans, '\n'))
		return
	}
	var ans p2pAnswer
	if json.Unmarshal(bytes.TrimSpace(ansLine), &ans) == nil && ans.OK {
		ans.Secret = req.P2PSecret
		ans.ConvID = req.P2PConvID
		outBytes, _ := json.Marshal(ans)
		_, _ = srvStream.Write(append(outBytes, '\n'))
		return
	}
	_, _ = srvStream.Write(ansLine)
}

func (eb *EmbeddedBridge) verifyP2PRegSig(tok, sig string) bool {
	if len(sig) != 32 {
		return false
	}
	if len(eb.allowed) == 0 {
		if hmac.Equal([]byte(signP2PRegToken("default", tok)), []byte(sig)) {
			return true
		}
		eb.mu.RLock()
		defer eb.mu.RUnlock()
		for k := range eb.nodes {
			if hmac.Equal([]byte(signP2PRegToken(k, tok)), []byte(sig)) {
				return true
			}
		}
		return false
	}
	for k := range eb.allowed {
		if hmac.Equal([]byte(signP2PRegToken(k, tok)), []byte(sig)) {
			return true
		}
	}
	return false
}

func (eb *EmbeddedBridge) serveSTUNReflector(uc *net.UDPConn) {
	buf := make([]byte, 512)
	for {
		_ = uc.SetReadDeadline(time.Now().Add(30 * time.Second))
		n, raddr, err := uc.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-eb.ctx.Done():
				return
			default:
			}
			now := time.Now()
			eb.p2pMu.Lock()
			for k, v := range eb.p2pEndpoints {
				if now.Sub(v.seen) > 30*time.Second {
					delete(eb.p2pEndpoints, k)
				}
			}
			eb.p2pMu.Unlock()
			continue
		}
		msg := string(buf[:n])
		if strings.HasPrefix(msg, "PF2P_REG:") {
			rest := strings.TrimSpace(msg[len("PF2P_REG:"):])
			tok, sig, ok := strings.Cut(rest, ":")
			if !ok || len(tok) < 16 || len(tok) > 64 || !eb.verifyP2PRegSig(tok, sig) {
				continue
			}
			mapped := raddr.String()
			eb.p2pMu.Lock()
			if len(eb.p2pEndpoints) < 4096 {
				eb.p2pEndpoints[tok] = p2pMappedEntry{addr: mapped, seen: time.Now()}
			}
			eb.p2pMu.Unlock()
			_, _ = uc.WriteToUDP([]byte("PF2P_MAPPED:"+mapped), raddr)
		}
	}
}

var _ = errors.New
