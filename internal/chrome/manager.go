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
	"net/url"
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
	"browser-go/internal/qinghu"
)

var (
	ErrMaxInstancesReached  = errors.New("maximum concurrent instances limit reached")
	ErrForbiddenLaunchArg   = errors.New("forbidden Chrome launch argument")
	ErrInvalidNavigationURL = errors.New("invalid or forbidden navigation URL")
	ErrInvalidTargetID      = errors.New("invalid Chrome target ID")
)

var (
	safeUserKeyRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	safeTargetRe  = regexp.MustCompile(`^[A-Za-z0-9_-]{4,128}$`)
)

// allowedLaunchFlags defines the strict allowlist of safe Chrome CLI flags clients may pass via `launch.args`.
// Dangerous flags (e.g. --gpu-launcher, --renderer-cmd-prefix, --user-data-dir, --load-extension, --remote-debugging-*)
// are always rejected to prevent host command execution (RCE) and profile isolation bypass.
var allowedBoolLaunchFlags = map[string]bool{
	"--headless":                     true,
	"--headless=new":                 true,
	"--headless=old":                 true,
	"--incognito":                    true,
	"--start-maximized":              true,
	"--mute-audio":                   true,
	"--hide-scrollbars":              true,
	"--disable-gpu":                  true,
	"--disable-dev-shm-usage":        true,
	"--no-sandbox":                   true,
	"--disable-setuid-sandbox":       true,
	"--disable-notifications":        true,
	"--ignore-certificate-errors":    true,
	"--disable-extensions":           true,
	"--disable-default-apps":         true,
	"--disable-background-networking": true,
	"--disable-features=TranslateUI": true,
	"--disable-blink-features=AutomationControlled": true,
}

var allowedPrefixLaunchFlags = []string{
	"--proxy-server=",
	"--proxy-bypass-list=",
	"--window-size=",
	"--window-position=",
	"--lang=",
	"--accept-lang=",
	"--user-agent=",
	"--force-device-scale-factor=",
	"--autoplay-policy=",
	"--disable-blink-features=",
	"--disable-features=",
	"--enable-features=",
}

// SanitizeLaunchArgs validates client-supplied Chrome CLI arguments against a strict security allowlist.
func SanitizeLaunchArgs(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > 32 {
		return nil, fmt.Errorf("%w: too many launch args (%d)", ErrForbiddenLaunchArg, len(raw))
	}
	out := make([]string, 0, len(raw))
	for _, a := range raw {
		arg := strings.TrimSpace(a)
		if arg == "" {
			continue
		}
		if len(arg) > 512 || strings.ContainsAny(arg, "\x00\r\n") {
			return nil, fmt.Errorf("%w: malformed argument", ErrForbiddenLaunchArg)
		}
		lower := strings.ToLower(arg)
		if allowedBoolLaunchFlags[lower] {
			out = append(out, arg)
			continue
		}
		ok := false
		for _, pref := range allowedPrefixLaunchFlags {
			if strings.HasPrefix(lower, pref) && len(arg) > len(pref) {
				ok = true
				break
			}
		}
		if !ok {
			return nil, fmt.Errorf("%w: %q is not in allowlist", ErrForbiddenLaunchArg, arg)
		}
		out = append(out, arg)
	}
	return out, nil
}

// ValidateNavigationURL restricts initial/new-tab URLs to safe web schemes, blocking file://, chrome://, javascript:, etc.
func ValidateNavigationURL(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || strings.EqualFold(s, "about:blank") {
		return "about:blank", nil
	}
	if len(s) > 8192 || strings.ContainsAny(s, "\x00\r\n") {
		return "", fmt.Errorf("%w: contains control characters or exceeds length limit", ErrInvalidNavigationURL)
	}
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "data:text/html") {
		return s, nil
	}
	// Bare domain/host (e.g. "bing.com") -> normalize to https://
	if !strings.Contains(s, "://") && !strings.Contains(s, ":") {
		return "https://" + s, nil
	}
	return "", fmt.Errorf("%w: disallowed scheme in %q", ErrInvalidNavigationURL, s)
}

// ValidateTargetID ensures a Chrome DevTools target ID contains only safe path characters.
func ValidateTargetID(id string) error {
	if !safeTargetRe.MatchString(id) {
		return fmt.Errorf("%w: %q", ErrInvalidTargetID, id)
	}
	return nil
}

