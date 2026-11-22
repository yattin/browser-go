package qinghu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// agentDiscovery matches `<QinghuDataDir>/agent.json`.
// SECURITY: Token is kept strictly in memory and NEVER logged or exposed over HTTP.
type agentDiscovery struct {
	Port    int    `json:"port"`
	Token   string `json:"token"`
	PID     int    `json:"pid"`
	Version string `json:"version"`
}

// InstanceRuntime describes the running anti-detect browser process managed by Qinghu Agent.
type InstanceRuntime struct {
	PID       int  `json:"pid"`
	ProxyPort *int `json:"proxyPort"`
	DebugPort int  `json:"debugPort"`
	Adopted   bool `json:"adopted"`
}

// Instance describes a Qinghu anti-detect shop profile returned by `GET /instances`.
type Instance struct {
	ID            string           `json:"id"`
	Name          string           `json:"name"`
	Group         string           `json:"group"`
	Shop          string           `json:"shop"`
	Status        string           `json:"status"` // "running" | "stopped"
	ProxyID       *string          `json:"proxyId"`
	Timezone      string           `json:"timezone"`
	Languages     []string         `json:"languages"`
	Runtime       *InstanceRuntime `json:"runtime"`
	FingerprintOK bool             `json:"fingerprintOk"`
	SeedPrefix    string           `json:"seedPrefix"`
	Warnings      []string         `json:"warnings"`
}

// Client talks to the local Qinghu Fingerprint Browser Agent over loopback HTTP with Bearer auth.
type Client struct {
	dataDir    string
	httpClient *http.Client
}

// DefaultDataDir resolves the Qinghu Agent data directory from explicit override, QINGHU_DATA_DIR, or %LOCALAPPDATA%\Qinghu.
func DefaultDataDir(override string) string {
	if s := strings.TrimSpace(override); s != "" {
		return s
	}
	if env := strings.TrimSpace(os.Getenv("QINGHU_DATA_DIR")); env != "" {
		return env
	}
	if localApp := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); localApp != "" {
		return filepath.Join(localApp, "Qinghu")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".qinghu")
}

// NewClient creates a Qinghu Agent client bound to dataDir (re-reads agent.json dynamically so Agent restarts work seamlessly).
func NewClient(dataDir string) *Client {
	return &Client{
		dataDir: DefaultDataDir(dataDir),
		httpClient: &http.Client{
			Timeout: 25 * time.Second,
		},
	}
}

func (c *Client) loadDiscovery() (agentDiscovery, error) {
	path := filepath.Join(c.dataDir, "agent.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return agentDiscovery{}, fmt.Errorf("qinghu agent not detected (%s): %w", path, err)
	}
	var d agentDiscovery
	if err := json.Unmarshal(raw, &d); err != nil {
		return agentDiscovery{}, fmt.Errorf("invalid qinghu agent.json: %w", err)
	}
	if d.Port <= 0 || strings.TrimSpace(d.Token) == "" {
		return agentDiscovery{}, errors.New("qinghu agent.json missing valid port or auth token")
	}
	return d, nil
}

func (c *Client) doJSON(ctx context.Context, method, path string, reqBody any, out any) error {
	disc, err := c.loadDiscovery()
	if err != nil {
		return err
	}
	var bodyReader io.Reader
	if reqBody != nil {
		b, mErr := json.Marshal(reqBody)
		if mErr != nil {
			return mErr
		}
		bodyReader = bytes.NewReader(b)
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d%s", disc.Port, path)
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bodyReader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+disc.Token)
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("qinghu agent request failed: %w", err)
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errPayload struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(respBytes, &errPayload)
		msg := errPayload.Error
		if msg == "" {
			msg = errPayload.Message
		}
		if msg == "" {
			msg = strings.TrimSpace(string(respBytes))
		}
		return fmt.Errorf("qinghu agent HTTP %d: %s", resp.StatusCode, msg)
	}
	if out != nil && len(respBytes) > 0 {
		if err := json.Unmarshal(respBytes, out); err != nil {
			return fmt.Errorf("decode qinghu response: %w", err)
		}
	}
	return nil
}

// ListInstances returns all visible Qinghu shop profiles from `GET /instances`.
func (c *Client) ListInstances(ctx context.Context) ([]Instance, error) {
	var raw json.RawMessage
	if err := c.doJSON(ctx, http.MethodGet, "/instances", nil, &raw); err != nil {
		return nil, err
	}
	// Support both bare JSON array `[...]` and wrapped `{ "instances": [...] }`
	var list []Instance
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var wrapped struct {
		Instances []Instance `json:"instances"`
		Data      []Instance `json:"data"`
	}
	if err := json.Unmarshal(raw, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Instances != nil {
		return wrapped.Instances, nil
	}
	return wrapped.Data, nil
}

// ResolveInstance finds a Qinghu shop profile by exact ID or exact/case-insensitive Name.
func (c *Client) ResolveInstance(ctx context.Context, query string) (*Instance, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, errors.New("qinghu profile name or id is required")
	}
	list, err := c.ListInstances(ctx)
	if err != nil {
		return nil, err
	}
	for i := range list {
		if list[i].ID == q || list[i].Name == q {
			return &list[i], nil
		}
	}
	for i := range list {
		if strings.EqualFold(list[i].Name, q) {
			return &list[i], nil
		}
	}
	return nil, fmt.Errorf("qinghu profile %q not found", q)
}

// EnsureStarted starts the Qinghu profile via Qinghu Agent if stopped, and returns the live Instance with debugPort.
func (c *Client) EnsureStarted(ctx context.Context, query string) (*Instance, error) {
	inst, err := c.ResolveInstance(ctx, query)
	if err != nil {
		return nil, err
	}
	if inst.Status == "running" && inst.Runtime != nil && inst.Runtime.DebugPort > 0 {
		return inst, nil
	}
	path := "/instances/" + url.PathEscape(inst.ID) + "/start"
	if err := c.doJSON(ctx, http.MethodPost, path, map[string]any{}, nil); err != nil {
		return nil, err
	}
	// Re-fetch instance state to obtain the allocated runtime.debugPort
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		fresh, rErr := c.ResolveInstance(ctx, inst.ID)
		if rErr == nil && fresh.Status == "running" && fresh.Runtime != nil && fresh.Runtime.DebugPort > 0 {
			return fresh, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
	return nil, fmt.Errorf("timed out waiting for qinghu profile %q debugPort", inst.Name)
}

// StopInstance gracefully stops a Qinghu profile via Agent (triggering E2EE cookie upload & lease release).
func (c *Client) StopInstance(ctx context.Context, query string) error {
	inst, err := c.ResolveInstance(ctx, query)
	if err != nil {
		return err
	}
	path := "/instances/" + url.PathEscape(inst.ID) + "/stop"
	return c.doJSON(ctx, http.MethodPost, path, map[string]any{}, nil)
}
