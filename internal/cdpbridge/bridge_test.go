package cdpbridge

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"browser-go/internal/logger"
	"browser-go/internal/wsutil"
)

func TestMultiDeviceConcurrentIsolationNoCrossTalk(t *testing.T) {
	log, _ := logger.New("test-bridge", "", false, true, false)
	dm := NewDeviceManager(log)
	defer dm.Shutdown()
	bridge := NewBridge(dm, log, false)
	defer bridge.Shutdown()

	mux := http.NewServeMux()
	mux.HandleFunc("/extension", func(w http.ResponseWriter, r *http.Request) {
		ws, err := wsutil.UpgradeHTTP(w, r)
		if err != nil {
			return
		}
		bridge.ServeExtension(ws, r.URL.Query().Get("deviceId"))
	})
	mux.HandleFunc("/cdp", func(w http.ResponseWriter, r *http.Request) {
		ws, err := wsutil.UpgradeHTTP(w, r)
		if err != nil {
			return
		}
		bridge.ServeCDPClient(ws, r.URL.Query().Get("deviceId"))
	})

	srv := httptest.NewServer(mux)
	defer srv.Close()
	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	const numDevices = 3
	extConns := make([]*wsutil.Conn, numDevices)

	// Connect 3 independent mock Chrome Extensions (dev-0, dev-1, dev-2)
	for i := 0; i < numDevices; i++ {
		devID := fmt.Sprintf("dev-%d", i)
		extWS, _, err := wsutil.Dial(ctx, wsBase+"/extension", nil, nil)
		if err != nil {
			t.Fatalf("dial extension %s: %v", devID, err)
		}
		defer extWS.Close(1000, "")
		extConns[i] = extWS

		// Immediately register with connection_info carrying deviceId (our fixed protocol!)
		err = extWS.WriteJSON(map[string]any{
			"type":      "connection_info",
			"deviceId":  devID,
			"sessionId": fmt.Sprintf("pw-tab-%d", i),
			"targetInfo": map[string]any{
				"targetId": fmt.Sprintf("target-%d", i),
				"type":     "page",
				"title":    fmt.Sprintf("Tab %d", i),
				"url":      fmt.Sprintf("https://site-%d.example", i),
			},
		})
		if err != nil {
			t.Fatalf("send connection_info %s: %v", devID, err)
		}

		// Start mock extension command responder
		go func(idx int, dID string, c *wsutil.Conn) {
			for {
				_, raw, err := c.ReadMessage()
				if err != nil {
					return
				}
				var req map[string]any
				if json.Unmarshal(raw, &req) != nil {
					continue
				}
				if req["type"] == "pong" {
					continue
				}
				// Echo back device-specific result with the exact seqID received
				_ = c.WriteJSON(map[string]any{
					"id":        req["id"],
					"sessionId": req["sessionId"],
					"result": map[string]any{
						"handledByDevice": dID,
						"expr":            req["params"],
					},
				})
			}
		}(i, devID, extWS)
	}

	// Deterministically poll until all 3 devices finish async registration
	regDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(regDeadline) {
		if dm.Stats().ConnectedDevices == numDevices {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if st := dm.Stats(); st.ConnectedDevices != numDevices {
		t.Fatalf("expected %d connected devices, got %+v", numDevices, st)
	}

	// Connect 3 concurrent Playwright clients, ALL sending colliding `id: 1` simultaneously!
	cliConns := make([]*wsutil.Conn, numDevices)
	for i := 0; i < numDevices; i++ {
		devID := fmt.Sprintf("dev-%d", i)
		cWS, _, err := wsutil.Dial(ctx, wsBase+"/cdp?deviceId="+devID, nil, nil)
		if err != nil {
			t.Fatalf("dial cdp client %s: %v", devID, err)
		}
		defer cWS.Close(1000, "")
		cliConns[i] = cWS
	}

	var wg sync.WaitGroup
	errs := make(chan error, numDevices)
	for i := 0; i < numDevices; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			wantDev := fmt.Sprintf("dev-%d", idx)
			cli := cliConns[idx]

			// Colliding id = 1 across all 3 concurrent clients!
			if err := cli.WriteJSON(map[string]any{
				"id":     1,
				"method": "Runtime.evaluate",
				"params": map[string]any{"expression": wantDev},
			}); err != nil {
				errs <- err
				return
			}
			_, rawResp, err := cli.ReadMessage()
			if err != nil {
				errs <- err
				return
			}
			var resp struct {
				ID     int `json:"id"`
				Result struct {
					HandledByDevice string `json:"handledByDevice"`
				} `json:"result"`
			}
			if err := json.Unmarshal(rawResp, &resp); err != nil {
				errs <- err
				return
			}
			if resp.ID != 1 {
				errs <- fmt.Errorf("client %d expected restored id=1, got %d", idx, resp.ID)
				return
			}
			if resp.Result.HandledByDevice != wantDev {
				errs <- fmt.Errorf("CROSS-TALK DETECTED: client %d (%s) got response from %s", idx, wantDev, resp.Result.HandledByDevice)
				return
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	// Verify event isolation: dev-1 emits Page.loadEventFired -> ONLY cliConns[1] should receive it!
	if err := extConns[1].WriteJSON(map[string]any{
		"sessionId": "pw-tab-1",
		"method":    "Page.loadEventFired",
		"params":    map[string]any{"source": "dev-1"},
	}); err != nil {
		t.Fatalf("emit event from dev-1: %v", err)
	}

	// Client 1 must receive Page.loadEventFired
	_, evRaw, err := cliConns[1].ReadMessage()
	if err != nil {
		t.Fatalf("client 1 read event: %v", err)
	}
	if !strings.Contains(string(evRaw), "Page.loadEventFired") {
		t.Fatalf("expected Page.loadEventFired on client 1, got %s", string(evRaw))
	}

	// Clients 0 and 2 send Browser.getVersion (id=99) and must immediately get Browser.getVersion, NOT dev-1's event!
	for _, otherIdx := range []int{0, 2} {
		_ = cliConns[otherIdx].WriteJSON(map[string]any{"id": 99, "method": "Browser.getVersion"})
		_, msgRaw, err := cliConns[otherIdx].ReadMessage()
		if err != nil {
			t.Fatalf("client %d read: %v", otherIdx, err)
		}
		if strings.Contains(string(msgRaw), "Page.loadEventFired") {
			t.Fatalf("EVENT LEAKED to client %d: %s", otherIdx, string(msgRaw))
		}
	}
}
