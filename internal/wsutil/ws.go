package wsutil

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	wsGUID         = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	MaxMessageSize = 64 * 1024 * 1024 // 64MB for large CDP screenshots & DOM snapshots

	OpcodeContinuation = 0x0
	OpcodeText         = 0x1
	OpcodeBinary       = 0x2
	OpcodeClose        = 0x8
	OpcodePing         = 0x9
	OpcodePong         = 0xA
)

func ComputeAcceptKey(secKey string) string {
	h := sha1.New()
	h.Write([]byte(strings.TrimSpace(secKey) + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func HasTokenCI(headerVal, token string) bool {
	for _, part := range strings.Split(headerVal, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func IsWebSocketUpgrade(r *http.Request) bool {
	return HasTokenCI(r.Header.Get("Connection"), "upgrade") &&
		strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}

// Conn is a concurrent-safe RFC 6455 message-oriented WebSocket connection.
type Conn struct {
	raw      net.Conn
	br       *bufio.Reader
	isClient bool
	writeMu  sync.Mutex
	closed   atomic.Bool
	onPong   func([]byte)
}

// UpgradeHTTP upgrades an incoming HTTP request into a message-oriented *Conn.
func UpgradeHTTP(w http.ResponseWriter, r *http.Request) (*Conn, error) {
	if !IsWebSocketUpgrade(r) {
		http.Error(w, "Expected WebSocket Upgrade", http.StatusBadRequest)
		return nil, errors.New("not a websocket upgrade request")
	}
	secKey := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if secKey == "" {
		http.Error(w, "Missing Sec-WebSocket-Key", http.StatusBadRequest)
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return nil, errors.New("http.Hijacker not supported")
	}
	rawConn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	_ = rawConn.SetDeadline(time.Time{})

	accept := ComputeAcceptKey(secKey)
	var resp bytes.Buffer
	resp.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	resp.WriteString("Upgrade: websocket\r\n")
	resp.WriteString("Connection: Upgrade\r\n")
	resp.WriteString("Sec-WebSocket-Accept: " + accept + "\r\n")
	if proto := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Protocol")); proto != "" {
		first := strings.TrimSpace(strings.Split(proto, ",")[0])
		if first != "" {
			resp.WriteString("Sec-WebSocket-Protocol: " + first + "\r\n")
		}
	}
	resp.WriteString("\r\n")

	if _, err := rw.Write(resp.Bytes()); err != nil {
		_ = rawConn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = rawConn.Close()
		return nil, err
	}

	return &Conn{
		raw:      rawConn,
		br:       rw.Reader,
		isClient: false,
	}, nil
}

// Dial connects to a ws:// or wss:// URL (optionally using a custom dialer) and returns *Conn.
func Dial(ctx context.Context, rawURL string, headers http.Header, dialFn func(ctx context.Context, network, addr string) (net.Conn, error)) (*Conn, *http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	isTLS := strings.EqualFold(u.Scheme, "wss") || strings.EqualFold(u.Scheme, "https")
	hostPort := u.Host
	if _, _, err := net.SplitHostPort(hostPort); err != nil {
		if isTLS {
			hostPort = net.JoinHostPort(hostPort, "443")
		} else {
			hostPort = net.JoinHostPort(hostPort, "80")
		}
	}

	var netConn net.Conn
	if dialFn != nil {
		netConn, err = dialFn(ctx, "tcp", hostPort)
	} else {
		var d net.Dialer
		d.Timeout = 10 * time.Second
		netConn, err = d.DialContext(ctx, "tcp", hostPort)
	}
	if err != nil {
		return nil, nil, err
	}

	if isTLS {
		serverName, _, _ := net.SplitHostPort(hostPort)
		tlsConn := tls.Client(netConn, &tls.Config{
			ServerName:         serverName,
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true,
		})
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = netConn.Close()
			return nil, nil, err
		}
		netConn = tlsConn
	}

	var keyBytes [16]byte
	_, _ = rand.Read(keyBytes[:])
	secKey := base64.StdEncoding.EncodeToString(keyBytes[:])

	reqURI := u.RequestURI()
	if reqURI == "" {
		reqURI = "/"
	}

	var reqBuf bytes.Buffer
	fmt.Fprintf(&reqBuf, "GET %s HTTP/1.1\r\n", reqURI)
	fmt.Fprintf(&reqBuf, "Host: %s\r\n", u.Host)
	reqBuf.WriteString("Upgrade: websocket\r\n")
	reqBuf.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&reqBuf, "Sec-WebSocket-Key: %s\r\n", secKey)
	reqBuf.WriteString("Sec-WebSocket-Version: 13\r\n")
	for k, vals := range headers {
		if strings.EqualFold(k, "Host") || strings.EqualFold(k, "Upgrade") ||
			strings.EqualFold(k, "Connection") || strings.EqualFold(k, "Sec-WebSocket-Key") ||
			strings.EqualFold(k, "Sec-WebSocket-Version") {
			continue
		}
		for _, v := range vals {
			fmt.Fprintf(&reqBuf, "%s: %s\r\n", k, v)
		}
	}
	reqBuf.WriteString("\r\n")

	if _, err := netConn.Write(reqBuf.Bytes()); err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}

	br := bufio.NewReaderSize(netConn, 32*1024)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		_ = netConn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_ = netConn.Close()
		return nil, resp, fmt.Errorf("websocket dial failed with HTTP %d", resp.StatusCode)
	}
	if resp.Header.Get("Sec-WebSocket-Accept") != ComputeAcceptKey(secKey) {
		_ = netConn.Close()
		return nil, resp, errors.New("invalid Sec-WebSocket-Accept from server")
	}

	return &Conn{
		raw:      netConn,
		br:       br,
		isClient: true,
	}, resp, nil
}

