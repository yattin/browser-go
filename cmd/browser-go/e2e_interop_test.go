package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"browser-go/internal/chrome"
	"browser-go/internal/wsutil"
)

func pickFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("pickFreePort: %v", err)
	}
	p := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return p
}

func readCDPResponseByID(t *testing.T, ws *wsutil.Conn, wantID int) map[string]any {
	t.Helper()
	for i := 0; i < 64; i++ {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("readCDPResponseByID(%d): %v", wantID, err)
		}
		var msg map[string]any
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		if idFloat, ok := msg["id"].(float64); ok && int(idFloat) == wantID {
			if errObj, hasErr := msg["error"]; hasErr && errObj != nil {
				t.Fatalf("CDP command %d returned error: %v", wantID, errObj)
			}
			return msg
		}
	}
	t.Fatalf("did not receive CDP response id=%d within 64 frames", wantID)
	return nil
}

func TestRealProxyForgeMTLSAndRealBrowserCDP(t *testing.T) {
	pfExe := filepath.Clean(`d:\qinghu\proxyforge\bin\proxyforge.exe`)
	if _, err := os.Stat(pfExe); err != nil {
		t.Skipf("skipping real ProxyForge interop test (proxyforge.exe not at %s)", pfExe)
	}
	chromeBin, err := chrome.FindExecutable("")
	if err != nil {
		t.Skipf("skipping real browser CDP test: %v", err)
	}
	bgExe := filepath.Clean(`..\..\bin\browser-go.exe`)
	if _, err := os.Stat(bgExe); err != nil {
		t.Skipf("skipping binary interop test (browser-go.exe not built yet at %s)", bgExe)
	}

	t.Logf("Running real cross-process interop test with ProxyForge (%s) + Browser (%s)", pfExe, chromeBin)

	tmp := t.TempDir()
	caPrefix := filepath.Join(tmp, "ca")
	srvPrefix := filepath.Join(tmp, "srv")
	cliPrefix := filepath.Join(tmp, "cli")

	// 1. Mint mTLS CA + Server Leaf + Client Leaf using real `proxyforge.exe keygen`
	if out, err := exec.Command(pfExe, "keygen", "-C", caPrefix, "-d", "127.0.0.1", "--json").CombinedOutput(); err != nil {
		t.Fatalf("proxyforge keygen CA failed: %v\n%s", err, string(out))
	}
	if out, err := exec.Command(pfExe, "keygen", "-s", "-C", caPrefix, "-c", srvPrefix, "-d", "127.0.0.1", "--json").CombinedOutput(); err != nil {
		t.Fatalf("proxyforge keygen srv leaf failed: %v\n%s", err, string(out))
	}
	if out, err := exec.Command(pfExe, "keygen", "-s", "-C", caPrefix, "-c", cliPrefix, "-d", "node-e2e.local", "--json").CombinedOutput(); err != nil {
		t.Fatalf("proxyforge keygen cli leaf failed: %v\n%s", err, string(out))
	}

	// Build server bundle (srv.crt + ca.crt) so ProxyForge ServerTLSConfig trusts CA for client mTLS verification
	srvCrtBytes, _ := os.ReadFile(srvPrefix + ".crt")
	caCrtBytes, _ := os.ReadFile(caPrefix + ".crt")
	srvBundle := filepath.Join(tmp, "srv-bundle.crt")
	_ = os.WriteFile(srvBundle, append(srvCrtBytes, caCrtBytes...), 0644)

	bridgePort := pickFreePort(t)
	mappedPort := pickFreePort(t)
	bridgeAddr := fmt.Sprintf("127.0.0.1:%d", bridgePort)
	mappedAddr := fmt.Sprintf("127.0.0.1:%d", mappedPort)
	ruleSpec := fmt.Sprintf("%s@[e2e-node-1]127.0.0.1:3000", mappedAddr)

	// 2. Pre-validate configs via `proxyforge.exe validate --json`
	if out, err := exec.Command(pfExe, "validate", "bridge", "-p", bridgeAddr, "-C", srvBundle, "-K", srvPrefix+".key", "--client-keys", "e2e-node-1", "--json").CombinedOutput(); err != nil {
		t.Fatalf("proxyforge validate bridge failed: %v\n%s", err, string(out))
	}
	if out, err := exec.Command(pfExe, "validate", "server", "-P", bridgeAddr, "-C", cliPrefix+".crt", "-K", cliPrefix+".key", "--ca-bundle", caPrefix+".crt", "-r", ruleSpec, "--p2p", "--json").CombinedOutput(); err != nil {
		t.Fatalf("proxyforge validate server failed: %v\n%s", err, string(out))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()

	// 3. Start real `proxyforge.exe bridge`
	bridgeCmd := exec.CommandContext(ctx, pfExe,
		"bridge", "-p", bridgeAddr,
		"-C", srvBundle, "-K", srvPrefix+".key",
		"--client-keys", "e2e-node-1", "--nolog",
	)
	if err := bridgeCmd.Start(); err != nil {
		t.Fatalf("start proxyforge bridge: %v", err)
	}
	defer func() { _ = bridgeCmd.Process.Kill(); _ = bridgeCmd.Wait() }()

	time.Sleep(250 * time.Millisecond)

	// 4. Start real `proxyforge.exe server` (--p2p enabled!)
	srvCmd := exec.CommandContext(ctx, pfExe,
		"server", "-P", bridgeAddr,
		"-C", cliPrefix+".crt", "-K", cliPrefix+".key",
		"--ca-bundle", caPrefix+".crt",
		"-r", ruleSpec, "--p2p", "--nolog",
	)
	if err := srvCmd.Start(); err != nil {
		t.Fatalf("start proxyforge server: %v", err)
	}
	defer func() { _ = srvCmd.Process.Kill(); _ = srvCmd.Wait() }()

	// 5. Start real `browser-go.exe node` in stealth --port=0 mode connecting to ProxyForge Bridge!
	bgCmd := exec.CommandContext(ctx, bgExe,
		"node",
		"--port=0",
		"--max-instances=3",
		"--token=e2e-secret",
		"--headless",
		"--no-log",
		"--data-dir="+filepath.Join(tmp, "bgdata"),
		"--pf-bridge="+bridgeAddr,
		"--pf-key=e2e-node-1",
		"--pf-cert="+cliPrefix+".crt",
		"--pf-key-file="+cliPrefix+".key",
		"--pf-ca="+caPrefix+".crt",
		"--pf-p2p",
		"--tags=env=e2e,isp=local",
	)
	if err := bgCmd.Start(); err != nil {
		t.Fatalf("start browser-go node: %v", err)
	}
	defer func() { _ = bgCmd.Process.Kill(); _ = bgCmd.Wait() }()

	// 6. Poll penetrated HTTP stats endpoint through ProxyForge Server -> Bridge -> Browser-Go Node!
	statsURL := fmt.Sprintf("http://%s/api/v1/browser/stats?token=e2e-secret", mappedAddr)
	ready := false
	for i := 0; i < 40; i++ {
		resp, err := http.Get(statsURL)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	if !ready {
		t.Fatalf("penetrated stats endpoint %s did not become ready", statsURL)
	}

	// 7. Connect over CDP WebSocket through the ProxyForge tunnel to launch a REAL headless browser!
	wsTarget := fmt.Sprintf("ws://%s/?token=e2e-secret&startingUrl=%s",
		mappedAddr, url.QueryEscape("about:blank"))
	cdpWS, _, err := wsutil.Dial(ctx, wsTarget, nil, nil)
	if err != nil {
		t.Fatalf("CDP WebSocket dial over ProxyForge tunnel failed: %v", err)
	}

	// Step A: Browser.getVersion
	_ = cdpWS.WriteJSON(map[string]any{"id": 1, "method": "Browser.getVersion"})
	verResp := readCDPResponseByID(t, cdpWS, 1)
	resMap, _ := verResp["result"].(map[string]any)
	t.Logf("Real Chrome Version over ProxyForge mTLS+P2P Tunnel: %v", resMap["product"])

	// Step B: Target.createTarget with inline HTML
	dataHTML := "data:text/html,<html><body><h1 id='headline'>PF-GOLANG-CDP-OK</h1></body></html>"
	_ = cdpWS.WriteJSON(map[string]any{
		"id":     2,
		"method": "Target.createTarget",
		"params": map[string]any{"url": dataHTML},
	})
	createResp := readCDPResponseByID(t, cdpWS, 2)
	targetID, _ := createResp["result"].(map[string]any)["targetId"].(string)
	if targetID == "" {
		t.Fatalf("empty targetId in %v", createResp)
	}

	// Step C: Target.attachToTarget (flattened session)
	_ = cdpWS.WriteJSON(map[string]any{
		"id":     3,
		"method": "Target.attachToTarget",
		"params": map[string]any{"targetId": targetID, "flatten": true},
	})
	attachResp := readCDPResponseByID(t, cdpWS, 3)
	sessionID, _ := attachResp["result"].(map[string]any)["sessionId"].(string)

	// Wait briefly for data: URL DOM to commit, then evaluate JS
	time.Sleep(150 * time.Millisecond)
	_ = cdpWS.WriteJSON(map[string]any{
		"id":        4,
		"sessionId": sessionID,
		"method":    "Runtime.evaluate",
		"params": map[string]any{
			"expression":    "document.getElementById('headline') ? document.getElementById('headline').textContent : document.body.innerHTML",
			"returnByValue": true,
		},
	})
	evalResp := readCDPResponseByID(t, cdpWS, 4)
	evalJSON, _ := json.Marshal(evalResp["result"])
	if !strings.Contains(string(evalJSON), "PF-GOLANG-CDP-OK") {
		t.Fatalf("unexpected Runtime.evaluate result: %s", string(evalJSON))
	}

	// Step D: Page.captureScreenshot (verify multi-KB PNG frame streaming over tunnel)
	_ = cdpWS.WriteJSON(map[string]any{
		"id":        5,
		"sessionId": sessionID,
		"method":    "Page.captureScreenshot",
		"params":    map[string]any{"format": "png"},
	})
	shotResp := readCDPResponseByID(t, cdpWS, 5)
	pngB64, _ := shotResp["result"].(map[string]any)["data"].(string)
	if len(pngB64) < 100 {
		t.Fatalf("expected non-trivial base64 PNG screenshot, got len=%d", len(pngB64))
	}
	t.Logf("Captured real PNG screenshot over ProxyForge tunnel (%d base64 chars)", len(pngB64))

	// 8. Close anonymous CDP WebSocket -> verify ephemeral Chrome instance is immediately reaped!
	_ = cdpWS.Close(1000, "")

	reaped := false
	for i := 0; i < 30; i++ {
		resp, err := http.Get(statsURL)
		if err == nil {
			var body struct {
				Data struct {
					CurrentInstances int `json:"current_instances"`
					AvailableSlots   int `json:"available_slots"`
				} `json:"data"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&body)
			_ = resp.Body.Close()
			if body.Data.CurrentInstances == 0 && body.Data.AvailableSlots == 3 {
				reaped = true
				break
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	if !reaped {
		t.Fatalf("ephemeral Chrome instance was not reaped after CDP WebSocket closed")
	}
	t.Logf("Verified ephemeral Chrome instance cleanly terminated via Windows Job Object (0 active / 3 slots free)")
}
