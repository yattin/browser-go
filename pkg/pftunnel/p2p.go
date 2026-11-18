package pftunnel

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

func signP2PRegToken(clientKey, tok string) string {
	k := strings.TrimSpace(clientKey)
	if k == "" {
		k = "default"
	}
	mac := hmac.New(sha256.New, []byte(k))
	mac.Write([]byte("PF2P_REG:" + tok))
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

func appendUniqueAddr(list []string, cand string) []string {
	cand = strings.TrimSpace(cand)
	if cand == "" {
		return list
	}
	for _, existing := range list {
		if existing == cand {
			return list
		}
	}
	return append(list, cand)
}

func probeBridgeP2PCandidates(bridgeAddr, clientKey string) (*net.UDPConn, string, []string, error) {
	uConn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4zero, Port: 0})
	if err != nil {
		return nil, "", nil, err
	}
	localPort := uConn.LocalAddr().(*net.UDPAddr).Port

	var tokBytes [12]byte
	_, _ = rand.Read(tokBytes[:])
	tok := hex.EncodeToString(tokBytes[:])
	sig := signP2PRegToken(clientKey, tok)

	var cands []string
	if bUDP, err := net.ResolveUDPAddr("udp", bridgeAddr); err == nil {
		for attempt := 0; attempt < 3; attempt++ {
			_, _ = uConn.WriteToUDP([]byte("PF2P_REG:"+tok+":"+sig), bUDP)
			_ = uConn.SetReadDeadline(time.Now().Add(90 * time.Millisecond))
			var rbuf [256]byte
			n, _, rerr := uConn.ReadFromUDP(rbuf[:])
			if rerr == nil && strings.HasPrefix(string(rbuf[:n]), "PF2P_MAPPED:") {
				mapped := strings.TrimSpace(string(rbuf[len("PF2P_MAPPED:"):n]))
				cands = appendUniqueAddr(cands, mapped)
				break
			}
		}
		_ = uConn.SetReadDeadline(time.Time{})
	}

	cands = appendUniqueAddr(cands, fmt.Sprintf("127.0.0.1:%d", localPort))
	if ifs, err := net.Interfaces(); err == nil {
		for _, iface := range ifs {
			if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addrs, _ := iface.Addrs()
			for _, a := range addrs {
				if in, ok := a.(*net.IPNet); ok && in.IP != nil && in.IP.To4() != nil {
					cands = appendUniqueAddr(cands, net.JoinHostPort(in.IP.String(), strconv.Itoa(localPort)))
				}
			}
		}
	}
	return uConn, tok, cands, nil
}

func punchUDPHole(uConn *net.UDPConn, peerCandidates []string, secret string, timeout time.Duration) (*net.UDPAddr, error) {
	var targets []*net.UDPAddr
	for _, c := range peerCandidates {
		if ua, err := net.ResolveUDPAddr("udp", c); err == nil {
			targets = append(targets, ua)
		}
	}
	if len(targets) == 0 {
		return nil, errors.New("no valid peer UDP candidates")
	}

	synMsg := []byte("PF2P_SYN:" + secret)
	ackMsg := []byte("PF2P_ACK:" + secret)

	deadline := time.Now().Add(timeout)
	var lockedPeer *net.UDPAddr
	gotSyn := false
	gotAck := false

	nextSend := time.Now()
	var buf [512]byte

	for time.Now().Before(deadline) {
		if time.Now().After(nextSend) {
			if lockedPeer != nil {
				_, _ = uConn.WriteToUDP(ackMsg, lockedPeer)
			} else {
				for _, t := range targets {
					_, _ = uConn.WriteToUDP(synMsg, t)
				}
			}
			nextSend = time.Now().Add(25 * time.Millisecond)
		}

		_ = uConn.SetReadDeadline(time.Now().Add(25 * time.Millisecond))
		n, raddr, err := uConn.ReadFromUDP(buf[:])
		if err != nil {
			continue
		}
		s := string(buf[:n])
		if s == "PF2P_SYN:"+secret {
			lockedPeer = raddr
			gotSyn = true
			_, _ = uConn.WriteToUDP(ackMsg, raddr)
			if gotAck {
				break
			}
		} else if s == "PF2P_ACK:"+secret {
			lockedPeer = raddr
			gotAck = true
			_, _ = uConn.WriteToUDP(ackMsg, raddr)
			if gotSyn {
				break
			}
			_, _ = uConn.WriteToUDP(ackMsg, raddr)
			break
		}
	}
	_ = uConn.SetReadDeadline(time.Time{})
	if lockedPeer == nil || !gotAck {
		return nil, errors.New("UDP NAT hole punch timed out")
	}
	return lockedPeer, nil
}

type p2pFilteredPacketConn struct {
	*net.UDPConn
}

func (f *p2pFilteredPacketConn) ReadFrom(p []byte) (int, net.Addr, error) {
	for {
		n, addr, err := f.UDPConn.ReadFrom(p)
		if err != nil {
			return 0, nil, err
		}
		if n >= 5 && bytes.HasPrefix(p[:n], []byte("PF2P_")) {
			continue
		}
		return n, addr, nil
	}
}

type connWithCloser struct {
	net.Conn
	extra io.Closer
	once  sync.Once
}

func (c *connWithCloser) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() {
		if c.extra != nil {
			_ = c.extra.Close()
		}
	})
	return err
}
