package pftunnel

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

// Wire-compatible 9-byte ProxyForge muxSession frame header:
// [1B Type][4B BigEndian StreamID][4B BigEndian PayloadLen]
const (
	MuxFrameSYN  byte = 1
	MuxFrameDATA byte = 2
	MuxFrameFIN  byte = 3
	MuxFramePING byte = 4
	MuxFramePONG byte = 5
)

type peekConn struct {
	net.Conn
	br *bufio.Reader
}

func newPeekConn(c net.Conn, br *bufio.Reader) net.Conn {
	if br == nil || br.Buffered() == 0 {
		return c
	}
	return &peekConn{Conn: c, br: br}
}

func (p *peekConn) Read(b []byte) (int, error) {
	if p.br != nil {
		return p.br.Read(b)
	}
	return p.Conn.Read(b)
}

func RelayBidirectional(a, b net.Conn) (inBytes, outBytes int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		n, _ := io.Copy(b, a)
		inBytes = n
		_ = b.Close()
	}()
	go func() {
		defer wg.Done()
		n, _ := io.Copy(a, b)
		outBytes = n
		_ = a.Close()
	}()
	wg.Wait()
	return inBytes, outBytes
}

// MuxSession multiplexes concurrent bidirectional streams over a single net.Conn (100% ProxyForge wire-identical).
type MuxSession struct {
	conn     net.Conn
	writeMu  sync.Mutex
	nextID   atomic.Uint32
	acceptCh chan *MuxStream
	doneCh   chan struct{}
	closed   atomic.Bool

	mu      sync.RWMutex
	streams map[uint32]*MuxStream
}

func NewMuxSession(conn net.Conn, isInitiator bool) *MuxSession {
	s := &MuxSession{
		conn:     conn,
		acceptCh: make(chan *MuxStream, 128),
		doneCh:   make(chan struct{}),
		streams:  make(map[uint32]*MuxStream),
	}
	if isInitiator {
		s.nextID.Store(1)
	} else {
		s.nextID.Store(2)
	}
	go s.readLoop()
	go s.keepaliveLoop()
	return s
}

func (s *MuxSession) IsClosed() bool {
	return s == nil || s.closed.Load()
}

func (s *MuxSession) Done() <-chan struct{} {
	return s.doneCh
}

func (s *MuxSession) RemoteAddr() net.Addr {
	if s == nil || s.conn == nil {
		return nil
	}
	return s.conn.RemoteAddr()
}

func (s *MuxSession) OpenStream() (net.Conn, error) {
	if s.IsClosed() {
		return nil, io.ErrClosedPipe
	}
	id := s.nextID.Add(2)
	st := newMuxStream(s, id)
	s.mu.Lock()
	s.streams[id] = st
	s.mu.Unlock()
	if err := s.writeFrame(MuxFrameSYN, id, nil); err != nil {
		s.removeStream(id)
		return nil, err
	}
	return st, nil
}

func (s *MuxSession) AcceptStream() (net.Conn, error) {
	select {
	case st, ok := <-s.acceptCh:
		if !ok {
			return nil, io.EOF
		}
		return st, nil
	case <-s.doneCh:
		return nil, io.EOF
	}
}

func (s *MuxSession) Close() error {
	if s == nil {
		return nil
	}
	if s.closed.CompareAndSwap(false, true) {
		close(s.doneCh)
		s.mu.Lock()
		for _, st := range s.streams {
			st.remoteClose()
		}
		s.streams = make(map[uint32]*MuxStream)
		s.mu.Unlock()
		return s.conn.Close()
	}
	return nil
}

func (s *MuxSession) removeStream(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	s.mu.Unlock()
}

func (s *MuxSession) writeFrame(fType byte, id uint32, payload []byte) error {
	if s.IsClosed() {
		return io.ErrClosedPipe
	}
	var hdr [9]byte
	hdr[0] = fType
	binary.BigEndian.PutUint32(hdr[1:5], id)
	binary.BigEndian.PutUint32(hdr[5:9], uint32(len(payload)))

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := s.conn.Write(hdr[:]); err != nil {
		_ = s.Close()
		return err
	}
	if len(payload) > 0 {
		if _, err := s.conn.Write(payload); err != nil {
			_ = s.Close()
			return err
		}
	}
	_ = s.conn.SetWriteDeadline(time.Time{})
	return nil
}

func (s *MuxSession) keepaliveLoop() {
	tk := time.NewTicker(20 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-tk.C:
			if err := s.writeFrame(MuxFramePING, 0, nil); err != nil {
				return
			}
		case <-s.doneCh:
			return
		}
	}
}

