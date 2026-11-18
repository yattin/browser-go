package pftunnel

import (
	"bufio"
	"bytes"
	"compress/flate"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"
	"golang.org/x/crypto/hkdf"
	"golang.org/x/crypto/pbkdf2"
)

const (
	aeadSaltSize     = 32
	aeadMaxChunkSize = 16384
	wsGUID           = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
)

// KCPConfig matches ProxyForge's xtaci/kcp-go/v5 wire settings.
type KCPConfig struct {
	Method      string
	Key         string
	Mode        string
	MTU         int
	SndWnd      int
	RcvWnd      int
	DataShard   int
	ParityShard int
	NoComp      bool
}

func normalizeKCP(cfg KCPConfig) KCPConfig {
	if strings.TrimSpace(cfg.Method) == "" {
		cfg.Method = "aes"
	}
	if cfg.Key == "" {
		cfg.Key = "secrect"
	}
	if strings.TrimSpace(cfg.Mode) == "" {
		cfg.Mode = "fast"
	}
	if cfg.MTU <= 0 {
		cfg.MTU = 1350
	}
	if cfg.SndWnd <= 0 {
		cfg.SndWnd = 1024
	}
	if cfg.RcvWnd <= 0 {
		cfg.RcvWnd = 1024
	}
	if cfg.DataShard < 0 {
		cfg.DataShard = 10
	}
	if cfg.ParityShard < 0 {
		cfg.ParityShard = 3
	}
	if cfg.DataShard == 0 && cfg.ParityShard == 0 {
		cfg.DataShard = 10
		cfg.ParityShard = 3
	}
	return cfg
}

// TransportOptions configures Listen and Dial across tcp, tls, ws, wss, and kcp.
type TransportOptions struct {
	CertSpec       string
	KeySpec        string
	CABundleSpec   string
	TLSPinSHA256   string
	SingleTLS      bool
	WSPath         string
	KCP            KCPConfig
	CustomPassword string // -z / -Z AES-256-GCM
	Compress       bool   // -m / -M Flate
	Timeout        time.Duration
}

// Dial connects to a ProxyForge endpoint using proto ("tls", "tcp", "ws", "wss", "kcp").
func Dial(ctx context.Context, proto, addr string, opts TransportOptions) (net.Conn, error) {
	p := strings.ToLower(strings.TrimSpace(proto))
	if p == "" {
		p = "tls"
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	if p == "kcp" {
		c, err := DialKCP(addr, opts.KCP)
		if err != nil {
			return nil, err
		}
		if opts.CustomPassword != "" {
			c = WrapAES256Password(c, opts.CustomPassword)
		}
		if opts.Compress {
			c = WrapCompression(c)
		}
		return c, nil
	}

	wsPath := opts.WSPath
	dialAddr := addr
	if idx := strings.Index(dialAddr, "/"); idx > 0 {
		wsPath = dialAddr[idx:]
		dialAddr = dialAddr[:idx]
	}

	var d net.Dialer
	d.Timeout = timeout
	rawConn, err := d.DialContext(ctx, "tcp", dialAddr)
	if err != nil {
		return nil, err
	}

	if p == "tls" || p == "wss" {
		tlsCfg, err := BuildClientTLSConfig(opts.CertSpec, opts.KeySpec, opts.CABundleSpec, opts.TLSPinSHA256, dialAddr, opts.SingleTLS)
		if err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		tlsConn := tls.Client(rawConn, tlsCfg)
		_ = tlsConn.SetDeadline(time.Now().Add(timeout))
		if err := tlsConn.Handshake(); err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		_ = tlsConn.SetDeadline(time.Time{})
		rawConn = tlsConn
	}

	if p == "ws" || p == "wss" {
		wsC, err := clientWSStreamHandshake(rawConn, dialAddr, wsPath)
		if err != nil {
			_ = rawConn.Close()
			return nil, err
		}
		rawConn = wsC
	}

	if opts.CustomPassword != "" {
		rawConn = WrapAES256Password(rawConn, opts.CustomPassword)
	}
	if opts.Compress {
		rawConn = WrapCompression(rawConn)
	}
	return rawConn, nil
}

// Listen creates a ProxyForge-compatible transport listener.
func Listen(proto, addr string, opts TransportOptions) (net.Listener, error) {
	p := strings.ToLower(strings.TrimSpace(proto))
	if p == "" {
		p = "tls"
	}
	var base net.Listener
	var err error
	switch p {
	case "tcp", "ws":
		base, err = net.Listen("tcp", addr)
	case "tls", "wss":
		tlsCfg, err2 := ServerTLSConfig(opts.CertSpec, opts.KeySpec, opts.SingleTLS)
		if err2 != nil {
			return nil, err2
		}
		base, err = tls.Listen("tcp", addr, tlsCfg)
	case "kcp":
		base, err = ListenKCP(addr, opts.KCP)
	default:
		return nil, fmt.Errorf("unsupported transport %q", proto)
	}
	if err != nil {
		return nil, err
	}
	return &wrappedListener{Listener: base, proto: p, opts: opts}, nil
}

type wrappedListener struct {
	net.Listener
	proto string
	opts  TransportOptions
}

func (l *wrappedListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if l.proto == "ws" || l.proto == "wss" {
			wsC, err := serverWSStreamHandshake(c, l.opts.WSPath)
			if err != nil {
				_ = c.Close()
				continue
			}
			c = wsC
		}
		if l.opts.CustomPassword != "" {
			c = WrapAES256Password(c, l.opts.CustomPassword)
		}
		if l.opts.Compress {
			c = WrapCompression(c)
		}
		return c, nil
	}
}