func (c *Conn) SetOnPong(fn func([]byte)) {
	c.onPong = fn
}

func (c *Conn) IsClosed() bool {
	return c == nil || c.closed.Load()
}

func (c *Conn) RemoteAddr() net.Addr {
	if c == nil || c.raw == nil {
		return nil
	}
	return c.raw.RemoteAddr()
}

// ReadMessage reads a full (potentially fragmented) text or binary message, auto-handling Ping/Pong/Close.
func (c *Conn) ReadMessage() (opcode byte, data []byte, err error) {
	if c.IsClosed() {
		return 0, nil, io.EOF
	}
	var msgBuf bytes.Buffer
	var msgOpcode byte
	inFragment := false

	for {
		fin, op, payload, ferr := c.readFrame()
		if ferr != nil {
			_ = c.Close(1006, "")
			return 0, nil, ferr
		}

		switch op {
		case OpcodePing:
			_ = c.writeFrame(true, OpcodePong, payload)
			continue
		case OpcodePong:
			if c.onPong != nil {
				c.onPong(payload)
			}
			continue
		case OpcodeClose:
			_ = c.Close(1000, "")
			return OpcodeClose, nil, io.EOF
		case OpcodeText, OpcodeBinary:
			if inFragment {
				_ = c.Close(1002, "unexpected data opcode during fragmentation")
				return 0, nil, errors.New("unexpected data opcode during fragmentation")
			}
			if fin {
				return op, payload, nil
			}
			inFragment = true
			msgOpcode = op
			msgBuf.Write(payload)
		case OpcodeContinuation:
			if !inFragment {
				_ = c.Close(1002, "unexpected continuation frame")
				return 0, nil, errors.New("unexpected continuation frame")
			}
			if msgBuf.Len()+len(payload) > MaxMessageSize {
				_ = c.Close(1009, "message too large")
				return 0, nil, errors.New("websocket message exceeds MaxMessageSize")
			}
			msgBuf.Write(payload)
			if fin {
				return msgOpcode, msgBuf.Bytes(), nil
			}
		default:
			_ = c.Close(1002, "unsupported opcode")
			return 0, nil, fmt.Errorf("unsupported websocket opcode %d", op)
		}
	}
}

func (c *Conn) readFrame() (fin bool, opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(c.br, hdr[:]); err != nil {
		return false, 0, nil, err
	}
	fin = (hdr[0] & 0x80) != 0
	opcode = hdr[0] & 0x0F
	masked := (hdr[1] & 0x80) != 0
	length := uint64(hdr[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(c.br, ext[:]); err != nil {
			return false, 0, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}

	if length > MaxMessageSize {
		return false, 0, nil, fmt.Errorf("websocket frame too large (%d bytes)", length)
	}

	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, maskKey[:]); err != nil {
			return false, 0, nil, err
		}
	}

	if length > 0 {
		payload = make([]byte, int(length))
		if _, err = io.ReadFull(c.br, payload); err != nil {
			return false, 0, nil, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i&3]
			}
		}
	}
	return fin, opcode, payload, nil
}

func (c *Conn) WriteText(msg []byte) error {
	return c.writeFrame(true, OpcodeText, msg)
}

func (c *Conn) WriteBinary(msg []byte) error {
	return c.writeFrame(true, OpcodeBinary, msg)
}

func (c *Conn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.WriteText(b)
}

func (c *Conn) WritePing(payload []byte) error {
	return c.writeFrame(true, OpcodePing, payload)
}

