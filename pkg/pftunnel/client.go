package pftunnel

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"browser-go/internal/logger"
)

// TunnelHandshake matches ProxyForge's line-delimited JSON handshake on bridge/tbridge.
type TunnelHandshake struct {
	Action    string            `json:"action"` // "mux_client", "mux_server", "t_client_ctrl", "t_client_worker", "t_server_req"
	ClientKey string            `json:"client_key,omitempty"`
	Token     string            `json:"token,omitempty"`
	Proto     string            `json:"proto,omitempty"`
	Target    string            `json:"target,omitempty"`
	ServerID  string            `json:"server_id,omitempty"`
	NodeTags  map[string]string `json:"node_tags,omitempty"` // ignored safely by vanilla ProxyForge, read by browser-go pool
}

// TunnelOpenReq matches ProxyForge's per-stream JSON open header.
type TunnelOpenReq struct {
	Mode          string   `json:"mode,omitempty"` // "" or "p2p_offer"
	ClientKey     string   `json:"client_key"`
	Proto         string   `json:"proto"`
	Target        string   `json:"target"`
	ServerID      string   `json:"server_id,omitempty"`
	P2PToken      string   `json:"p2p_token,omitempty"`
	P2PCandidates []string `json:"p2p_candidates,omitempty"`
	P2PSecret     string   `json:"p2p_secret,omitempty"`
	P2PConvID     uint32   `json:"p2p_conv_id,omitempty"`
}