// --- KCP+FEC Wire Primitives ---

func NewKCPBlockCrypt(method, pass string) (kcp.BlockCrypt, error) {
	if pass == "" {
		pass = "secrect"
	}
	key := pbkdf2.Key([]byte(pass), []byte("kcp-go"), 4096, 32, sha1.New)
	switch strings.ToLower(strings.TrimSpace(method)) {
	case "none", "null":
		return nil, nil
	case "aes-128":
		return kcp.NewAESBlockCrypt(key[:16])
	case "aes-192":
		return kcp.NewAESBlockCrypt(key[:24])
	case "aes-gcm", "aes-256-gcm":
		return kcp.NewAESGCMCrypt(key)
	case "salsa20":
		return kcp.NewSalsa20BlockCrypt(key)
	case "blowfish":
		return kcp.NewBlowfishBlockCrypt(key)
	case "twofish":
		return kcp.NewTwofishBlockCrypt(key)
	case "cast5":
		return kcp.NewCast5BlockCrypt(key[:16])
	case "3des":
		return kcp.NewTripleDESBlockCrypt(key[:24])
	case "tea":
		return kcp.NewTEABlockCrypt(key[:16])
	case "xtea":
		return kcp.NewXTEABlockCrypt(key[:16])
	case "xor":
		return kcp.NewSimpleXORBlockCrypt(key)
	case "sm4":
		return kcp.NewSM4BlockCrypt(key[:16])
	default:
		return kcp.NewAESBlockCrypt(key)
	}
}

func tuneKCPSession(sess *kcp.UDPSession, cfg KCPConfig) {
	sess.SetStreamMode(true)
	sess.SetWriteDelay(false)
	switch strings.ToLower(cfg.Mode) {
	case "normal":
		sess.SetNoDelay(0, 40, 2, 1)
	case "fast2":
		sess.SetNoDelay(1, 20, 2, 1)
	case "fast3":
		sess.SetNoDelay(1, 10, 2, 1)
	default:
		sess.SetNoDelay(0, 30, 2, 1)
	}
	sess.SetMtu(cfg.MTU)
	sess.SetWindowSize(cfg.SndWnd, cfg.RcvWnd)
	sess.SetACKNoDelay(true)
}

type kcpListenerWrap struct {
	*kcp.Listener
	cfg KCPConfig
}

func (l *kcpListenerWrap) Accept() (net.Conn, error) {
	s, err := l.Listener.AcceptKCP()
	if err != nil {
		return nil, err
	}
	tuneKCPSession(s, l.cfg)
	return s, nil
}

func ListenKCP(addr string, cfg KCPConfig) (net.Listener, error) {
	cfg = normalizeKCP(cfg)
	block, err := NewKCPBlockCrypt(cfg.Method, cfg.Key)
	if err != nil {
		return nil, err
	}
	ln, err := kcp.ListenWithOptions(addr, block, cfg.DataShard, cfg.ParityShard)
	if err != nil {
		return nil, err
	}
	_ = ln.SetReadBuffer(4 * 1024 * 1024)
	_ = ln.SetWriteBuffer(4 * 1024 * 1024)
	return &kcpListenerWrap{Listener: ln, cfg: cfg}, nil
}

func DialKCP(addr string, cfg KCPConfig) (net.Conn, error) {
	cfg = normalizeKCP(cfg)
	block, err := NewKCPBlockCrypt(cfg.Method, cfg.Key)
	if err != nil {
		return nil, err
	}
	sess, err := kcp.DialWithOptions(addr, block, cfg.DataShard, cfg.ParityShard)
	if err != nil {
		return nil, err
	}
	_ = sess.SetReadBuffer(4 * 1024 * 1024)
	_ = sess.SetWriteBuffer(4 * 1024 * 1024)
	tuneKCPSession(sess, cfg)
	return sess, nil
}

func ServeKCPOnPacketConn(pconn net.PacketConn, secret string) (net.Listener, error) {
	cfg := normalizeKCP(KCPConfig{Method: "aes", Key: secret, Mode: "fast3"})
	block, err := NewKCPBlockCrypt(cfg.Method, cfg.Key)
	if err != nil {
		return nil, err
	}
	ln, err := kcp.ServeConn(block, cfg.DataShard, cfg.ParityShard, pconn)
	if err != nil {
		return nil, err
	}
	return &kcpListenerWrap{Listener: ln, cfg: cfg}, nil
}

func DialKCPOnPacketConn(convID uint32, peerAddr net.Addr, pconn net.PacketConn, secret string) (net.Conn, error) {
	cfg := normalizeKCP(KCPConfig{Method: "aes", Key: secret, Mode: "fast3"})
	block, err := NewKCPBlockCrypt(cfg.Method, cfg.Key)
	if err != nil {
		return nil, err
	}
	sess, err := kcp.NewConn3(convID, peerAddr, block, cfg.DataShard, cfg.ParityShard, pconn)
	if err != nil {
		return nil, err
	}
	tuneKCPSession(sess, cfg)
	return sess, nil
}

// --- AES-256-GCM (-z / -Z) & Flate (-m / -M) Wire Wrappers ---

func WrapAES256Password(c net.Conn, password string) net.Conn {
	if password == "" {
		return c
	}
	masterKey := pbkdf2.Key([]byte(password), []byte("proxyforge-z-master-v2"), 4096, 32, sha256.New)
	return &aesPasswordConn{Conn: c, masterKey: masterKey}
}

type aesPasswordConn struct {
	net.Conn
	masterKey []byte
	rMu       sync.Mutex
	rAEAD     cipher.AEAD
	rNonce    []byte
	rBuf      bytes.Buffer
	wMu       sync.Mutex
	wAEAD     cipher.AEAD
	wNonce    []byte
}

func deriveZSubKey(masterKey, salt []byte) (cipher.AEAD, error) {
	subKey := make([]byte, 32)
	r := hkdf.New(sha256.New, masterKey, salt, []byte("proxyforge-z-aead-subkey"))
	if _, err := io.ReadFull(r, subKey); err != nil {
		return nil, err
	}
	blk, err := aes.NewCipher(subKey)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

func incNonce(n []byte) {
	for i := range n {
		n[i]++
		if n[i] != 0 {
			break
		}
	}
}

func (c *aesPasswordConn) Read(p []byte) (int, error) {
	c.rMu.Lock()
	defer c.rMu.Unlock()
	if c.rBuf.Len() > 0 {
		return c.rBuf.Read(p)
	}
	if c.rAEAD == nil {
		var salt [aeadSaltSize]byte
		if _, err := io.ReadFull(c.Conn, salt[:]); err != nil {
			return 0, err
		}
		aead, err := deriveZSubKey(c.masterKey, salt[:])
		if err != nil {
			return 0, err
		}
		c.rAEAD = aead
		c.rNonce = make([]byte, aead.NonceSize())
	}
	ov := c.rAEAD.Overhead()
	encLen := make([]byte, 2+ov)
	if _, err := io.ReadFull(c.Conn, encLen); err != nil {
		return 0, err
	}
	lenPlain, err := c.rAEAD.Open(nil, c.rNonce, encLen, nil)
	if err != nil {
		return 0, err
	}
	incNonce(c.rNonce)
	chunkLen := int(binary.BigEndian.Uint16(lenPlain))
	if chunkLen == 0 || chunkLen > aeadMaxChunkSize {
		return 0, fmt.Errorf("invalid z-aead chunk %d", chunkLen)
	}
	encPayload := make([]byte, chunkLen+ov)
	if _, err := io.ReadFull(c.Conn, encPayload); err != nil {
		return 0, err
	}
	plain, err := c.rAEAD.Open(nil, c.rNonce, encPayload, nil)
	if err != nil {
		return 0, err
	}
	incNonce(c.rNonce)
	c.rBuf.Write(plain)
	return c.rBuf.Read(p)
}

func (c *aesPasswordConn) Write(p []byte) (int, error) {
	c.wMu.Lock()
	defer c.wMu.Unlock()
	if c.wAEAD == nil {
		var salt [aeadSaltSize]byte
		_, _ = rand.Read(salt[:])
		aead, err := deriveZSubKey(c.masterKey, salt[:])
		if err != nil {
			return 0, err
		}
		if _, err := c.Conn.Write(salt[:]); err != nil {
			return 0, err
		}
		c.wAEAD = aead
		c.wNonce = make([]byte, aead.NonceSize())
	}
	total := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > aeadMaxChunkSize {
			chunk = chunk[:aeadMaxChunkSize]
		}
		var lenBuf [2]byte
		binary.BigEndian.PutUint16(lenBuf[:], uint16(len(chunk)))
		encLen := c.wAEAD.Seal(nil, c.wNonce, lenBuf[:], nil)
		incNonce(c.wNonce)
		encData := c.wAEAD.Seal(nil, c.wNonce, chunk, nil)
		incNonce(c.wNonce)
		frame := make([]byte, len(encLen)+len(encData))
		copy(frame, encLen)
		copy(frame[len(encLen):], encData)
		if _, err := c.Conn.Write(frame); err != nil {
			return total, err
		}
		total += len(chunk)
		p = p[len(chunk):]
	}
	return total, nil
}