func (s *MuxSession) readLoop() {
	defer func() { _ = s.Close() }()
	var hdr [9]byte
	for {
		if _, err := io.ReadFull(s.conn, hdr[:]); err != nil {
			return
		}
		fType := hdr[0]
		id := binary.BigEndian.Uint32(hdr[1:5])
		length := binary.BigEndian.Uint32(hdr[5:9])
		if length > 4*1024*1024 {
			return
		}
		var payload []byte
		if length > 0 {
			payload = make([]byte, length)
			if _, err := io.ReadFull(s.conn, payload); err != nil {
				return
			}
		}

		switch fType {
		case MuxFrameSYN:
			st := newMuxStream(s, id)
			s.mu.Lock()
			s.streams[id] = st
			s.mu.Unlock()
			select {
			case s.acceptCh <- st:
			case <-s.doneCh:
				return
			}
		case MuxFrameDATA:
			s.mu.RLock()
			st := s.streams[id]
			s.mu.RUnlock()
			if st != nil {
				st.pushData(payload)
			}
		case MuxFrameFIN:
			s.mu.RLock()
			st := s.streams[id]
			s.mu.RUnlock()
			if st != nil {
				st.remoteClose()
				s.removeStream(id)
			}
		case MuxFramePING:
			_ = s.writeFrame(MuxFramePONG, id, nil)
		case MuxFramePONG:
		}
	}
}

// MuxStream implements net.Conn over a MuxSession.
type MuxStream struct {
	sess   *MuxSession
	id     uint32
	inCh   chan []byte
	eofCh  chan struct{}
	closed atomic.Bool

	readMu    sync.Mutex
	curChunk  []byte
	rDeadline atomic.Value
}

func newMuxStream(sess *MuxSession, id uint32) *MuxStream {
	st := &MuxStream{
		sess:  sess,
		id:    id,
		inCh:  make(chan []byte, 256),
		eofCh: make(chan struct{}),
	}
	st.rDeadline.Store(time.Time{})
	return st
}

func (st *MuxStream) pushData(b []byte) {
	select {
	case st.inCh <- b:
	case <-st.eofCh:
	case <-st.sess.doneCh:
	}
}

func (st *MuxStream) remoteClose() {
	if st.closed.CompareAndSwap(false, true) {
		close(st.eofCh)
	}
}

func (st *MuxStream) Read(p []byte) (int, error) {
	st.readMu.Lock()
	defer st.readMu.Unlock()

	if len(st.curChunk) > 0 {
		n := copy(p, st.curChunk)
		st.curChunk = st.curChunk[n:]
		return n, nil
	}

	var timerC <-chan time.Time
	if dl, ok := st.rDeadline.Load().(time.Time); ok && !dl.IsZero() {
		d := time.Until(dl)
		if d <= 0 {
			return 0, timeoutErr{}
		}
		t := time.NewTimer(d)
		defer t.Stop()
		timerC = t.C
	}

	select {
	case chunk := <-st.inCh:
		n := copy(p, chunk)
		if n < len(chunk) {
			st.curChunk = chunk[n:]
		}
		return n, nil
	case <-st.eofCh:
		select {
		case chunk := <-st.inCh:
			n := copy(p, chunk)
			if n < len(chunk) {
				st.curChunk = chunk[n:]
			}
			return n, nil
		default:
			return 0, io.EOF
		}
	case <-st.sess.doneCh:
		return 0, io.EOF
	case <-timerC:
		return 0, timeoutErr{}
	}
}

func (st *MuxStream) Write(p []byte) (int, error) {
	if st.closed.Load() || st.sess.IsClosed() {
		return 0, io.ErrClosedPipe
	}
	total := 0
	const maxChunk = 32768
	for len(p) > 0 {
		sz := len(p)
		if sz > maxChunk {
			sz = maxChunk
		}
		if err := st.sess.writeFrame(MuxFrameDATA, st.id, p[:sz]); err != nil {
			return total, err
		}
		total += sz
		p = p[sz:]
	}
	return total, nil
}

func (st *MuxStream) Close() error {
	if st.closed.CompareAndSwap(false, true) {
		close(st.eofCh)
		st.sess.removeStream(st.id)
		_ = st.sess.writeFrame(MuxFrameFIN, st.id, nil)
	}
	return nil
}

func (st *MuxStream) LocalAddr() net.Addr  { return st.sess.conn.LocalAddr() }
func (st *MuxStream) RemoteAddr() net.Addr { return st.sess.conn.RemoteAddr() }
func (st *MuxStream) SetDeadline(t time.Time) error {
	st.rDeadline.Store(t)
	return nil
}
func (st *MuxStream) SetReadDeadline(t time.Time) error {
	st.rDeadline.Store(t)
	return nil
}
func (st *MuxStream) SetWriteDeadline(_ time.Time) error { return nil }

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }
