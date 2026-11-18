package chrome

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"browser-go/internal/logger"
)

var ErrMaxInstancesReached = errors.New("maximum concurrent instances limit reached")

var safeUserKeyRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// LaunchParams represents the JSON `launch` query parameter.
type LaunchParams struct {
	User     string   `json:"user,omitempty"`
	Args     []string `json:"args,omitempty"`
	Headless *bool    `json:"headless,omitempty"`
}

// VersionInfo represents Chrome's `/json/version` payload.
type VersionInfo struct {
	Browser              string `json:"Browser"`
	ProtocolVersion      string `json:"Protocol-Version"`
	UserAgent            string `json:"User-Agent"`
	V8Version            string `json:"V8-Version"`
	WebKitVersion        string `json:"WebKit-Version"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// InstanceSnapshot matches OpenAPI `BrowserInstance`.
type InstanceSnapshot struct {
	UserID          string `json:"user_id"`
	LastActivity    string `json:"last_activity"`
	IdleTimeSeconds int64  `json:"idle_time_seconds"`
	ActiveConns     int32  `json:"active_conns,omitempty"`
	Ephemeral       bool   `json:"ephemeral,omitempty"`
	DebugPort       int    `json:"debug_port,omitempty"`
}

// StatsSnapshot matches OpenAPI `SystemStatsData`.
type StatsSnapshot struct {
	CurrentInstances      int   `json:"current_instances"`
	MaxInstances          int   `json:"max_instances"`
	AvailableSlots        int   `json:"available_slots"`
	InstanceTimeoutMs     int64 `json:"instance_timeout_ms"`
	InactiveCheckInterval int64 `json:"inactive_check_interval"`
}

// ManagedInstance tracks a running Chrome process and its active CDP sessions.
type ManagedInstance struct {
	Key         string
	IsEphemeral bool
	DebugPort   int
	WSURL       string
	UserDataDir string
	Proc        *procGroup
	CreatedAt   time.Time

	lastActivityUnixMs atomic.Int64
	activeConns        atomic.Int32
	closing            atomic.Bool
}

func (m *ManagedInstance) Touch() {
	if m != nil {
		m.lastActivityUnixMs.Store(time.Now().UnixMilli())
	}
}

func (m *ManagedInstance) LastActivity() time.Time {
	return time.UnixMilli(m.lastActivityUnixMs.Load())
}

func (m *ManagedInstance) ActiveConnections() int32 {
	if m == nil {
		return 0
	}
	return m.activeConns.Load()
}

type inflightLaunch struct {
	done chan struct{}
	inst *ManagedInstance
	err  error
}

// ManagerConfig configures ChromeManager.
type ManagerConfig struct {
	MaxInstances          int
	InstanceTimeout       time.Duration
	InactiveCheckInterval time.Duration
	ChromePath            string
	DefaultHeadless       bool
	DataDir               string
	Logger                *logger.Logger

	// Optional test hook to override browser spawning in unit/integration tests without needing real Chrome
	SpawnOverride func(ctx context.Context, debugPort int, userDataDir, startingURL string, extraArgs []string, headless bool) (*ProcGroup, string, error)
}

// ProcGroup is an alias to procGroup for SpawnOverride hooks across internal packages.
type ProcGroup = procGroup

// NewMockProcess returns an in-memory ProcGroup for fast deterministic integration testing.
func NewMockProcess() (*ProcGroup, func()) {
	pg := &procGroup{exited: make(chan struct{})}
	return pg, pg.markExited
}

// Manager manages the lifecycle, slot quotas, and automatic cleanup of Chrome instances.
type Manager struct {
	cfg        ManagerConfig
	log        *logger.Logger
	httpClient *http.Client

	mu        sync.Mutex
	instances map[string]*ManagedInstance
	inflight  map[string]*inflightLaunch
	reserved  int // slots reserved by currently booting instances

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewManager(cfg ManagerConfig) *Manager {
	if cfg.MaxInstances <= 0 {
		cfg.MaxInstances = 10
	}
	if cfg.InstanceTimeout <= 0 {
		cfg.InstanceTimeout = 60 * time.Minute
	}
	if cfg.InactiveCheckInterval <= 0 {
		cfg.InactiveCheckInterval = 5 * time.Minute
	}
	if cfg.DataDir == "" {
		if h, err := os.UserHomeDir(); err == nil && h != "" {
			cfg.DataDir = filepath.Join(h, ".browser-go")
		} else {
			cfg.DataDir = ".browser-go"
		}
	}
	log := cfg.Logger
	if log == nil {
		log = logger.Default()
	}

	m := &Manager{
		cfg: cfg,
		log: log,
		httpClient: &http.Client{
			Timeout: 1500 * time.Millisecond,
		},
		instances: make(map[string]*ManagedInstance),
		inflight:  make(map[string]*inflightLaunch),
		stopCh:    make(chan struct{}),
	}

	m.wg.Add(1)
	go m.reaperLoop()
	return m
}

func sanitizeKey(raw string) string {
	s := safeUserKeyRe.ReplaceAllString(strings.TrimSpace(raw), "_")
	s = strings.Trim(s, "._-")
	if s == "" {
		return "default"
	}
	if len(s) > 96 {
		s = s[:96]
	}
	return s
}

func randomEphemeralKey() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "ephemeral-" + hex.EncodeToString(b[:])
}

func pickFreeLocalPort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port, nil
}

// Acquire returns a ready *ManagedInstance with activeConns incremented, plus a release closure
// that MUST be called when the client's CDP WebSocket disconnects.
func (m *Manager) Acquire(ctx context.Context, startingURL string, params LaunchParams) (*ManagedInstance, func(), error) {
	if startingURL == "" {
		startingURL = "about:blank"
	}
	userRaw := strings.TrimSpace(params.User)
	isEphemeral := userRaw == ""

	var key string
	if isEphemeral {
		key = randomEphemeralKey()
	} else {
		key = sanitizeKey(userRaw)
	}

	for attempt := 0; attempt < 2; attempt++ {
		m.mu.Lock()
		// 1. Check existing warm persistent instance
		if !isEphemeral {
			if existing, ok := m.instances[key]; ok && !existing.closing.Load() {
				existing.activeConns.Add(1)
				existing.Touch()
				m.mu.Unlock()

				if wsURL, ok := m.probeReadyWSURL(ctx, existing.DebugPort, existing.WSURL); ok {
					existing.WSURL = wsURL
					m.log.Infof("Reusing warm Chrome instance for user %q (port=%d, active=%d)", key, existing.DebugPort, existing.ActiveConnections())
					return existing, m.makeReleaseFunc(existing), nil
				}
				// Process died or debug endpoint unresponsive; evict and relaunch cleanly
				existing.activeConns.Add(-1)
				m.log.Warnf("Cached Chrome instance for user %q is unresponsive; relaunching", key)
				_, _ = m.KillInstance(key)
				continue
			}

			// 2. Coalesce concurrent cold-starts for the same user
			if call, waiting := m.inflight[key]; waiting {
				m.mu.Unlock()
				select {
				case <-call.done:
					if call.err != nil {
						return nil, nil, call.err
					}
					continue
				case <-ctx.Done():
					return nil, nil, ctx.Err()
				}
			}
		}

		// 3. Atomic slot quota check & reservation
		if len(m.instances)+m.reserved >= m.cfg.MaxInstances {
			m.mu.Unlock()
			return nil, nil, ErrMaxInstancesReached
		}

		call := &inflightLaunch{done: make(chan struct{})}
		m.reserved++
		if !isEphemeral {
			m.inflight[key] = call
		}
		m.mu.Unlock()

		// Launch outside global mutex so concurrent users launch in parallel
		inst, err := m.launchNewInstance(ctx, key, isEphemeral, startingURL, params)

		m.mu.Lock()
		m.reserved--
		if !isEphemeral {
			delete(m.inflight, key)
		}
		if err == nil {
			inst.activeConns.Store(1)
			inst.Touch()
			m.instances[key] = inst
		}
		call.inst = inst
		call.err = err
		close(call.done)
		curCount := len(m.instances)
		m.mu.Unlock()

		if err != nil {
			return nil, nil, err
		}

		m.log.Infof("Launched Chrome instance [%s] (pid=%d, port=%d, ephemeral=%v, pool=%d/%d)",
			key, inst.Proc.PID(), inst.DebugPort, isEphemeral, curCount, m.cfg.MaxInstances)

		// Watch process exit to auto-evict from registry
		go m.watchProcessExit(inst)

		return inst, m.makeReleaseFunc(inst), nil
	}

	return nil, nil, errors.New("failed to acquire Chrome instance after retry")
}

func (m *Manager) makeReleaseFunc(inst *ManagedInstance) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			rem := inst.activeConns.Add(-1)
			inst.Touch()
			if inst.IsEphemeral && rem <= 0 {
				m.log.Infof("Releasing ephemeral Chrome instance [%s]", inst.Key)
				_, _ = m.KillInstance(inst.Key)
			}
		})
	}
}

func (m *Manager) watchProcessExit(inst *ManagedInstance) {
	<-inst.Proc.Exited()
	m.mu.Lock()
	cur, ok := m.instances[inst.Key]
	if ok && cur == inst {
		delete(m.instances, inst.Key)
	}
	m.mu.Unlock()

	if inst.IsEphemeral && inst.UserDataDir != "" {
		removeDirWithRetry(inst.UserDataDir)
	}
	m.log.Infof("Chrome process exited [%s] (pid=%d)", inst.Key, inst.Proc.PID())
}

func (m *Manager) launchNewInstance(ctx context.Context, key string, isEphemeral bool, startingURL string, params LaunchParams) (*ManagedInstance, error) {
	port, err := pickFreeLocalPort()
	if err != nil {
		return nil, fmt.Errorf("allocate debug port: %w", err)
	}

	var userDataDir string
	if isEphemeral {
		userDataDir = filepath.Join(m.cfg.DataDir, "ephemeral", key)
	} else {
		userDataDir = filepath.Join(m.cfg.DataDir, "browser_data", key)
	}
	if err := os.MkdirAll(userDataDir, 0755); err != nil {
		return nil, fmt.Errorf("create user data dir: %w", err)
	}

	headless := m.cfg.DefaultHeadless
	if params.Headless != nil {
		headless = *params.Headless
	}

	if m.cfg.SpawnOverride != nil {
		pg, wsURL, err := m.cfg.SpawnOverride(ctx, port, userDataDir, startingURL, params.Args, headless)
		if err != nil {
			if isEphemeral {
				removeDirWithRetry(userDataDir)
			}
			return nil, err
		}
		inst := &ManagedInstance{
			Key:         key,
			IsEphemeral: isEphemeral,
			DebugPort:   port,
			WSURL:       wsURL,
			UserDataDir: userDataDir,
			Proc:        pg,
			CreatedAt:   time.Now(),
		}
		inst.Touch()
		return inst, nil
	}

	chromeBin, err := FindExecutable(m.cfg.ChromePath)
	if err != nil {
		if isEphemeral {
			removeDirWithRetry(userDataDir)
		}
		return nil, err
	}

	flags := []string{
		"--remote-debugging-address=127.0.0.1",
		"--remote-debugging-port=" + strconv.Itoa(port),
		"--remote-allow-origins=*",
		"--user-data-dir=" + userDataDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--disable-ipc-flooding-protection",
		"--disable-popup-blocking",
		"--disable-sync",
		"--disable-translate",
	}
	if headless {
		flags = append(flags, "--headless=new", "--hide-scrollbars", "--mute-audio")
	} else {
		flags = append(flags, "--start-maximized")
	}
	flags = append(flags, params.Args...)
	flags = append(flags, startingURL)

	pg, err := startIsolatedProcess(chromeBin, flags)
	if err != nil {
		if isEphemeral {
			removeDirWithRetry(userDataDir)
		}
		return nil, fmt.Errorf("spawn browser %q: %w", chromeBin, err)
	}

	// Poll http://127.0.0.1:<port>/json/version every 60ms instead of sleeping 3000ms
	wsURL, err := m.waitForDevToolsWS(ctx, pg, port, 18*time.Second)
	if err != nil {
		_ = pg.Kill()
		if isEphemeral {
			removeDirWithRetry(userDataDir)
		}
		return nil, err
	}

	inst := &ManagedInstance{
		Key:         key,
		IsEphemeral: isEphemeral,
		DebugPort:   port,
		WSURL:       wsURL,
		UserDataDir: userDataDir,
		Proc:        pg,
		CreatedAt:   time.Now(),
	}
	inst.Touch()
	return inst, nil
}

func (m *Manager) waitForDevToolsWS(ctx context.Context, pg *procGroup, port int, maxWait time.Duration) (string, error) {
	deadline := time.Now().Add(maxWait)
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-pg.Exited():
			return "", errors.New("browser process exited prematurely before opening DevTools port")
		default:
		}

		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		resp, err := m.httpClient.Do(req)
		if err == nil {
			var v VersionInfo
			decErr := json.NewDecoder(resp.Body).Decode(&v)
			_ = resp.Body.Close()
			if decErr == nil && v.WebSocketDebuggerURL != "" {
				return v.WebSocketDebuggerURL, nil
			}
		}

		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-pg.Exited():
			return "", errors.New("browser process exited prematurely before DevTools ready")
		case <-time.After(60 * time.Millisecond):
		}
	}
	return "", fmt.Errorf("timed out waiting for Chrome DevTools on 127.0.0.1:%d", port)
}

func (m *Manager) probeReadyWSURL(ctx context.Context, port int, fallbackWS string) (string, bool) {
	if m.cfg.SpawnOverride != nil && fallbackWS != "" {
		return fallbackWS, true
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	pCtx, cancel := context.WithTimeout(ctx, 1200*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(pCtx, http.MethodGet, endpoint, nil)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	var v VersionInfo
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil || v.WebSocketDebuggerURL == "" {
		return "", false
	}
	return v.WebSocketDebuggerURL, true
}

// KillInstance terminates a running Chrome instance by userKey (raw or sanitized).
func (m *Manager) KillInstance(userKey string) (bool, error) {
	candidates := []string{userKey, sanitizeKey(userKey)}
	var target *ManagedInstance

	m.mu.Lock()
	for _, k := range candidates {
		if inst, ok := m.instances[k]; ok {
			target = inst
			target.closing.Store(true)
			delete(m.instances, k)
			break
		}
	}
	m.mu.Unlock()

	if target == nil {
		return false, nil
	}
	err := target.Proc.Kill()
	if target.IsEphemeral && target.UserDataDir != "" {
		removeDirWithRetry(target.UserDataDir)
	}
	return true, err
}

// HasInstance checks whether an active instance exists for userKey.
func (m *Manager) HasInstance(userKey string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.instances[userKey]; ok {
		return true
	}
	_, ok := m.instances[sanitizeKey(userKey)]
	return ok
}

// ListInstances returns snapshots of all active Chrome instances.
func (m *Manager) ListInstances() []InstanceSnapshot {
	now := time.Now()
	m.mu.Lock()
	out := make([]InstanceSnapshot, 0, len(m.instances))
	for _, inst := range m.instances {
		last := inst.LastActivity()
		idleSec := int64(now.Sub(last).Seconds())
		if idleSec < 0 {
			idleSec = 0
		}
		out = append(out, InstanceSnapshot{
			UserID:          inst.Key,
			LastActivity:    last.UTC().Format(time.RFC3339Nano),
			IdleTimeSeconds: idleSec,
			ActiveConns:     inst.ActiveConnections(),
			Ephemeral:       inst.IsEphemeral,
			DebugPort:       inst.DebugPort,
		})
	}
	m.mu.Unlock()

	sort.Slice(out, func(i, j int) bool {
		return out[i].UserID < out[j].UserID
	})
	return out
}

// Stats returns current capacity and quota statistics.
func (m *Manager) Stats() StatsSnapshot {
	m.mu.Lock()
	cur := len(m.instances) + m.reserved
	m.mu.Unlock()

	avail := m.cfg.MaxInstances - cur
	if avail < 0 {
		avail = 0
	}
	return StatsSnapshot{
		CurrentInstances:      cur,
		MaxInstances:          m.cfg.MaxInstances,
		AvailableSlots:        avail,
		InstanceTimeoutMs:     m.cfg.InstanceTimeout.Milliseconds(),
		InactiveCheckInterval: m.cfg.InactiveCheckInterval.Milliseconds(),
	}
}

func (m *Manager) reaperLoop() {
	defer m.wg.Done()
	tk := time.NewTicker(m.cfg.InactiveCheckInterval)
	defer tk.Stop()

	for {
		select {
		case <-tk.C:
			m.CleanupInactive()
		case <-m.stopCh:
			return
		}
	}
}

// CleanupInactive kills idle persistent instances that have zero active connections and exceeded InstanceTimeout.
func (m *Manager) CleanupInactive() int {
	now := time.Now()
	var stale []*ManagedInstance

	m.mu.Lock()
	for k, inst := range m.instances {
		if inst.ActiveConnections() > 0 {
			continue
		}
		if now.Sub(inst.LastActivity()) > m.cfg.InstanceTimeout {
			inst.closing.Store(true)
			delete(m.instances, k)
			stale = append(stale, inst)
		}
	}
	m.mu.Unlock()

	for _, inst := range stale {
		m.log.Infof("Closing idle Chrome instance [%s] (idle > %s)", inst.Key, m.cfg.InstanceTimeout)
		_ = inst.Proc.Kill()
		if inst.IsEphemeral && inst.UserDataDir != "" {
			removeDirWithRetry(inst.UserDataDir)
		}
	}
	return len(stale)
}

// Shutdown gracefully terminates all active Chrome instances and stops background reapers.
func (m *Manager) Shutdown() {
	select {
	case <-m.stopCh:
		return
	default:
		close(m.stopCh)
	}
	m.wg.Wait()

	m.mu.Lock()
	all := make([]*ManagedInstance, 0, len(m.instances))
	for k, inst := range m.instances {
		inst.closing.Store(true)
		all = append(all, inst)
		delete(m.instances, k)
	}
	m.mu.Unlock()

	var killWG sync.WaitGroup
	for _, inst := range all {
		killWG.Add(1)
		go func(target *ManagedInstance) {
			defer killWG.Done()
			m.log.Infof("Shutting down Chrome instance [%s] (pid=%d)", target.Key, target.Proc.PID())
			_ = target.Proc.Kill()
			if target.IsEphemeral && target.UserDataDir != "" {
				removeDirWithRetry(target.UserDataDir)
			}
		}(inst)
	}
	killWG.Wait()
}

func removeDirWithRetry(dir string) {
	for i := 0; i < 5; i++ {
		if err := os.RemoveAll(dir); err == nil {
			return
		}
		time.Sleep(120 * time.Millisecond)
	}
}
