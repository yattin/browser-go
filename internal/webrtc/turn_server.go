package webrtc

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/pion/turn/v4"
	pionwebrtc "github.com/pion/webrtc/v4"

	"browser-go/internal/logger"
)

const turnRealm = "browser-go.turn"

// EmbeddedTurnServer is a built-in lightweight pion/turn/v4 UDP relay for symmetric NAT traversal,
// removing the need to deploy external coturn.
type EmbeddedTurnServer struct {
	listenAddr string
	publicIP   string
	secret     string
	port       int
	srv        *turn.Server
	udpConn    net.PacketConn
	log        *logger.Logger
}

func StartEmbeddedTurnServer(listenAddr, publicIP, secret string, log *logger.Logger) (*EmbeddedTurnServer, error) {
	if strings.TrimSpace(listenAddr) == "" {
		return nil, errors.New("TURN listen address is empty")
	}
	if strings.TrimSpace(publicIP) == "" {
		publicIP = "127.0.0.1"
	}
	ip := net.ParseIP(strings.TrimSpace(publicIP))
	if ip == nil {
		return nil, fmt.Errorf("invalid --webrtc-public-ip %q", publicIP)
	}
	if strings.TrimSpace(secret) == "" {
		var b [24]byte
		_, _ = rand.Read(b[:])
		secret = hex.EncodeToString(b[:])
	}
	if log == nil {
		log = logger.Default()
	}

	udpConn, err := net.ListenPacket("udp4", listenAddr)
	if err != nil {
		return nil, fmt.Errorf("TURN listen UDP %s: %w", listenAddr, err)
	}
	boundPort := udpConn.LocalAddr().(*net.UDPAddr).Port

	authHandler := func(username, realm string, _ net.Addr) ([]byte, bool) {
		if !validateHMACUsername(username) {
			return nil, false
		}
		expectedPass := computeTurnHMACPassword(secret, username)
		return turn.GenerateAuthKey(username, realm, expectedPass), true
	}

	s, err := turn.NewServer(turn.ServerConfig{
		Realm:       turnRealm,
		AuthHandler: authHandler,
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn: udpConn,
				RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
					RelayAddress: ip,
					Address:      "0.0.0.0",
				},
			},
		},
	})
	if err != nil {
		_ = udpConn.Close()
		return nil, fmt.Errorf("start pion/turn server: %w", err)
	}

	log.Infof("Embedded WebRTC TURN/STUN Relay listening on %s (public_ip=%s)", udpConn.LocalAddr().String(), publicIP)
	return &EmbeddedTurnServer{
		listenAddr: udpConn.LocalAddr().String(),
		publicIP:   publicIP,
		secret:     secret,
		port:       boundPort,
		srv:        s,
		udpConn:    udpConn,
		log:        log,
	}, nil
}

func computeTurnHMACPassword(secret, username string) string {
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func validateHMACUsername(username string) bool {
	expStr, _, ok := strings.Cut(username, ":")
	if !ok {
		return false
	}
	expUnix, err := strconv.ParseInt(expStr, 10, 64)
	if err != nil {
		return false
	}
	return time.Now().Unix() <= expUnix
}

// IssueICEServer generates a short-lived RFC 5766 HMAC TURN/STUN ICEServer credential pair.
func (t *EmbeddedTurnServer) IssueICEServer(ttl time.Duration) pionwebrtc.ICEServer {
	if ttl <= 0 {
		ttl = time.Hour
	}
	var rb [6]byte
	_, _ = rand.Read(rb[:])
	expiry := time.Now().Add(ttl).Unix()
	user := fmt.Sprintf("%d:%s", expiry, hex.EncodeToString(rb[:]))
	pass := computeTurnHMACPassword(t.secret, user)
	hostPort := net.JoinHostPort(t.publicIP, strconv.Itoa(t.port))
	return pionwebrtc.ICEServer{
		URLs: []string{
			"turn:" + hostPort + "?transport=udp",
			"stun:" + hostPort,
		},
		Username:       user,
		Credential:     pass,
		CredentialType: pionwebrtc.ICECredentialTypePassword,
	}
}

func (t *EmbeddedTurnServer) Addr() string {
	if t == nil {
		return ""
	}
	return t.listenAddr
}

func (t *EmbeddedTurnServer) Close() error {
	if t == nil {
		return nil
	}
	if t.srv != nil {
		return t.srv.Close()
	}
	if t.udpConn != nil {
		return t.udpConn.Close()
	}
	return nil
}

// ParseExternalTURN parses `turn:user:pass@host:port` into a pionwebrtc.ICEServer.
func ParseExternalTURN(raw string) (pionwebrtc.ICEServer, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return pionwebrtc.ICEServer{}, false
	}
	scheme := "turn"
	if strings.HasPrefix(s, "turns:") {
		scheme = "turns"
		s = strings.TrimPrefix(s, "turns:")
	} else if strings.HasPrefix(s, "turn:") {
		s = strings.TrimPrefix(s, "turn:")
	}
	userPass, hostPort, hasAuth := strings.Cut(s, "@")
	if !hasAuth {
		return pionwebrtc.ICEServer{URLs: []string{scheme + ":" + s}}, true
	}
	u, p, _ := strings.Cut(userPass, ":")
	return pionwebrtc.ICEServer{
		URLs:           []string{scheme + ":" + hostPort},
		Username:       u,
		Credential:     p,
		CredentialType: pionwebrtc.ICECredentialTypePassword,
	}, true
}
