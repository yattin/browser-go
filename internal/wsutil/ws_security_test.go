package wsutil

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckSameOrigin(t *testing.T) {
	// 1. Non-browser CLI/Playwright client (no Origin header) -> allowed
	reqCLI := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/v1/browser/webrtc/signal", nil)
	if !CheckSameOrigin(reqCLI, false) {
		t.Fatalf("expected empty Origin to be allowed")
	}

	// 2. Same-origin Dashboard browser tab -> allowed
	reqSame := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/v1/browser/webrtc/signal", nil)
	reqSame.Header.Set("Origin", "http://127.0.0.1:3000")
	if !CheckSameOrigin(reqSame, false) {
		t.Fatalf("expected same-origin Origin to be allowed")
	}

	// 3. Cross-site malicious webpage -> blocked (CSWSH defense)
	reqEvil := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/api/v1/browser/webrtc/signal", nil)
	reqEvil.Header.Set("Origin", "https://evil.attacker.com")
	if CheckSameOrigin(reqEvil, false) {
		t.Fatalf("expected cross-origin CSWSH attempt to be rejected")
	}

	// 4. Chrome Extension origin -> allowed ONLY when allowChromeExt=true
	reqExt := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:3000/extension", nil)
	reqExt.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	if CheckSameOrigin(reqExt, false) {
		t.Fatalf("expected chrome-extension origin rejected when allowChromeExt=false")
	}
	if !CheckSameOrigin(reqExt, true) {
		t.Fatalf("expected chrome-extension origin allowed when allowChromeExt=true")
	}
}

func TestSanitizeHeaderValue(t *testing.T) {
	got := sanitizeHeaderValue("permessage-deflate\r\nX-Injected: evil")
	if got != "permessage-deflateX-Injected: evil" {
		t.Fatalf("unexpected sanitized value: %q", got)
	}
}