func (c *Conn) Close(code uint16, reason string) error {
	if c == nil {
		return nil
	}
	if c.closed.CompareAndSwap(false, true) {
		var closePayload []byte
		if code > 0 {
			closePayload = make([]byte, 2+len(reason))
			binary.BigEndian.PutUint16(closePayload[:2], code)
			copy(closePayload[2:], reason)
		}
		_ = c.writeCloseFrame(closePayload)
		return c.raw.Close()
	}
	return nil
}

func (c *Conn) writeCloseFrame(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.raw.SetWriteDeadline(time.Now().Add(2 * time.Second))
	return c.writeRawFrameLocked(true, OpcodeClose, payload)
}

func (c *Conn) writeFrame(fin bool, opcode byte, payload []byte) error {
	if c.IsClosed() {
		return io.ErrClosedPipe
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.raw.SetWriteDeadline(time.Now().Add(30 * time.Second))
	err := c.writeRawFrameLocked(fin, opcode, payload)
	_ = c.raw.SetWriteDeadline(time.Time{})
	if err != nil {
		_ = c.raw.Close()
		c.closed.Store(true)
	}
	return err
}

func (c *Conn) writeRawFrameLocked(fin bool, opcode byte, payload []byte) error {
	var hdr [14]byte
	b0 := opcode & 0x0F
	if fin {
		b0 |= 0x80
	}
	hdr[0] = b0

	var maskBit byte
	if c.isClient {
		maskBit = 0x80
	}

	pLen := len(payload)
	hdrLen := 2
	switch {
	case pLen < 126:
		hdr[1] = maskBit | byte(pLen)
	case pLen <= 65535:
		hdr[1] = maskBit | 126
		binary.BigEndian.PutUint16(hdr[2:4], uint16(pLen))
		hdrLen = 4
	default:
		hdr[1] = maskBit | 127
		binary.BigEndian.PutUint64(hdr[2:10], uint64(pLen))
		hdrLen = 10
	}

	if c.isClient {
		var maskKey [4]byte
		_, _ = rand.Read(maskKey[:])
		copy(hdr[hdrLen:hdrLen+4], maskKey[:])
		hdrLen += 4
		if _, err := c.raw.Write(hdr[:hdrLen]); err != nil {
			return err
		}
		if pLen > 0 {
			maskedBuf := make([]byte, pLen)
			for i := 0; i < pLen; i++ {
				maskedBuf[i] = payload[i] ^ maskKey[i&3]
			}
			_, err := c.raw.Write(maskedBuf)
			return err
		}
		return nil
	}

	if _, err := c.raw.Write(hdr[:hdrLen]); err != nil {
		return err
	}
	if pLen > 0 {
		_, err := c.raw.Write(payload)
		return err
	}
	return nil
}

// ProxyRawWebSocket upgrades the upstream targetURL (forwarding extensions like permessage-deflate),
// hijacks the incoming client HTTP request, sends the 101 response, and pipes bytes bidirectionally
// with zero frame-reencoding overhead, invoking onActivity whenever traffic flows.
func ProxyRawWebSocket(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	targetWSURL string,
	dialFn func(ctx context.Context, network, addr string) (net.Conn, error),
	onActivity func(),
) error {
	if !IsWebSocketUpgrade(r) {
		http.Error(w, "Expected WebSocket Upgrade", http.StatusBadRequest)
		return errors.New("not a websocket upgrade request")
	}
	u, err := url.Parse(targetWSURL)
	if err != nil {
		http.Error(w, "Invalid upstream CDP URL", http.StatusInternalServerError)
		return err
	}

	isTLS := strings.EqualFold(u.Scheme, "wss") || strings.EqualFold(u.Scheme, "https")
	hostPort := u.Host
	if _, _, err := net.SplitHostPort(hostPort); err != nil {
		if isTLS {
			hostPort = net.JoinHostPort(hostPort, "443")
		} else {
			hostPort = net.JoinHostPort(hostPort, "80")
		}
	}

	var upConn net.Conn
	if dialFn != nil {
		upConn, err = dialFn(ctx, "tcp", hostPort)
	} else {
		var d net.Dialer
		d.Timeout = 10 * time.Second
		upConn, err = d.DialContext(ctx, "tcp", hostPort)
	}
	if err != nil {
		http.Error(w, "Upstream CDP unreachable: "+err.Error(), http.StatusBadGateway)
		return err
	}
	defer func() { _ = upConn.Close() }()

	if isTLS {
		sni, _, _ := net.SplitHostPort(hostPort)
		tc := tls.Client(upConn, &tls.Config{
			ServerName:         sni,
			MinVersion:         tls.VersionTLS12,
			InsecureSkipVerify: true,
		})
		if err := tc.HandshakeContext(ctx); err != nil {
			http.Error(w, "Upstream TLS handshake failed: "+err.Error(), http.StatusBadGateway)
			return err
		}
		upConn = tc
	}

	secKey := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if secKey == "" {
		var kb [16]byte
		_, _ = rand.Read(kb[:])
		secKey = base64.StdEncoding.EncodeToString(kb[:])
	}
	secVer := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Version"))
	if secVer == "" {
		secVer = "13"
	}

	reqURI := u.RequestURI()
	if reqURI == "" {
		reqURI = "/"
	}

	var upReq bytes.Buffer
	fmt.Fprintf(&upReq, "GET %s HTTP/1.1\r\n", reqURI)
	fmt.Fprintf(&upReq, "Host: %s\r\n", u.Host)
	upReq.WriteString("Upgrade: websocket\r\n")
	upReq.WriteString("Connection: Upgrade\r\n")
	fmt.Fprintf(&upReq, "Sec-WebSocket-Key: %s\r\n", secKey)
	fmt.Fprintf(&upReq, "Sec-WebSocket-Version: %s\r\n", secVer)
	if ext := r.Header.Get("Sec-WebSocket-Extensions"); ext != "" {
		fmt.Fprintf(&upReq, "Sec-WebSocket-Extensions: %s\r\n", ext)
	}
	if proto := r.Header.Get("Sec-WebSocket-Protocol"); proto != "" {
		fmt.Fprintf(&upReq, "Sec-WebSocket-Protocol: %s\r\n", proto)
	}
	upReq.WriteString("\r\n")

	_ = upConn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := upConn.Write(upReq.Bytes()); err != nil {
		http.Error(w, "Upstream write failed", http.StatusBadGateway)
		return err
	}

	upBR := bufio.NewReaderSize(upConn, 32*1024)
	upResp, err := http.ReadResponse(upBR, nil)
	_ = upConn.SetDeadline(time.Time{})
	if err != nil {
		http.Error(w, "Upstream handshake read failed", http.StatusBadGateway)
		return err
	}
	if upResp.StatusCode != http.StatusSwitchingProtocols {
		defer upResp.Body.Close()
		body, _ := io.ReadAll(io.LimitReader(upResp.Body, 4096))
		w.WriteHeader(upResp.StatusCode)
		_, _ = w.Write(body)
		return fmt.Errorf("upstream rejected upgrade with HTTP %d: %s", upResp.StatusCode, strings.TrimSpace(string(body)))
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		return errors.New("http.Hijacker not supported")
	}
	cliConn, cliRW, err := hj.Hijack()
	if err != nil {
		return err
	}
	defer func() { _ = cliConn.Close() }()
	_ = cliConn.SetDeadline(time.Time{})

	var downResp bytes.Buffer
	downResp.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	for k, vals := range upResp.Header {
		for _, v := range vals {
			fmt.Fprintf(&downResp, "%s: %s\r\n", k, v)
		}
	}
	downResp.WriteString("\r\n")

	if _, err := cliRW.Write(downResp.Bytes()); err != nil {
		return err
	}
	if err := cliRW.Flush(); err != nil {
		return err
	}

	// Drain any buffered bytes in cliRW.Reader and upBR before streaming
	cliSrc := io.Reader(cliConn)
	if cliRW.Reader.Buffered() > 0 {
		cliSrc = io.MultiReader(cliRW.Reader, cliConn)
	}
	upSrc := io.Reader(upConn)
	if upBR.Buffered() > 0 {
		upSrc = io.MultiReader(upBR, upConn)
	}

	errCh := make(chan error, 2)
	go func() {
		errCh <- copyWithActivity(upConn, cliSrc, onActivity)
		_ = upConn.Close()
	}()
	go func() {
		errCh <- copyWithActivity(cliConn, upSrc, onActivity)
		_ = cliConn.Close()
	}()

	select {
	case <-ctx.Done():
		_ = cliConn.Close()
		_ = upConn.Close()
		<-errCh
		<-errCh
		return ctx.Err()
	case <-errCh:
		_ = cliConn.Close()
		_ = upConn.Close()
		<-errCh
		return nil
	}
}

func copyWithActivity(dst io.Writer, src io.Reader, onActivity func()) error {
	buf := make([]byte, 32*1024)
	for {
		nr, rerr := src.Read(buf)
		if nr > 0 {
			if onActivity != nil {
				onActivity()
			}
			nw, werr := dst.Write(buf[:nr])
			if werr != nil {
				return werr
			}
			if nw != nr {
				return io.ErrShortWrite
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				return nil
			}
			return rerr
		}
	}
}
