package mcpserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	browsergo "browser-go"
	"browser-go/internal/wsutil"
)

// Config configures the built-in stdio Model Context Protocol (MCP) server (`browser-go mcp`).
type Config struct {
	Endpoint    string // e.g. "http://127.0.0.1:3000"
	Token       string
	DefaultUser string
	Provider    string // "", "chrome", or "qinghu"
	Tags        string // optional Pool routing tags e.g. "region:shanghai"
}

type jsonRPCReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// cdpClient is a minimal, stealth CDP client (never calls Runtime.enable to stay undetectable).
type cdpClient struct {
	ws        *wsutil.Conn
	sessionID string
	nextID    atomic.Int64

	mu      sync.Mutex
	pending map[int64]chan cdpReply
	closed  chan struct{}
	lastX   float64
	lastY   float64
}

type cdpReply struct {
	Result json.RawMessage
	Err    error
}

func dialCDP(ctx context.Context, wsURL string) (*cdpClient, error) {
	ws, _, err := wsutil.Dial(ctx, wsURL, nil, nil)
	if err != nil {
		return nil, err
	}
	c := &cdpClient{
		ws:      ws,
		pending: make(map[int64]chan cdpReply),
		closed:  make(chan struct{}),
		lastX:   120,
		lastY:   120,
	}
	go c.readLoop()

	// Discover and attach to the first page target (flatten: true)
	raw, err := c.call(ctx, "Target.getTargets", map[string]any{}, "")
	if err != nil {
		c.Close()
		return nil, err
	}
	var targets struct {
		TargetInfos []struct {
			TargetID string `json:"targetId"`
			Type     string `json:"type"`
		} `json:"targetInfos"`
	}
	if err := json.Unmarshal(raw, &targets); err != nil {
		c.Close()
		return nil, err
	}
	pageID := ""
	for _, t := range targets.TargetInfos {
		if t.Type == "page" {
			pageID = t.TargetID
			break
		}
	}
	if pageID == "" {
		rawNew, err := c.call(ctx, "Target.createTarget", map[string]any{"url": "about:blank"}, "")
		if err != nil {
			c.Close()
			return nil, err
		}
		var nt struct {
			TargetID string `json:"targetId"`
		}
		_ = json.Unmarshal(rawNew, &nt)
		pageID = nt.TargetID
	}
	attRaw, err := c.call(ctx, "Target.attachToTarget", map[string]any{
		"targetId": pageID,
		"flatten":  true,
	}, "")
	if err != nil {
		c.Close()
		return nil, err
	}
	var att struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(attRaw, &att); err != nil || att.SessionID == "" {
		c.Close()
		return nil, errors.New("failed to attach to page target")
	}
	c.sessionID = att.SessionID
	return c, nil
}