func WrapCompression(c net.Conn) net.Conn {
	return &compressedConn{Conn: c}
}

type compressedConn struct {
	net.Conn
	rMu  sync.Mutex
	rBuf bytes.Buffer
	wMu  sync.Mutex
}

func (c *compressedConn) Read(p []byte) (int, error) {
	c.rMu.Lock()
	defer c.rMu.Unlock()
	if c.rBuf.Len() > 0 {
		return c.rBuf.Read(p)
	}
	var hdr [8]byte
	if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
		return 0, err
	}
	compLen := binary.BigEndian.Uint32(hdr[0:4])
	rawLen := binary.BigEndian.Uint32(hdr[4:8])
	if compLen > 16*1024*1024 || rawLen > 32*1024*1024 {
		return 0, fmt.Errorf("compressed frame exceeds limit")
	}
	compBuf := make([]byte, compLen)
	if _, err := io.ReadFull(c.Conn, compBuf); err != nil {
		return 0, err
	}
	fr := flate.NewReader(bytes.NewReader(compBuf))
	rawBuf := make([]byte, rawLen)
	_, err := io.ReadFull(fr, rawBuf)
	_ = fr.Close()
	if err != nil {
		return 0, err
	}
	c.rBuf.Write(rawBuf)
	return c.rBuf.Read(p)
}

func (c *compressedConn) Write(p []byte) (int, error) {
	c.wMu.Lock()
	defer c.wMu.Unlock()
	total := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > 65536 {
			chunk = chunk[:65536]
		}
		var b bytes.Buffer
		fw, err := flate.NewWriter(&b, flate.BestSpeed)
		if err != nil {
			return total, err
		}
		_, _ = fw.Write(chunk)
		_ = fw.Close()
		comp := b.Bytes()
		frame := make([]byte, 8+len(comp))
		binary.BigEndian.PutUint32(frame[0:4], uint32(len(comp)))
		binary.BigEndian.PutUint32(frame[4:8], uint32(len(chunk)))
		copy(frame[8:], comp)
		if _, err := c.Conn.Write(frame); err != nil {
			return total, err
		}
		total += len(chunk)
		p = p[len(chunk):]
	}
	return total, nil
}

// --- RFC 6455 Binary Stream WebSocket Transport (-t ws / wss) ---