// LaunchParams represents the JSON `launch` query parameter.
type LaunchParams struct {
	User          string   `json:"user,omitempty"`
	Args          []string `json:"args,omitempty"`
	Headless      *bool    `json:"headless,omitempty"`
	Provider      string   `json:"provider,omitempty"`      // "chrome" (default) or "qinghu" (Qinghu Anti-Detect Browser)
	QinghuProfile string   `json:"qinghuProfile,omitempty"` // explicit Qinghu shop profile name or ID
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
	UserID          string        `json:"user_id"`
	LastActivity    string        `json:"last_activity"`
	IdleTimeSeconds int64         `json:"idle_time_seconds"`
	ActiveConns     int32         `json:"active_conns,omitempty"`
	Ephemeral       bool          `json:"ephemeral,omitempty"`
	DebugPort       int           `json:"debug_port,omitempty"`
	CurrentURL      string        `json:"current_url,omitempty"`
	CurrentTitle    string        `json:"current_title,omitempty"`
	Handoff         *HandoffState `json:"handoff,omitempty"`
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
	IsQinghu    bool
	QinghuID    string
	DebugPort   int
	WSURL       string
	UserDataDir string
	Proc        *procGroup
	CreatedAt   time.Time

	lastActivityUnixMs atomic.Int64
	activeConns        atomic.Int32
	activeTakeovers    atomic.Int32
	closing            atomic.Bool

	metaMu      sync.Mutex
	cachedURL   string
	cachedTitle string
	cachedAt    time.Time
}