func (c *cdpClient) readLoop() {
	defer close(c.closed)
	for {
		_, data, err := c.ws.ReadMessage()
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.pending {
				ch <- cdpReply{Err: err}
				delete(c.pending, id)
			}
			c.mu.Unlock()
			return
		}
		var msg struct {
			ID     *int64          `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.ID == nil {
			continue
		}
		c.mu.Lock()
		ch, ok := c.pending[*msg.ID]
		if ok {
			delete(c.pending, *msg.ID)
		}
		c.mu.Unlock()
		if ok {
			if msg.Error != nil {
				ch <- cdpReply{Err: errors.New(msg.Error.Message)}
			} else {
				ch <- cdpReply{Result: msg.Result}
			}
		}
	}
}

func (c *cdpClient) call(ctx context.Context, method string, params map[string]any, sessionID string) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	ch := make(chan cdpReply, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()

	payload := map[string]any{
		"id":     id,
		"method": method,
		"params": params,
	}
	if sessionID != "" {
		payload["sessionId"] = sessionID
	}
	if err := c.ws.WriteJSON(payload); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, err
	}

	select {
	case rep := <-ch:
		return rep.Result, rep.Err
	case <-c.closed:
		return nil, io.EOF
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (c *cdpClient) evalJSON(ctx context.Context, expr string, out any) error {
	raw, err := c.call(ctx, "Runtime.evaluate", map[string]any{
		"expression":    expr,
		"returnByValue": true,
		"awaitPromise":  true,
	}, c.sessionID)
	if err != nil {
		return err
	}
	var env struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return err
	}
	if env.ExceptionDetails != nil {
		return errors.New(env.ExceptionDetails.Text)
	}
	if out != nil && len(env.Result.Value) > 0 {
		return json.Unmarshal(env.Result.Value, out)
	}
	return nil
}

func (c *cdpClient) moveMouseHuman(ctx context.Context, toX, toY float64) {
	fromX, fromY := c.lastX, c.lastY
	// Quadratic Bezier curve with subtle organic arc
	ctrlX := (fromX+toX)/2 + (toY-fromY)*0.12
	ctrlY := (fromY+toY)/2 - (toX-fromX)*0.08
	dist := math.Hypot(toX-fromX, toY-fromY)
	steps := int(dist / 35)
	if steps < 6 {
		steps = 6
	}
	if steps > 18 {
		steps = 18
	}
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		u := 1 - t
		x := u*u*fromX + 2*u*t*ctrlX + t*t*toX
		y := u*u*fromY + 2*u*t*ctrlY + t*t*toY
		_, _ = c.call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved",
			"x":    math.Round(x),
			"y":    math.Round(y),
		}, c.sessionID)
		time.Sleep(10 * time.Millisecond)
	}
	c.lastX, c.lastY = toX, toY
}

func (c *cdpClient) Close() {
	if c != nil && c.ws != nil {
		_ = c.ws.Close(1000, "")
	}
}

// Server implements a pure-Go stdio Model Context Protocol (MCP) server backed by Browser-Go.
type Server struct {
	cfg        Config
	httpClient *http.Client

	mu       sync.Mutex
	sessions map[string]*cdpClient
}

func NewServer(cfg Config) *Server {
	ep := strings.TrimRight(strings.TrimSpace(cfg.Endpoint), "/")
	if ep == "" {
		ep = "http://127.0.0.1:3000"
	}
	cfg.Endpoint = ep
	if strings.TrimSpace(cfg.DefaultUser) == "" {
		cfg.DefaultUser = "mcp-agent"
	}
	return &Server{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
		sessions: make(map[string]*cdpClient),
	}
}

func (s *Server) Close() {
	s.mu.Lock()
	for k, c := range s.sessions {
		c.Close()
		delete(s.sessions, k)
	}
	s.mu.Unlock()
}

func (s *Server) getSession(ctx context.Context, user string) (*cdpClient, string, error) {
	u := strings.TrimSpace(user)
	if u == "" {
		u = s.cfg.DefaultUser
	}

	s.mu.Lock()
	if existing, ok := s.sessions[u]; ok {
		select {
		case <-existing.closed:
			delete(s.sessions, u)
		default:
			s.mu.Unlock()
			return existing, u, nil
		}
	}
	s.mu.Unlock()

	wsBase := strings.Replace(s.cfg.Endpoint, "https://", "wss://", 1)
	wsBase = strings.Replace(wsBase, "http://", "ws://", 1)

	launchMap := map[string]any{"user": u}
	if s.cfg.Provider != "" {
		launchMap["provider"] = s.cfg.Provider
	}
	launchJSON, _ := json.Marshal(launchMap)

	q := url.Values{}
	if s.cfg.Token != "" {
		q.Set("token", s.cfg.Token)
	}
	q.Set("launch", string(launchJSON))
	q.Set("startingUrl", "about:blank")
	if s.cfg.Tags != "" {
		q.Set("tags", s.cfg.Tags)
	}

	cli, err := dialCDP(ctx, wsBase+"/?"+q.Encode())
	if err != nil {
		return nil, u, fmt.Errorf("connect browser-go CDP (%s): %w", u, err)
	}

	s.mu.Lock()
	s.sessions[u] = cli
	s.mu.Unlock()
	return cli, u, nil
}

// ServeStdio runs the MCP JSON-RPC 2.0 loop over stdin/stdout (newline-delimited JSON).
func (s *Server) ServeStdio(ctx context.Context, in io.Reader, out io.Writer) error {
	defer s.Close()
	if in == nil {
		in = os.Stdin
	}
	if out == nil {
		out = os.Stdout
	}
	var outMu sync.Mutex
	writeResp := func(resp jsonRPCResp) {
		b, err := json.Marshal(resp)
		if err != nil {
			return
		}
		outMu.Lock()
		_, _ = out.Write(append(b, '\n'))
		outMu.Unlock()
	}

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req jsonRPCReq
		if err := json.Unmarshal(line, &req); err != nil {
			writeResp(jsonRPCResp{JSONRPC: "2.0", Error: &jsonRPCError{Code: -32700, Message: "Parse error"}})
			continue
		}
		// Notifications have no id
		if len(req.ID) == 0 || string(req.ID) == "null" {
			continue
		}
		resp := s.handleRequest(ctx, req)
		writeResp(resp)
	}
	return scanner.Err()
}

func (s *Server) handleRequest(ctx context.Context, req jsonRPCReq) jsonRPCResp {
	switch req.Method {
	case "initialize":
		return jsonRPCResp{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities": map[string]any{
					"tools": map[string]any{},
				},
				"serverInfo": map[string]any{
					"name":    "browser-go-mcp",
					"version": browsergo.AppVersion,
				},
			},
		}

	case "ping":
		return jsonRPCResp{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{}}

	case "tools/list":
		return jsonRPCResp{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]any{"tools": toolDefinitions()},
		}

	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return jsonRPCResp{JSONRPC: "2.0", ID: req.ID, Error: &jsonRPCError{Code: -32602, Message: "Invalid params"}}
		}
		content, isErr := s.callTool(ctx, p.Name, p.Arguments)
		return jsonRPCResp{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": content,
				"isError": isErr,
			},
		}

	default:
		return jsonRPCResp{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &jsonRPCError{Code: -32601, Message: "Method not found: " + req.Method},
		}
	}
}

func strArg(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

func intArg(m map[string]any, key string, def int) int {
	if m == nil {
		return def
	}
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return def
}

func boolArg(m map[string]any, key string, def bool) bool {
	if m == nil {
		return def
	}
	if v, ok := m[key].(bool); ok {
		return v
	}
	return def
}

func textContent(msg string) []map[string]any {
	return []map[string]any{{"type": "text", "text": msg}}
}

func (s *Server) callTool(ctx context.Context, name string, args map[string]any) ([]map[string]any, bool) {
	switch name {
	case "browser_list_instances":
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.Endpoint+"/api/v1/browser/list", nil)
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		if s.cfg.Token != "" {
			req.Header.Set("X-API-Token", s.cfg.Token)
		}
		resp, err := s.httpClient.Do(req)
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		return textContent(string(b)), resp.StatusCode >= 400

	case "browser_navigate":
		targetURL := strArg(args, "url")
		if targetURL == "" {
			return textContent("Error: url is required"), true
		}
		if !strings.Contains(targetURL, "://") && !strings.EqualFold(targetURL, "about:blank") {
			targetURL = "https://" + targetURL
		}
		cli, _, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		if _, err := cli.call(ctx, "Page.navigate", map[string]any{"url": targetURL}, cli.sessionID); err != nil {
			return textContent("Navigate error: " + err.Error()), true
		}
		time.Sleep(800 * time.Millisecond)
		var info struct {
			URL   string `json:"url"`
			Title string `json:"title"`
		}
		_ = cli.evalJSON(ctx, `({ url: location.href, title: document.title })`, &info)
		return textContent(fmt.Sprintf("Navigated to %s (title: %q)", info.URL, info.Title)), false

	case "browser_aria_snapshot":
		maxChars := intArg(args, "max_chars", 6000)
		cli, _, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		var snap struct {
			URL   string `json:"url"`
			Title string `json:"title"`
			Tree  string `json:"tree"`
			Count int    `json:"count"`
		}
		expr := fmt.Sprintf(ariaSnapshotJS, maxChars)
		if err := cli.evalJSON(ctx, expr, &snap); err != nil {
			return textContent("Snapshot error: " + err.Error()), true
		}
		out := fmt.Sprintf("URL: %s\nTitle: %s\nInteractive Refs: %d\n---\n%s", snap.URL, snap.Title, snap.Count, snap.Tree)
		return textContent(out), false

	case "browser_click":
		ref := intArg(args, "ref", 0)
		selector := strArg(args, "selector")
		text := strArg(args, "text")
		human := boolArg(args, "human", true)
		cli, _, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		var box struct {
			Found bool    `json:"found"`
			X     float64 `json:"x"`
			Y     float64 `json:"y"`
			Desc  string  `json:"desc"`
		}
		findExpr := fmt.Sprintf(locateElementJS, ref, mustJSON(selector), mustJSON(text))
		if err := cli.evalJSON(ctx, findExpr, &box); err != nil {
			return textContent("Locate error: " + err.Error()), true
		}
		if !box.Found {
			return textContent("Element not found; call browser_aria_snapshot first to get valid ref/selector"), true
		}
		if human {
			cli.moveMouseHuman(ctx, box.X, box.Y)
		}
		_, _ = cli.call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mousePressed", "x": box.X, "y": box.Y, "button": "left", "clickCount": 1,
		}, cli.sessionID)
		time.Sleep(35 * time.Millisecond)
		_, _ = cli.call(ctx, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseReleased", "x": box.X, "y": box.Y, "button": "left", "clickCount": 1,
		}, cli.sessionID)
		return textContent(fmt.Sprintf("Clicked %s at (%.0f, %.0f)", box.Desc, box.X, box.Y)), false

	case "browser_type":
		txt := strArg(args, "text")
		ref := intArg(args, "ref", 0)
		selector := strArg(args, "selector")
		submit := boolArg(args, "submit", false)
		human := boolArg(args, "human", true)
		cli, _, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		if ref > 0 || selector != "" {
			var box struct {
				Found bool    `json:"found"`
				X     float64 `json:"x"`
				Y     float64 `json:"y"`
			}
			findExpr := fmt.Sprintf(locateElementJS, ref, mustJSON(selector), mustJSON(""))
			if err := cli.evalJSON(ctx, findExpr, &box); err != nil || !box.Found {
				return textContent("Input element not found"), true
			}
			if human {
				cli.moveMouseHuman(ctx, box.X, box.Y)
			}
			_, _ = cli.call(ctx, "Input.dispatchMouseEvent", map[string]any{
				"type": "mousePressed", "x": box.X, "y": box.Y, "button": "left", "clickCount": 1,
			}, cli.sessionID)
			_, _ = cli.call(ctx, "Input.dispatchMouseEvent", map[string]any{
				"type": "mouseReleased", "x": box.X, "y": box.Y, "button": "left", "clickCount": 1,
			}, cli.sessionID)
		}
		// Use Input.insertText for universal Unicode/CJK compatibility
		if _, err := cli.call(ctx, "Input.insertText", map[string]any{"text": txt}, cli.sessionID); err != nil {
			return textContent("Type error: " + err.Error()), true
		}
		if submit {
			_, _ = cli.call(ctx, "Input.dispatchKeyEvent", map[string]any{
				"type": "rawKeyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13,
			}, cli.sessionID)
			_, _ = cli.call(ctx, "Input.dispatchKeyEvent", map[string]any{
				"type": "char", "key": "Enter", "text": "\r", "unmodifiedText": "\r", "windowsVirtualKeyCode": 13,
			}, cli.sessionID)
			_, _ = cli.call(ctx, "Input.dispatchKeyEvent", map[string]any{
				"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13,
			}, cli.sessionID)
		}
		return textContent(fmt.Sprintf("Typed %d chars (submit=%v)", len([]rune(txt)), submit)), false

	case "browser_screenshot_with_labels":
		withLabels := boolArg(args, "with_labels", true)
		cli, _, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		count := 0
		if withLabels {
			_ = cli.evalJSON(ctx, showLabelsOverlayJS, &count)
			defer func() { _ = cli.evalJSON(ctx, removeLabelsOverlayJS, nil) }()
			time.Sleep(60 * time.Millisecond)
		}
		raw, err := cli.call(ctx, "Page.captureScreenshot", map[string]any{"format": "png"}, cli.sessionID)
		if err != nil {
			return textContent("Screenshot error: " + err.Error()), true
		}
		var shot struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(raw, &shot); err != nil || shot.Data == "" {
			return textContent("Empty screenshot data"), true
		}
		return []map[string]any{
			{"type": "text", "text": fmt.Sprintf("Captured PNG screenshot (labels=%v, interactive_badges=%d)", withLabels, count)},
			{"type": "image", "data": shot.Data, "mimeType": "image/png"},
		}, false

	case "browser_request_handoff":
		reason := strArg(args, "reason")
		if reason == "" {
			reason = "需要人工完成登录 / 2FA / 验证码验证"
		}
		timeoutSec := intArg(args, "timeout_sec", 300)
		async := boolArg(args, "async", false)
		_, user, err := s.getSession(ctx, strArg(args, "user"))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		body, _ := json.Marshal(map[string]any{
			"user_id":     user,
			"reason":      reason,
			"timeout_sec": timeoutSec,
			"async":       async,
		})
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.Endpoint+"/api/v1/browser/handoff", bytes.NewReader(body))
		if err != nil {
			return textContent("Error: " + err.Error()), true
		}
		req.Header.Set("Content-Type", "application/json")
		if s.cfg.Token != "" {
			req.Header.Set("X-API-Token", s.cfg.Token)
		}
		longCli := &http.Client{Timeout: time.Duration(timeoutSec+30) * time.Second}
		resp, err := longCli.Do(req)
		if err != nil {
			return textContent("Handoff request failed: " + err.Error()), true
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
		return textContent(string(b)), resp.StatusCode >= 400

	default:
		return textContent("Unknown tool: " + name), true
	}
}

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func toolDefinitions() []map[string]any {
	return []map[string]any{
		{
			"name":        "browser_navigate",
			"description": "Navigate the remote browser session to a URL.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"url":  map[string]any{"type": "string", "description": "Target URL (http/https)"},
					"user": map[string]any{"type": "string", "description": "Optional browser session user_id or Qinghu shop name"},
				},
				"required": []string{"url"},
			},
		},
		{
			"name":        "browser_aria_snapshot",
			"description": "Return a compact, token-efficient Accessibility/Interactive DOM tree with numbered [ref] IDs for clicking and typing.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"user":      map[string]any{"type": "string"},
					"max_chars": map[string]any{"type": "integer", "default": 6000},
				},
			},
		},
		{
			"name":        "browser_click",
			"description": "Click an element by numeric [ref] (from browser_aria_snapshot), CSS selector, or visible text, with optional human-like Bezier cursor movement.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"ref":      map[string]any{"type": "integer"},
					"selector": map[string]any{"type": "string"},
					"text":     map[string]any{"type": "string"},
					"human":    map[string]any{"type": "boolean", "default": true},
					"user":     map[string]any{"type": "string"},
				},
			},
		},
		{
			"name":        "browser_type",
			"description": "Type text (including Chinese/CJK) into an input element identified by [ref] or CSS selector.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"text":     map[string]any{"type": "string"},
					"ref":      map[string]any{"type": "integer"},
					"selector": map[string]any{"type": "string"},
					"submit":   map[string]any{"type": "boolean", "default": false},
					"human":    map[string]any{"type": "boolean", "default": true},
					"user":     map[string]any{"type": "string"},
				},
				"required": []string{"text"},
			},
		},
		{
			"name":        "browser_screenshot_with_labels",
			"description": "Capture a PNG screenshot with numbered interactive element badges ([1], [2], ...) overlaid for visual grounding.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"with_labels": map[string]any{"type": "boolean", "default": true},
					"user":        map[string]any{"type": "string"},
				},
			},
		},
		{
			"name":        "browser_request_handoff",
			"description": "Pause automation and summon a human operator on Browser-Go /dashboard + WebRTC Live View (e.g. for CAPTCHA, 2FA, login, or payment). Automatically resumes when the human clicks '完成并交还 Agent'.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"reason":      map[string]any{"type": "string", "description": "Why human assistance is needed"},
					"timeout_sec": map[string]any{"type": "integer", "default": 300},
					"async":       map[string]any{"type": "boolean", "default": false},
					"user":        map[string]any{"type": "string"},
				},
				"required": []string{"reason"},
			},
		},
		{
			"name":        "browser_list_instances",
			"description": "List all active browser instances across the Browser-Go node or pool, including current URLs and waiting handoffs.",
			"inputSchema": map[string]any{
				"type":       "object",
				"properties": map[string]any{},
			},
		},
	}
}

const ariaSnapshotJS = `(() => {
  const maxChars = %d;
  const sel = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]';
  const els = Array.from(document.querySelectorAll(sel));
  let ref = 0;
  const lines = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    ref++;
    el.setAttribute('data-bg-ref', String(ref));
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = (el.getAttribute('aria-label') || el.placeholder || el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 70);
    const extra = el.tagName === 'INPUT' ? (' type=' + (el.type || 'text')) : (el.tagName === 'A' ? (' href=' + (el.getAttribute('href') || '').slice(0, 50)) : '');
    lines.push('[' + ref + '] <' + role + extra + '> ' + (label || '(unnamed)'));
  }
  const heading = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 8).map(h => h.tagName + ': ' + h.innerText.replace(/\s+/g, ' ').trim().slice(0, 80));
  const body = (heading.length ? ('Headings:\n' + heading.join('\n') + '\n\nElements:\n') : '') + lines.join('\n');
  return { url: location.href, title: document.title, count: ref, tree: body.slice(0, maxChars) };
})()`

const locateElementJS = `(() => {
  const ref = %d;
  const sel = %s;
  const txt = %s;
  let el = null;
  if (ref > 0) el = document.querySelector('[data-bg-ref="' + ref + '"]');
  if (!el && sel) el = document.querySelector(sel);
  if (!el && txt) {
    const lower = txt.toLowerCase();
    for (const c of document.querySelectorAll('button,a,[role="button"],input[type="submit"],span,div')) {
      const t = (c.innerText || c.value || '').trim().toLowerCase();
      if (t && (t === lower || t.includes(lower))) { el = c; break; }
    }
  }
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, desc: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') };
})()`

const showLabelsOverlayJS = `(() => {
  const old = document.getElementById('__bg_mcp_labels__');
  if (old) old.remove();
  const wrap = document.createElement('div');
  wrap.id = '__bg_mcp_labels__';
  wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const sel = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"]';
  let ref = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    ref++;
    el.setAttribute('data-bg-ref', String(ref));
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:2px solid #f59e0b;box-sizing:border-box;border-radius:3px;';
    const tag = document.createElement('span');
    tag.textContent = String(ref);
    tag.style.cssText = 'position:absolute;left:-2px;top:-18px;background:#f59e0b;color:#000;font:bold 11px/16px monospace;padding:0 4px;border-radius:3px;';
    b.appendChild(tag);
    wrap.appendChild(b);
  }
  document.documentElement.appendChild(wrap);
  return ref;
})()`

const removeLabelsOverlayJS = `(() => {
  const el = document.getElementById('__bg_mcp_labels__');
  if (el) el.remove();
  return true;
})()`