func computeWSAccept(key string) string {
	h := sha1.New()
	h.Write([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func clientWSStreamHandshake(conn net.Conn, host, reqPath string) (net.Conn, error) {
	if reqPath == "" || !strings.HasPrefix(reqPath, "/") {
		reqPath = "/" + reqPath
	}
	var keyRaw [16]byte
	_, _ = rand.Read(keyRaw[:])
	secKey := base64.StdEncoding.EncodeToString(keyRaw[:])
	req := fmt.Sprintf("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n", reqPath, host, secKey)
	if _, err := conn.Write([]byte(req)); err != nil {
		return nil, err
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols || resp.Header.Get("Sec-WebSocket-Accept") != computeWSAccept(secKey) {
		return nil, fmt.Errorf("ws transport handshake failed (%d)", resp.StatusCode)
	}
	return &wsStreamConn{Conn: conn, br: br, isClient: true}, nil
}

func serverWSStreamHandshake(conn net.Conn, expectedPath string) (net.Conn, error) {
	br := bufio.NewReader(conn)
	req, err := http.ReadRequest(br)
	if err != nil {
		return nil, err
	}
	if expectedPath != "" && expectedPath != "/" && req.URL.Path != expectedPath {
		_, _ = conn.Write([]byte("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"))
		return nil, fmt.Errorf("unexpected ws path %q", req.URL.Path)
	}
	secKey := strings.TrimSpace(req.Header.Get("Sec-WebSocket-Key"))
	if secKey == "" {
		return nil, fmt.Errorf("missing Sec-WebSocket-Key")
	}
	resp := fmt.Sprintf("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", computeWSAccept(secKey))
	if _, err := conn.Write([]byte(resp)); err != nil {
		return nil, err
	}
	return &wsStreamConn{Conn: conn, br: br, isClient: false}, nil
}

type wsStreamConn struct {
	net.Conn
	br       *bufio.Reader
	isClient bool
	rMu      sync.Mutex
	rBuf     bytes.Buffer
	wMu      sync.Mutex
}

func (w *wsStreamConn) Read(p []byte) (int, error) {
	w.rMu.Lock()
	defer w.rMu.Unlock()
	for w.rBuf.Len() == 0 {
		var hdr [2]byte
		if _, err := io.ReadFull(w.br, hdr[:]); err != nil {
			return 0, err
		}
		opcode := hdr[0] & 0x0F
		masked := (hdr[1] & 0x80) != 0
		length := uint64(hdr[1] & 0x7F)
		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(w.br, ext[:]); err != nil {
				return 0, err
			}
			length = uint64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(w.br, ext[:]); err != nil {
				return 0, err
			}
			length = uint64(binary.BigEndian.Uint64(ext[:]))
		}
		if length > 32*1024*1024 {
			return 0, fmt.Errorf("ws frame too large")
		}
		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(w.br, maskKey[:]); err != nil {
				return 0, err
			}
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(w.br, payload); err != nil {
			return 0, err
		}
		if masked {
			for i := range payload {
				payload[i] ^= maskKey[i&3]
			}
		}
		switch opcode {
		case 0x0, 0x1, 0x2:
			w.rBuf.Write(payload)
		case 0x8:
			return 0, io.EOF
		case 0x9:
			_ = w.writeFrame(0xA, payload)
		}
	}
	return w.rBuf.Read(p)
}

func (w *wsStreamConn) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		chunk := p
		if len(chunk) > 32768 {
			chunk = chunk[:32768]
		}
		if err := w.writeFrame(0x2, chunk); err != nil {
			return total, err
		}
		total += len(chunk)
		p = p[len(chunk):]
	}
	return total, nil
}

func (w *wsStreamConn) writeFrame(opcode byte, payload []byte) error {
	w.wMu.Lock()
	defer w.wMu.Unlock()
	var buf bytes.Buffer
	buf.WriteByte(0x80 | opcode)
	maskBit := byte(0)
	if w.isClient {
		maskBit = 0x80
	}
	n := len(payload)
	switch {
	case n < 126:
		buf.WriteByte(maskBit | byte(n))
	case n <= 65535:
		buf.WriteByte(maskBit | 126)
		var ext [2]byte
		binary.BigEndian.PutUint16(ext[:], uint16(n))
		buf.Write(ext[:])
	default:
		buf.WriteByte(maskBit | 127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		buf.Write(ext[:])
	}
	if w.isClient {
		var mask [4]byte
		_, _ = rand.Read(mask[:])
		buf.Write(mask[:])
		masked := make([]byte, n)
		for i := range payload {
			masked[i] = payload[i] ^ mask[i&3]
		}
		buf.Write(masked)
	} else {
		buf.Write(payload)
	}
	_, err := w.Conn.Write(buf.Bytes())
	return err
}
