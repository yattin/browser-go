package pool

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"browser-go/internal/chrome"
	"browser-go/internal/config"
	"browser-go/internal/logger"
	"browser-go/internal/server"
	"browser-go/internal/wsutil"
	"browser-go/pkg/pftunnel"
)

func startMockCDPTarget(t *testing.T, nodeLabel string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := wsutil.UpgradeHTTP(w, r)
		if err != nil {
			return
		}
		defer ws.Close(1000, "")
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return
			}
			var req map[string]any
			_ = json.Unmarshal(raw, &req)
			_ = ws.WriteJSON(map[string]any{
				"id": req["id"],
				"result": map[string]any{
					"servedByNode": nodeLabel,
				},
			})
		}
	}))
}

func TestDistributedPoolTunnelAutoJoinTagAndStickyRouting(t *testing.T) {
	log, _ := logger.New("test-pool", "", false, true, false)

	// 1. Start central Pool Gateway with built-in ProxyForge Bridge (--pf-listen=127.0.0.1:0)
	gw, err := NewGateway(config.PoolConfig{
		Host:         "127.0.0.1",
		Port:         0,
		Token:        "pool-secret-123",
		StrictAuth:   true,
		QueueTimeout: 3 * time.Second,
		ProbeEvery:   400 * time.Millisecond,
		PFListen:     "127.0.0.1:0",
		PFProto:      "tls",
		PFSingleTLS:  true,
		NoLogFile:    true,
	}, log)
	if err != nil {
		t.Fatalf("NewGateway: %v", err)
	}
	if err := gw.Start(); err != nil {
		t.Fatalf("Gateway.Start: %v", err)
	}
	defer func() {
		sCtx, sCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer sCancel()
		_ = gw.Shutdown(sCtx)
	}()

	// 2. Spin up 2 stealth intranet Browser-Go Nodes (--port=0!) with tags shanghai & beijing
	mockCDPShanghai := startMockCDPTarget(t, "node-shanghai")
	defer mockCDPShanghai.Close()
	mockCDPBeijing := startMockCDPTarget(t, "node-beijing")
	defer mockCDPBeijing.Close()

	startTunnelWorker := func(nodeID, region string, mockCDPURL string) (*server.NodeServer, *pftunnel.Client, func()) {
		wsURL := "ws" + strings.TrimPrefix(mockCDPURL, "http")
		var exitFns []func()
		mgr := chrome.NewManager(chrome.ManagerConfig{
			MaxInstances:          2,
			InstanceTimeout:       5 * time.Minute,
			InactiveCheckInterval: time.Minute,
			DataDir:               t.TempDir(),
			Logger:                log,
			SpawnOverride: func(ctx context.Context, debugPort int, userDataDir, startingURL string, extraArgs []string, headless bool) (*chrome.ProcGroup, string, error) {
				pg, stopFn := chrome.NewMockProcess()
				exitFns = append(exitFns, stopFn)
				// Auto-close mock process if Kill is triggered
				go func() {
					// Keep open until test teardown or explicit stop
				}()
				return pg, wsURL, nil
			},
		})

		nCfg := config.NodeConfig{
			Host:         "127.0.0.1",
			Port:         0, // pure stealth tunnel mode!
			MaxInstances: 2,
			Token:        "pool-secret-123",
			NodeID:       nodeID,
			Tags:         map[string]string{"region": region},
			NoLogFile:    true,
		}
		srv := server.NewNodeServer(nCfg, log, mgr)
		if err := srv.Start(); err != nil {
			t.Fatalf("start node %s: %v", nodeID, err)
		}

		cli, err := pftunnel.NewClient(pftunnel.ClientConfig{
			BridgeAddr:        gw.BridgeAddr(),
			Mode:              "mux",
			ClientKey:         nodeID,
			Proto:             "tls",
			SessionCount:      2,
			NodeTags:          map[string]string{"region": region},
			Transport:         pftunnel.TransportOptions{SingleTLS: true},
			Logger:            log,
			DefaultTargetAddr: "127.0.0.1:3000",
			InProcessDial:     srv.DialInProcess,
		})
		if err != nil {
			t.Fatalf("new tunnel client %s: %v", nodeID, err)
		}
		cli.Start()

		cleanup := func() {
			for _, fn := range exitFns {
				fn()
			}
			cli.Stop()
			sCtx, sCancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer sCancel()
			_ = srv.Shutdown(sCtx)
		}
		return srv, cli, cleanup
	}

	_, _, cleanSH := startTunnelWorker("node-shanghai", "shanghai", mockCDPShanghai.URL)
	defer cleanSH()
	_, _, cleanBJ := startTunnelWorker("node-beijing", "beijing", mockCDPBeijing.URL)
	defer cleanBJ()

	poolHTTP := "http://" + gw.BoundAddr()
	poolWS := "ws://" + gw.BoundAddr()

	// Wait until both intranet nodes auto-register and pass health probes (total available_slots == 4)
	deadline := time.Now().Add(5 * time.Second)
	for {
		req, _ := http.NewRequest(http.MethodGet, poolHTTP+"/api/v1/browser/stats", nil)
		req.Header.Set("X-API-Token", "pool-secret-123")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			var st struct {
				Data struct {
					HealthyNodes   int `json:"healthy_nodes"`
					AvailableSlots int `json:"available_slots"`
				} `json:"data"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&st)
			_ = resp.Body.Close()
			if st.Data.HealthyNodes == 2 && st.Data.AvailableSlots == 4 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for 2 tunnel nodes to join pool")
		}
		time.Sleep(100 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	// 3. Tag routing test: ?tags=region:beijing MUST route to node-beijing!
	bjURL := poolWS + "/?token=pool-secret-123&startingUrl=" + url.QueryEscape("https://example.com") +
		"&tags=" + url.QueryEscape("region:beijing") +
		"&launch=" + url.QueryEscape(`{"user":"alice"}`)
	ws1, _, err := wsutil.Dial(ctx, bjURL, nil, nil)
	if err != nil {
		t.Fatalf("dial pool with beijing tag: %v", err)
	}
	_ = ws1.WriteJSON(map[string]any{"id": 1, "method": "Runtime.evaluate"})
	_, raw1, err := ws1.ReadMessage()
	if err != nil {
		t.Fatalf("read CDP reply 1: %v", err)
	}
	if !strings.Contains(string(raw1), "node-beijing") {
		t.Fatalf("expected routing to node-beijing, got %s", string(raw1))
	}
	_ = ws1.Close(1000, "")

	// 4. Sticky user affinity test: reconnect as user="alice" WITHOUT tags -> MUST still hit node-beijing!
	stickyURL := poolWS + "/?token=pool-secret-123&startingUrl=" + url.QueryEscape("https://example.com") +
		"&launch=" + url.QueryEscape(`{"user":"alice"}`)
	ws2, _, err := wsutil.Dial(ctx, stickyURL, nil, nil)
	if err != nil {
		t.Fatalf("dial pool for sticky user alice: %v", err)
	}
	_ = ws2.WriteJSON(map[string]any{"id": 2, "method": "Runtime.evaluate"})
	_, raw2, err := ws2.ReadMessage()
	if err != nil {
		t.Fatalf("read CDP reply 2: %v", err)
	}
	if !strings.Contains(string(raw2), "node-beijing") {
		t.Fatalf("sticky routing failed: expected node-beijing for alice, got %s", string(raw2))
	}
	_ = ws2.Close(1000, "")

	// 5. Pool list aggregation must show user "alice" on "node-beijing"
	listReq, _ := http.NewRequest(http.MethodGet, poolHTTP+"/api/v1/browser/list", nil)
	listReq.Header.Set("X-API-Token", "pool-secret-123")
	listResp, err := http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatalf("pool list failed: %v", err)
	}
	var listBody struct {
		Data []struct {
			NodeID string `json:"node_id"`
			UserID string `json:"user_id"`
		} `json:"data"`
	}
	_ = json.NewDecoder(listResp.Body).Decode(&listBody)
	_ = listResp.Body.Close()
	if len(listBody.Data) != 1 || listBody.Data[0].UserID != "alice" || listBody.Data[0].NodeID != "node-beijing" {
		t.Fatalf("unexpected pool list: %+v", listBody.Data)
	}

	// 6. Pool stop by user_id must route to node-beijing and destroy alice's instance
	stopReq, _ := http.NewRequest(http.MethodGet, poolHTTP+"/api/v1/browser/stop?user_id=alice", nil)
	stopReq.Header.Set("X-API-Token", "pool-secret-123")
	stopResp, err := http.DefaultClient.Do(stopReq)
	if err != nil {
		t.Fatalf("pool stop failed: %v", err)
	}
	_ = stopResp.Body.Close()
	if stopResp.StatusCode != http.StatusOK {
		t.Fatalf("expected HTTP 200 on pool stop, got %d", stopResp.StatusCode)
	}
}