// TryAcquireTakeover reserves one WebRTC Live View slot up to maxConcurrent per Chrome instance.
func (m *ManagedInstance) TryAcquireTakeover(maxConcurrent int32) (func(), bool) {
	if m == nil || maxConcurrent <= 0 {
		return func() {}, true
	}
	for {
		cur := m.activeTakeovers.Load()
		if cur >= maxConcurrent {
			return nil, false
		}
		if m.activeTakeovers.CompareAndSwap(cur, cur+1) {
			var once sync.Once
			return func() {
				once.Do(func() {
					m.activeTakeovers.Add(-1)
				})
			}, true
		}
	}
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
	QinghuEnabled         bool
	QinghuDataDir         string
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
	qinghuCli  *qinghu.Client

	mu        sync.Mutex
	instances map[string]*ManagedInstance
	inflight  map[string]*inflightLaunch
	handoffs  map[string]*pendingHandoff
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
		qinghuCli: qinghu.NewClient(cfg.QinghuDataDir),
		instances: make(map[string]*ManagedInstance),
		inflight:  make(map[string]*inflightLaunch),
		handoffs:  make(map[string]*pendingHandoff),
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
	safeURL, err := ValidateNavigationURL(startingURL)
	if err != nil {
		return nil, nil, err
	}
	startingURL = safeURL

	// Route to Qinghu Anti-Detect Fingerprint Browser Agent when --qinghu is active or explicitly requested in launch params
	if m.cfg.QinghuEnabled || strings.EqualFold(strings.TrimSpace(params.Provider), "qinghu") || strings.TrimSpace(params.QinghuProfile) != "" {
		profileQuery := strings.TrimSpace(params.QinghuProfile)
		if profileQuery == "" {
			profileQuery = strings.TrimSpace(params.User)
		}
		if profileQuery == "" {
			return nil, nil, errors.New("qinghu mode requires launch.user or launch.qinghuProfile (shop profile name or ID)")
		}
		return m.acquireQinghu(ctx, profileQuery)
	}

	safeArgs, err := SanitizeLaunchArgs(params.Args)
	if err != nil {
		return nil, nil, err
	}
	params.Args = safeArgs

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

// acquireQinghu delegates profile startup & anti-detect isolation to the local Qinghu Agent,
// then binds its DevTools WebSocket into Browser-Go's unified CDP + WebRTC Live View registry.
func (m *Manager) acquireQinghu(ctx context.Context, profileQuery string) (*ManagedInstance, func(), error) {
	if m.qinghuCli == nil {
		return nil, nil, errors.New("qinghu client not initialized")
	}
	qhInst, err := m.qinghuCli.EnsureStarted(ctx, profileQuery)
	if err != nil {
		return nil, nil, err
	}
	port := qhInst.Runtime.DebugPort
	wsURL, ok := m.probeReadyWSURL(ctx, port, "")
	if !ok {
		return nil, nil, fmt.Errorf("qinghu profile %q DevTools port %d not ready", qhInst.Name, port)
	}

	key := qhInst.Name
	if key == "" {
		key = qhInst.ID
	}

	m.mu.Lock()
	existing, exists := m.instances[key]
	if exists && !existing.closing.Load() && existing.DebugPort == port {
		existing.WSURL = wsURL
		existing.IsQinghu = true
		existing.QinghuID = qhInst.ID
		existing.activeConns.Add(1)
		existing.Touch()
		m.mu.Unlock()
		m.log.Infof("Attached to Qinghu Fingerprint Browser [%s] (id=%s, port=%d)", key, qhInst.ID, port)
		return existing, m.makeReleaseFunc(existing), nil
	}

	inst := &ManagedInstance{
		Key:         key,
		IsEphemeral: false,
		IsQinghu:    true,
		QinghuID:    qhInst.ID,
		DebugPort:   port,
		WSURL:       wsURL,
		CreatedAt:   time.Now(),
	}
	inst.activeConns.Store(1)
	inst.Touch()
	m.instances[key] = inst
	m.mu.Unlock()

	m.log.Infof("Connected Qinghu Fingerprint Browser [%s] (id=%s, port=%d)", key, qhInst.ID, port)
	return inst, m.makeReleaseFunc(inst), nil
}

// syncRunningQinghuProfiles mirrors already-running Qinghu shop profiles into the node registry
// so /dashboard and WebRTC Live View can immediately discover and attach to them.
func (m *Manager) syncRunningQinghuProfiles() {
	if !m.cfg.QinghuEnabled || m.qinghuCli == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	list, err := m.qinghuCli.ListInstances(ctx)
	if err != nil {
		return
	}

	liveKeys := make(map[string]struct{}, len(list))
	for _, qh := range list {
		if qh.Status != "running" || qh.Runtime == nil || qh.Runtime.DebugPort <= 0 {
			continue
		}
		key := qh.Name
		if key == "" {
			key = qh.ID
		}
		liveKeys[key] = struct{}{}

		m.mu.Lock()
		cur, ok := m.instances[key]
		if !ok || cur.DebugPort != qh.Runtime.DebugPort {
			wsURL, ready := m.probeReadyWSURL(ctx, qh.Runtime.DebugPort, "")
			if ready {
				inst := &ManagedInstance{
					Key:         key,
					IsEphemeral: false,
					IsQinghu:    true,
					QinghuID:    qh.ID,
					DebugPort:   qh.Runtime.DebugPort,
					WSURL:       wsURL,
					CreatedAt:   time.Now(),
				}
				inst.Touch()
				m.instances[key] = inst
			}
		}
		m.mu.Unlock()
	}

	// Evict any previously synced Qinghu profiles that were stopped externally in Qinghu GUI
	m.mu.Lock()
	for k, inst := range m.instances {
		if inst.IsQinghu {
			if _, alive := liveKeys[k]; !alive {
				delete(m.instances, k)
			}
		}
	}
	m.mu.Unlock()
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
	if target.IsQinghu && m.qinghuCli != nil {
		// Graceful stop via Qinghu Agent so E2EE cloud cookies are uploaded & lease lock is released
		stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return true, m.qinghuCli.StopInstance(stopCtx, target.QinghuID)
	}
	err := target.Proc.Kill()
	if target.IsEphemeral && target.UserDataDir != "" {
		removeDirWithRetry(target.UserDataDir)
	}
	return true, err
}

// TargetSnapshot represents an individual tab/page target returned by Chrome's `/json/list`.
type TargetSnapshot struct {
	ID                   string `json:"id"`
	Type                 string `json:"type"`
	Title                string `json:"title"`
	URL                  string `json:"url"`
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl,omitempty"`
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

// AttachExisting attaches a Live View / DevTools client to an already-running Chrome instance
// without spawning a new browser, incrementing activeConns so idle GC will not evict it during takeover.
func (m *Manager) AttachExisting(userKey string) (*ManagedInstance, func(), error) {
	candidates := []string{userKey, sanitizeKey(userKey)}
	m.mu.Lock()
	var inst *ManagedInstance
	for _, k := range candidates {
		if existing, ok := m.instances[k]; ok && !existing.closing.Load() {
			inst = existing
			break
		}
	}
	if inst == nil {
		m.mu.Unlock()
		return nil, nil, fmt.Errorf("browser instance %q not found", userKey)
	}
	inst.activeConns.Add(1)
	inst.Touch()
	m.mu.Unlock()

	return inst, m.makeReleaseFunc(inst), nil
}

func (m *Manager) lookupRunningPort(userKey string) (int, error) {
	raw := strings.TrimSpace(userKey)
	sanitized := sanitizeKey(raw)
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range []string{raw, sanitized} {
		if existing, ok := m.instances[k]; ok && !existing.closing.Load() {
			return existing.DebugPort, nil
		}
	}
	return 0, fmt.Errorf("browser instance %q not found", userKey)
}

// ListTargets fetches active page tabs from a running Chrome instance's local DevTools HTTP endpoint
// without mutating activeConns or resetting idle timestamps.
func (m *Manager) ListTargets(ctx context.Context, userKey string) ([]TargetSnapshot, error) {
	port, err := m.lookupRunningPort(userKey)
	if err != nil {
		return nil, err
	}

	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/list", port)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var all []TargetSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&all); err != nil {
		return nil, err
	}
	pages := make([]TargetSnapshot, 0, len(all))
	for _, t := range all {
		if t.Type == "page" {
			pages = append(pages, t)
		}
	}
	return pages, nil
}

// ActivateTarget brings a specific Chrome page tab to the foreground via DevTools HTTP API.
func (m *Manager) ActivateTarget(ctx context.Context, userKey, targetID string) error {
	if err := ValidateTargetID(targetID); err != nil {
		return err
	}
	port, err := m.lookupRunningPort(userKey)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/activate/%s", port, url.PathEscape(targetID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

// CreateTarget opens a new page tab in a running Chrome instance via DevTools HTTP API.
func (m *Manager) CreateTarget(ctx context.Context, userKey, targetURL string) (*TargetSnapshot, error) {
	safeURL, err := ValidateNavigationURL(targetURL)
	if err != nil {
		return nil, err
	}
	port, err := m.lookupRunningPort(userKey)
	if err != nil {
		return nil, err
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/new?%s", port, url.QueryEscape(safeURL))
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var t TargetSnapshot
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil {
		return nil, err
	}
	return &t, nil
}

// CloseTarget closes a specific page tab in a running Chrome instance via DevTools HTTP API.
func (m *Manager) CloseTarget(ctx context.Context, userKey, targetID string) error {
	if err := ValidateTargetID(targetID); err != nil {
		return err
	}
	port, err := m.lookupRunningPort(userKey)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/close/%s", port, url.PathEscape(targetID))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

// ListInstances returns snapshots of all active Chrome instances, probing current URLs concurrently with a 1s TTL cache.
func (m *Manager) ListInstances() []InstanceSnapshot {
	m.syncRunningQinghuProfiles()
	now := time.Now()
	m.mu.Lock()
	type instPair struct {
		inst *ManagedInstance
		idx  int
	}
	out := make([]InstanceSnapshot, 0, len(m.instances))
	toProbe := make([]instPair, 0, len(m.instances))
	for _, inst := range m.instances {
		last := inst.LastActivity()
		idleSec := int64(now.Sub(last).Seconds())
		if idleSec < 0 {
			idleSec = 0
		}
		snap := InstanceSnapshot{
			UserID:          inst.Key,
			LastActivity:    last.UTC().Format(time.RFC3339Nano),
			IdleTimeSeconds: idleSec,
			ActiveConns:     inst.ActiveConnections(),
			Ephemeral:       inst.IsEphemeral,
			DebugPort:       inst.DebugPort,
		}
		if ph, ok := m.handoffs[inst.Key]; ok && ph.state.Status == "waiting" {
			cp := ph.state
			snap.Handoff = &cp
		}
		inst.metaMu.Lock()
		fresh := now.Sub(inst.cachedAt) < time.Second
		if fresh {
			snap.CurrentURL = inst.cachedURL
			snap.CurrentTitle = inst.cachedTitle
		}
		inst.metaMu.Unlock()

		idx := len(out)
		out = append(out, snap)
		if !fresh && inst.DebugPort > 0 {
			toProbe = append(toProbe, instPair{inst: inst, idx: idx})
		}
	}
	m.mu.Unlock()

	if len(toProbe) > 0 {
		var pwg sync.WaitGroup
		for _, pair := range toProbe {
			pwg.Add(1)
			go func(p instPair) {
				defer pwg.Done()
				pCtx, pCancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
				defer pCancel()
				endpoint := fmt.Sprintf("http://127.0.0.1:%d/json/list", p.inst.DebugPort)
				req, err := http.NewRequestWithContext(pCtx, http.MethodGet, endpoint, nil)
				if err != nil {
					return
				}
				resp, rErr := m.httpClient.Do(req)
				if rErr != nil {
					return
				}
				var all []TargetSnapshot
				decErr := json.NewDecoder(resp.Body).Decode(&all)
				_ = resp.Body.Close()
				if decErr != nil {
					return
				}
				var curURL, curTitle string
				for _, t := range all {
					if t.Type == "page" {
						curURL = t.URL
						curTitle = t.Title
						break
					}
				}
				p.inst.metaMu.Lock()
				p.inst.cachedURL = curURL
				p.inst.cachedTitle = curTitle
				p.inst.cachedAt = time.Now()
				p.inst.metaMu.Unlock()
				out[p.idx].CurrentURL = curURL
				out[p.idx].CurrentTitle = curTitle
			}(pair)
		}
		pwg.Wait()
	}

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
		if inst.IsQinghu || inst.ActiveConnections() > 0 {
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
		if inst.IsQinghu || inst.Proc == nil {
			// Do not hard-kill Qinghu Agent-managed shop windows on browser-go shutdown
			continue
		}
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
