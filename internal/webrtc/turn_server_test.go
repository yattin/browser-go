package webrtc

import (
	"strings"
	"testing"
	"time"
)

func TestEmbeddedTurnServerLifecycleAndHMAC(t *testing.T) {
	ts, err := StartEmbeddedTurnServer("127.0.0.1:0", "127.0.0.1", "test-secret-key", nil)
	if err != nil {
		t.Fatalf("StartEmbeddedTurnServer failed: %v", err)
	}
	defer ts.Close()

	if ts.Addr() == "" {
		t.Fatalf("expected non-empty TURN bound address")
	}

	ice := ts.IssueICEServer(time.Hour)
	if len(ice.URLs) != 2 || !strings.HasPrefix(ice.URLs[0], "turn:127.0.0.1:") {
		t.Fatalf("unexpected ICE server URLs: %v", ice.URLs)
	}
	if !validateHMACUsername(ice.Username) {
		t.Fatalf("expected issued username %q to be valid", ice.Username)
	}
	expectedPass := computeTurnHMACPassword("test-secret-key", ice.Username)
	if ice.Credential != expectedPass {
		t.Fatalf("HMAC password mismatch")
	}

	if validateHMACUsername("1000000000:expired") {
		t.Fatalf("expected expired username to be rejected")
	}
}

func TestParseExternalTURN(t *testing.T) {
	srv, ok := ParseExternalTURN("turn:alice:s3cr3t@turn.example.com:3478")
	if !ok {
		t.Fatalf("expected ParseExternalTURN to succeed")
	}
	if len(srv.URLs) != 1 || srv.URLs[0] != "turn:turn.example.com:3478" {
		t.Fatalf("unexpected URLs: %v", srv.URLs)
	}
	if srv.Username != "alice" || srv.Credential != "s3cr3t" {
		t.Fatalf("unexpected credentials: user=%q pass=%v", srv.Username, srv.Credential)
	}
}