type p2pAnswer struct {
	OK         bool     `json:"ok"`
	Error      string   `json:"error,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
	Secret     string   `json:"secret,omitempty"`
	ConvID     uint32   `json:"conv_id,omitempty"`
}

type tunnelCtrlMsg struct {
	Cmd    string `json:"cmd"` // "ping", "pong", "dial"
	Token  string `json:"token,omitempty"`
	Proto  string `json:"proto,omitempty"`
	Target string `json:"target,omitempty"`
}

// ClientConfig configures the built-in ProxyForge intranet tunnel client.
type ClientConfig struct {
	BridgeAddr   string
	Mode         string // "mux" or "multi"
	ClientKey    string
	Proto        string
	SessionCount int
	EnableP2P    bool
	NodeTags     map[string]string
	Transport    TransportOptions
	Logger       *logger.Logger

	// DefaultTargetAddr is used when target host/port matches this Browser-Go node or is in-memory.
	DefaultTargetAddr string
	// InProcessDial optionally connects straight into Browser-Go's HTTP/WS server via net.Pipe without TCP overhead.
	InProcessDial func() (net.Conn, error)
}

// Client maintains persistent auto-reconnecting ProxyForge tunnel sessions to a public Bridge or Pool.
type Client struct {
	cfg           ClientConfig
	log           *logger.Logger
	ActiveStreams atomic.Int32
	BytesIn       atomic.Int64
	BytesOut      atomic.Int64
	P2PDirect     atomic.Int64

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewClient(cfg ClientConfig) (*Client, error) {
	addr := strings.TrimSpace(cfg.BridgeAddr)
	if addr == "" {
		return nil, errors.New("BridgeAddr is required")
	}
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	cfg.BridgeAddr = addr
	if cfg.ClientKey == "" {
		cfg.ClientKey = "default"
	}
	if cfg.SessionCount <= 0 {
		cfg.SessionCount = 2
	}
	log := cfg.Logger
	if log == nil {
		log = logger.Default()
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		cfg:    cfg,
		log:    log,
		ctx:    ctx,
		cancel: cancel,
	}, nil
}

func (c *Client) Start() {
	isMulti := strings.EqualFold(c.cfg.Mode, "multi") || strings.EqualFold(c.cfg.Mode, "tclient")
	workers := c.cfg.SessionCount
	if isMulti {
		workers = 1
	}

	for i := 0; i < workers; i++ {
		c.wg.Add(1)
		go func(idx int) {
			defer c.wg.Done()
			backoff := time.Second
			for {
				select {
				case <-c.ctx.Done():
					return
				default:
				}

				started := time.Now()
				if isMulti {
					c.runMultiLinkLoop()
				} else {
					c.runMuxLoop(idx)
				}

				if time.Since(started) > 15*time.Second {
					backoff = time.Second
				} else if backoff < 8*time.Second {
					backoff *= 2
				}

				select {
				case <-c.ctx.Done():
					return
				case <-time.After(backoff):
				}
			}
		}(i)
	}
}

func (c *Client) Stop() {
	c.cancel()
	c.wg.Wait()
}

func (c *Client) dialBridge() (net.Conn, error) {
	return Dial(c.ctx, c.cfg.Proto, c.cfg.BridgeAddr, c.cfg.Transport)
}

func (c *Client) dialTarget(rawTarget string) (net.Conn, error) {
	t := strings.TrimSpace(rawTarget)
	if c.cfg.InProcessDial != nil {
		if t == "" || t == "browser-go" || t == "inproc" || t == c.cfg.DefaultTargetAddr || strings.HasSuffix(t, ":0") {
			return c.cfg.InProcessDial()
		}
	}
	if t == "" && c.cfg.DefaultTargetAddr != "" {
		t = c.cfg.DefaultTargetAddr
	}
	host, _, err := net.SplitHostPort(t)
	if err != nil {
		return nil, fmt.Errorf("invalid tunnel target %q", t)
	}
	// Restrict tunnel dial strictly to loopback on the browser worker host to prevent lateral LAN SSRF
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return nil, fmt.Errorf("blocked non-loopback tunnel target %q on browser node", t)
	}
	var d net.Dialer
	d.Timeout = 8 * time.Second
	return d.DialContext(c.ctx, "tcp", t)
}

func (c *Client) runMuxLoop(idx int) {
	conn, err := c.dialBridge()
	if err != nil {
		c.log.Warnf("pftunnel[%d] connect %s (%s) failed: %v", idx, c.cfg.BridgeAddr, c.cfg.Proto, err)
		return
	}
	hsBytes, _ := json.Marshal(TunnelHandshake{
		Action:    "mux_client",
		ClientKey: c.cfg.ClientKey,
		NodeTags:  c.cfg.NodeTags,
	})
	hsBytes = append(hsBytes, '\n')
	if _, err := conn.Write(hsBytes); err != nil {
		_ = conn.Close()
		return
	}

	br := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := br.ReadString('\n')
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil || !strings.HasPrefix(line, "OK") {
		c.log.Warnf("pftunnel[%d] bridge rejected handshake: %s", idx, strings.TrimSpace(line))
		_ = conn.Close()
		return
	}

	c.log.Infof("pftunnel[%d] connected to Bridge %s (key=%s, proto=%s, p2p=%v)",
		idx, c.cfg.BridgeAddr, c.cfg.ClientKey, c.cfg.Proto, c.cfg.EnableP2P)

	sess := NewMuxSession(newPeekConn(conn, br), false)
	go func() {
		select {
		case <-c.ctx.Done():
			_ = sess.Close()
		case <-sess.Done():
		}
	}()

	for {
		st, err := sess.AcceptStream()
		if err != nil {
			return
		}
		go c.handleMuxStream(st)
	}
}

func (c *Client) handleMuxStream(stream net.Conn) {
	defer func() { _ = stream.Close() }()
	_ = stream.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(stream)
	line, err := br.ReadBytes('\n')
	_ = stream.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}

	var req TunnelOpenReq
	if err := json.Unmarshal(bytes.TrimSpace(line), &req); err != nil {
		return
	}

	if req.Mode == "p2p_offer" {
		c.handleP2POffer(stream, req)
		return
	}

	targetConn, err := c.dialTarget(req.Target)
	if err != nil {
		c.log.Debugf("pftunnel target dial %q failed: %v", req.Target, err)
		_, _ = stream.Write([]byte("ERR dial target\n"))
		return
	}
	defer func() { _ = targetConn.Close() }()

	if _, err := stream.Write([]byte("OK\n")); err != nil {
		return
	}

	c.ActiveStreams.Add(1)
	defer c.ActiveStreams.Add(-1)

	inB, outB := RelayBidirectional(newPeekConn(stream, br), targetConn)
	c.BytesIn.Add(inB)
	c.BytesOut.Add(outB)
}

func (c *Client) handleP2POffer(ctrlStream net.Conn, req TunnelOpenReq) {
	if !c.cfg.EnableP2P {
		b, _ := json.Marshal(p2pAnswer{OK: false, Error: "client --pf-p2p not enabled"})
		_, _ = ctrlStream.Write(append(b, '\n'))
		return
	}
	uConn, _, cliCands, err := probeBridgeP2PCandidates(c.cfg.BridgeAddr, c.cfg.ClientKey)
	if err != nil {
		b, _ := json.Marshal(p2pAnswer{OK: false, Error: err.Error()})
		_, _ = ctrlStream.Write(append(b, '\n'))
		return
	}
	ansBytes, _ := json.Marshal(p2pAnswer{
		OK:         true,
		Candidates: cliCands,
		Secret:     req.P2PSecret,
		ConvID:     req.P2PConvID,
	})
	if _, err := ctrlStream.Write(append(ansBytes, '\n')); err != nil {
		_ = uConn.Close()
		return
	}

	go func() {
		peerAddr, err := punchUDPHole(uConn, req.P2PCandidates, req.P2PSecret, 1100*time.Millisecond)
		if err != nil {
			_ = uConn.Close()
			return
		}
		c.log.Infof("pftunnel punched direct P2P UDP hole to %s", peerAddr.String())

		filtered := &p2pFilteredPacketConn{UDPConn: uConn}
		ln, err := ServeKCPOnPacketConn(filtered, req.P2PSecret)
		if err != nil {
			_ = uConn.Close()
			return
		}
		defer func() { _ = ln.Close() }()

		type acceptRes struct {
			conn net.Conn
			err  error
		}
		ch := make(chan acceptRes, 1)
		go func() {
			kConn, kErr := ln.Accept()
			ch <- acceptRes{conn: kConn, err: kErr}
		}()

		select {
		case res := <-ch:
			if res.err != nil {
				return
			}
			defer func() { _ = res.conn.Close() }()
			var synHdr [3]byte
			_ = res.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, err := io.ReadFull(res.conn, synHdr[:]); err != nil {
				return
			}
			_ = res.conn.SetReadDeadline(time.Time{})

			targetConn, err := c.dialTarget(req.Target)
			if err != nil {
				_, _ = res.conn.Write([]byte("ERR dial target\n"))
				return
			}
			defer func() { _ = targetConn.Close() }()
			if _, err := res.conn.Write([]byte("OK\n")); err != nil {
				return
			}
			c.ActiveStreams.Add(1)
			defer c.ActiveStreams.Add(-1)
			inB, outB := RelayBidirectional(res.conn, targetConn)
			c.P2PDirect.Add(inB + outB)
		case <-time.After(5 * time.Second):
		case <-c.ctx.Done():
		}
	}()
}

func (c *Client) runMultiLinkLoop() {
	conn, err := c.dialBridge()
	if err != nil {
		c.log.Warnf("pftunnel(tclient) connect %s failed: %v", c.cfg.BridgeAddr, err)
		return
	}
	defer func() { _ = conn.Close() }()

	hs, _ := json.Marshal(TunnelHandshake{Action: "t_client_ctrl", ClientKey: c.cfg.ClientKey})
	hs = append(hs, '\n')
	if _, err := conn.Write(hs); err != nil {
		return
	}
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "OK") {
		c.log.Warnf("pftunnel(tclient) rejected: %s", strings.TrimSpace(line))
		return
	}
	c.log.Infof("pftunnel(tclient) registered on TBridge %s (key=%s)", c.cfg.BridgeAddr, c.cfg.ClientKey)

	done := make(chan struct{})
	defer close(done)
	var writeMu sync.Mutex
	go func() {
		tk := time.NewTicker(15 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-tk.C:
				b, _ := json.Marshal(tunnelCtrlMsg{Cmd: "ping"})
				b = append(b, '\n')
				writeMu.Lock()
				_, _ = conn.Write(b)
				writeMu.Unlock()
			case <-c.ctx.Done():
				_ = conn.Close()
				return
			case <-done:
				return
			}
		}
	}()

	sc := bufio.NewScanner(br)
	for sc.Scan() {
		var m tunnelCtrlMsg
		if json.Unmarshal(sc.Bytes(), &m) == nil && m.Cmd == "dial" {
			go c.openMultiLinkWorker(m)
		}
	}
}

func (c *Client) openMultiLinkWorker(m tunnelCtrlMsg) {
	targetConn, err := c.dialTarget(m.Target)
	if err != nil {
		return
	}
	defer func() { _ = targetConn.Close() }()

	bConn, err := c.dialBridge()
	if err != nil {
		return
	}
	defer func() { _ = bConn.Close() }()

	hs, _ := json.Marshal(TunnelHandshake{Action: "t_client_worker", Token: m.Token})
	hs = append(hs, '\n')
	if _, err := bConn.Write(hs); err != nil {
		return
	}

	c.ActiveStreams.Add(1)
	defer c.ActiveStreams.Add(-1)
	inB, outB := RelayBidirectional(bConn, targetConn)
	c.BytesIn.Add(inB)
	c.BytesOut.Add(outB)
}

// --- Optional ProxyForge Admin Cluster Hub (:55333) Telemetry Reporter ---

type clusterWireMsg struct {
	Type            string   `json:"type"`
	AgentID         string   `json:"agent_id,omitempty"`
	Nonce           string   `json:"nonce,omitempty"`
	Timestamp       int64    `json:"ts,omitempty"`
	Signature       string   `json:"sig,omitempty"`
	OK              bool     `json:"ok,omitempty"`
	Error           string   `json:"error,omitempty"`
	Hostname        string   `json:"hostname,omitempty"`
	OSArch          string   `json:"os_arch,omitempty"`
	Version         string   `json:"version,omitempty"`
	ActiveConns     int      `json:"active_conns,omitempty"`
	BytesIn         int64    `json:"bytes_in,omitempty"`
	BytesOut        int64    `json:"bytes_out,omitempty"`
	RunningServices int      `json:"running_services,omitempty"`
	DesiredServices int      `json:"desired_services,omitempty"`
	RecentLogs      []string `json:"recent_logs,omitempty"`
}

func signClusterFrame(secretKey, msgType, agentID, nonce string, ts int64, okFlag bool) string {
	mac := hmac.New(sha256.New, []byte(secretKey))
	mac.Write([]byte(fmt.Sprintf("%s|%s|%s|%d|%t|", msgType, agentID, nonce, ts, okFlag)))
	return hex.EncodeToString(mac.Sum(nil))
}

// StartClusterHubReporter connects to ProxyForge Admin's Cluster Hub (:55333) and reports live Browser-Go metrics.
func StartClusterHubReporter(
	ctx context.Context,
	hubAddr, secretKey, agentID, caBundle, tlsPin, appVersion string,
	log *logger.Logger,
	statsFn func() (activeConns int, bytesIn, bytesOut int64, runningInstances int),
) {
	if strings.TrimSpace(hubAddr) == "" || strings.TrimSpace(secretKey) == "" {
		return
	}
	if log == nil {
		log = logger.Default()
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			default:
			}

			conn, err := Dial(ctx, "tls", hubAddr, TransportOptions{
				SingleTLS:    true,
				CABundleSpec: caBundle,
				TLSPinSHA256: tlsPin,
				Timeout:      8 * time.Second,
			})
			if err != nil {
				log.Warnf("Cluster Hub %s unreachable: %v", hubAddr, err)
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
					continue
				}
			}

			var nb [16]byte
			_, _ = rand.Read(nb[:])
			nonce := hex.EncodeToString(nb[:])
			hostname, _ := os.Hostname()
			ts := time.Now().Unix()

			reg := clusterWireMsg{
				Type:      "register",
				AgentID:   agentID,
				Nonce:     nonce,
				Timestamp: ts,
				Signature: signClusterFrame(secretKey, "register", agentID, nonce, ts, false),
				Hostname:  hostname,
				OSArch:    runtime.GOOS + "/" + runtime.GOARCH,
				Version:   "browser-go-" + appVersion,
			}
			b, _ := json.Marshal(reg)
			if _, err := conn.Write(append(b, '\n')); err != nil {
				_ = conn.Close()
				continue
			}

			br := bufio.NewReader(conn)
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			ackLine, err := br.ReadBytes('\n')
			_ = conn.SetReadDeadline(time.Time{})
			var ack clusterWireMsg
			if err != nil || json.Unmarshal(bytes.TrimSpace(ackLine), &ack) != nil || !ack.OK {
				log.Warnf("Cluster Hub rejected node [%s]: %s", agentID, ack.Error)
				_ = conn.Close()
				select {
				case <-ctx.Done():
					return
				case <-time.After(5 * time.Second):
					continue
				}
			}

			log.Infof("Registered Browser-Go node [%s] on ProxyForge Cluster Hub %s", agentID, hubAddr)

			// Drain incoming hub messages so socket receive buffer stays clear
			connClosed := make(chan struct{})
			go func() {
				defer close(connClosed)
				sc := bufio.NewScanner(br)
				sc.Buffer(make([]byte, 64*1024), 1024*1024)
				for sc.Scan() {
				}
			}()

			tk := time.NewTicker(5 * time.Second)
		hbLoop:
			for {
				select {
				case <-ctx.Done():
					tk.Stop()
					_ = conn.Close()
					return
				case <-connClosed:
					tk.Stop()
					_ = conn.Close()
					break hbLoop
				case <-tk.C:
					act, bIn, bOut, instCount := statsFn()
					nowTS := time.Now().Unix()
					hb := clusterWireMsg{
						Type:            "heartbeat",
						AgentID:         agentID,
						Nonce:           nonce,
						Timestamp:       nowTS,
						Signature:       signClusterFrame(secretKey, "heartbeat", agentID, nonce, nowTS, false),
						ActiveConns:     act,
						BytesIn:         bIn,
						BytesOut:        bOut,
						RunningServices: instCount,
						DesiredServices: instCount,
						RecentLogs:      log.Tail(20),
					}
					hbBytes, _ := json.Marshal(hb)
					_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
					if _, err := conn.Write(append(hbBytes, '\n')); err != nil {
						tk.Stop()
						_ = conn.Close()
						break hbLoop
					}
					_ = conn.SetWriteDeadline(time.Time{})
				}
			}
		}
	}()
}
