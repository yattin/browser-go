package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TunnelConfig holds ProxyForge wire-compatible intranet penetration settings.
type TunnelConfig struct {
	BridgeAddr   string // --pf-bridge (e.g. "public.host:33080")
	Mode         string // --pf-mode ("mux" for bridge/client, "multi" for tbridge/tclient; default "mux")
	ClientKey    string // --pf-key (client_key registered on bridge)
	Proto        string // --pf-proto ("tls", "tcp", "ws", "wss", "kcp"; default "tls")
	SessionCount int    // --pf-sessions (mux session count; default 2)
	EnableP2P    bool   // --pf-p2p (enable UDP STUN + NAT hole-punching KCP direct stream)

	CertFile   string // --pf-cert / -C
	KeyFile    string // --pf-key-file / -K
	CABundle   string // --pf-ca / --ca-bundle
	TLSPin     string // --pf-tls-pin
	SingleTLS  bool   // --pf-single-tls
	WSPath     string // --pf-ws-path
	Password   string // --pf-pass / -Z (AES-256-GCM stream layer)
	Compress   bool   // --pf-compress / -M (Flate stream layer)
	Timeout    time.Duration

	// KCP+FEC options (wire-compatible with xtaci/kcp-go/v5 in ProxyForge)
	KCPMethod      string // --pf-kcp-method (default "aes")
	KCPKey         string // --pf-kcp-key (default "proxyforge-kcp-default-key")
	KCPMode        string // --pf-kcp-mode ("normal", "fast", "fast2", "fast3"; default "fast")
	KCPMTU         int    // --pf-kcp-mtu (default 1350)
	KCPSndWnd      int    // --pf-kcp-sndwnd (default 1024)
	KCPRcvWnd      int    // --pf-kcp-rcvwnd (default 1024)
	KCPDataShard   int    // --pf-kcp-datashard (default 10)
	KCPParityShard int    // --pf-kcp-parityshard (default 3)
	KCPNoComp      bool   // --pf-kcp-nocomp

	// Optional ProxyForge Admin Cluster Hub (:55333) telemetry integration
	HubAddr   string // --pf-hub
	HubSecret string // --pf-hub-key
	HubPin    string // --pf-hub-pin
	HubCA     string // --pf-hub-ca
}

// WebRTCConfig configures WebRTC Live View media encoding, ICE servers, and built-in TURN relay.
type WebRTCConfig struct {
	STUNServers []string // --webrtc-stun (comma-separated)
	TURNServers []string // --webrtc-turn (comma-separated turn:user:pass@host:port)
	FPS         int      // --webrtc-fps (default 30)
	Encoder     string   // --webrtc-encoder ("auto", "nvenc", "qsv", "amf", "mf", "x264", "dc")
	FFmpegPath  string   // --ffmpeg-path

	// Built-in pion/turn/v4 server options (used by `browser-go pool`)
	TURNListen   string // --webrtc-turn-listen (e.g. ":3478")
	TURNPublicIP string // --webrtc-public-ip
	TURNSecret   string // --webrtc-turn-secret
}

// NodeConfig configures a Browser-Go worker node (`browser-go` or `browser-go node`).
type NodeConfig struct {
	Host                  string
	HostExplicit          bool
	Port                  int
	MaxInstances          int
	InstanceTimeout       time.Duration
	InactiveCheckInterval time.Duration
	Token                 string
	StrictAuth            bool
	CDPLogging            bool
	ChromePath            string
	Headless              bool
	DataDir               string
	NodeID                string
	Tags                  map[string]string
	NoLogFile             bool
	Debug                 bool
	Daemon                bool
	ServiceName           string
	Tunnel                TunnelConfig
	WebRTC                WebRTCConfig
}

// PoolConfig configures a Browser-Go central CDP Pool Gateway (`browser-go pool`).
type PoolConfig struct {
	Host         string
	Port         int
	Token        string
	StrictAuth   bool
	QueueTimeout time.Duration
	ProbeEvery   time.Duration
	Backends     []string // --backends="node1=http://127.0.0.1:13001#region=shanghai,..."
	DataDir      string
	NoLogFile    bool
	Debug        bool
	Daemon       bool
	ServiceName  string
	WebRTC       WebRTCConfig

	// Built-in ProxyForge-compatible Bridge listener for zero-port-mapping auto node registration
	PFListen     string // --pf-listen (e.g. ":33080")
	PFProto      string // --pf-proto (default "tls")
	PFCertFile   string // --pf-cert
	PFKeyFile    string // --pf-key-file
	PFSingleTLS  bool   // --pf-single-tls
	PFClientKeys string // --pf-client-keys (comma-separated whitelist)
	PFPassword   string // --pf-pass
	PFCompress   bool   // --pf-compress
	PFEnableP2P  bool   // --pf-p2p
}

// KeygenConfig configures `browser-go keygen` for issuing CA/leaf mTLS certificates.
type KeygenConfig struct {
	Mode      string // "ca" or "leaf"
	Domain    string
	ValidDays int
	OutPrefix string
	CACert    string
	CAKey     string
	JSONOut   bool
}

// ServiceConfig configures Windows SCM service management (`install`, `uninstall`, `start`, `stop`, `status`).
type ServiceConfig struct {
	Action      string   // "install", "uninstall", "start", "stop", "status"
	Name        string   // default "BrowserGo"
	DisplayName string   // default "Browser-Go CDP Service"
	ServiceArgs []string // normalized arguments passed to CreateService on install
	JSONOut     bool
}

// Command represents the parsed top-level CLI invocation.
type Command struct {
	Subcommand string // "node", "pool", "keygen", "service", "version", "help"
	Node       NodeConfig
	Pool       PoolConfig
	Keygen     KeygenConfig
	Service    ServiceConfig
}

// DefaultDataDir returns ~/.browser-go.
func DefaultDataDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return filepath.Join(h, ".browser-go")
	}
	return ".browser-go"
}

// ParseCLI parses command-line arguments supporting both `--flag=val` and `--flag val` styles.
func ParseCLI(args []string) (Command, error) {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "browser-node-1"
	}

	cmd := Command{
		Subcommand: "node",
		Node: NodeConfig{
			Host:                  "0.0.0.0",
			Port:                  3000,
			MaxInstances:          10,
			InstanceTimeout:       60 * time.Minute,
			InactiveCheckInterval: 5 * time.Minute,
			Token:                 "browser-go-token",
			DataDir:               DefaultDataDir(),
			NodeID:                hostname,
			Tags:                  make(map[string]string),
			Tunnel: TunnelConfig{
				Mode:           "mux",
				ClientKey:      hostname,
				Proto:          "tls",
				SessionCount:   2,
				Timeout:        10 * time.Second,
				KCPMethod:      "aes",
				KCPKey:         "",
				KCPMode:        "fast",
				KCPMTU:         1350,
				KCPSndWnd:      1024,
				KCPRcvWnd:      1024,
				KCPDataShard:   10,
				KCPParityShard: 3,
			},
			WebRTC: WebRTCConfig{
				STUNServers: []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"},
				FPS:         30,
				Encoder:     "auto",
			},
		},
		Pool: PoolConfig{
			Host:         "0.0.0.0",
			Port:         3000,
			Token:        "browser-go-token",
			QueueTimeout: 20 * time.Second,
			ProbeEvery:   3 * time.Second,
			DataDir:      DefaultDataDir(),
			PFProto:      "tls",
			WebRTC: WebRTCConfig{
				STUNServers: []string{"stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"},
				FPS:         30,
				Encoder:     "auto",
			},
		},
		Keygen: KeygenConfig{
			Mode:      "ca",
			Domain:    "browser-go.local",
			ValidDays: 3650,
			OutPrefix: "ca",
		},
		Service: ServiceConfig{
			Name:        "BrowserGo",
			DisplayName: "Browser-Go CDP Service",
		},
	}

	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub := strings.ToLower(strings.TrimSpace(args[0]))
		switch sub {
		case "node", "pool", "keygen", "version", "help":
			cmd.Subcommand = sub
			args = args[1:]
		case "service":
			cmd.Subcommand = "service"
			args = args[1:]
			if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
				cmd.Service.Action = strings.ToLower(strings.TrimSpace(args[0]))
				args = args[1:]
			}
		case "install", "uninstall", "start", "stop", "status":
			cmd.Subcommand = "service"
			cmd.Service.Action = sub
			args = args[1:]
		default:
			return cmd, fmt.Errorf("unknown subcommand %q (expected node, pool, keygen, service, install, uninstall, status, version, or help)", args[0])
		}
	}

	switch cmd.Subcommand {
	case "version", "help":
		return cmd, nil
	case "node":
		cmd.Node.ServiceName = "BrowserGo"
		if err := parseNodeFlags(&cmd, args); err != nil {
			return cmd, err
		}
	case "pool":
		cmd.Pool.ServiceName = "BrowserGoPool"
		if err := parsePoolFlags(&cmd, args); err != nil {
			return cmd, err
		}
	case "keygen":
		if err := parseKeygenFlags(&cmd, args); err != nil {
			return cmd, err
		}
	case "service":
		if err := parseServiceFlags(&cmd, args); err != nil {
			return cmd, err
		}
	}
	return cmd, nil
}

func nextVal(args []string, i *int, inlineVal string, hasInline bool) (string, error) {
	if hasInline {
		return inlineVal, nil
	}
	if *i+1 >= len(args) {
		return "", fmt.Errorf("flag %q requires a value", args[*i])
	}
	*i++
	return args[*i], nil
}

func splitFlag(raw string) (name string, val string, hasVal bool) {
	s := strings.TrimLeft(raw, "-")
	if idx := strings.IndexByte(s, '='); idx >= 0 {
		return s[:idx], s[idx+1:], true
	}
	return s, "", false
}

func parseBoolVal(hasVal bool, val string) bool {
	if !hasVal {
		return true
	}
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

func splitCSV(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func ParseTagsCSV(raw string) map[string]string {
	out := make(map[string]string)
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		sep := "="
		if !strings.Contains(part, "=") && strings.Contains(part, ":") {
			sep = ":"
		}
		if k, v, ok := strings.Cut(part, sep); ok {
			k = strings.TrimSpace(k)
			v = strings.TrimSpace(v)
			if k != "" {
				out[k] = v
			}
		} else {
			out[part] = "true"
		}
	}
	return out
}

func parseNodeFlags(cmd *Command, args []string) error {
	n := &cmd.Node
	keyExplicit := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-h" || arg == "--help" {
			cmd.Subcommand = "help"
			return nil
		}
		if arg == "-v" || arg == "--version" {
			cmd.Subcommand = "version"
			return nil
		}
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name, val, hasVal := splitFlag(arg)
		switch name {
		case "host":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Host = v
			n.HostExplicit = true
		case "port", "p":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p, err := strconv.Atoi(v)
			if err != nil || p < 0 || p > 65535 {
				return fmt.Errorf("invalid --port %q", v)
			}
			n.Port = p
		case "max-instances":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if m, err := strconv.Atoi(v); err == nil && m > 0 {
				n.MaxInstances = m
			}
		case "instance-timeout":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if mins, err := strconv.Atoi(v); err == nil && mins > 0 {
				n.InstanceTimeout = time.Duration(mins) * time.Minute
			} else if d, err := time.ParseDuration(v); err == nil && d > 0 {
				n.InstanceTimeout = d
			}
		case "inactive-check-interval":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if mins, err := strconv.Atoi(v); err == nil && mins > 0 {
				n.InactiveCheckInterval = time.Duration(mins) * time.Minute
			} else if d, err := time.ParseDuration(v); err == nil && d > 0 {
				n.InactiveCheckInterval = d
			}
		case "token":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if v != "" {
				n.Token = v
			}
		case "strict-auth":
			n.StrictAuth = parseBoolVal(hasVal, val)
		case "cdp-logging":
			n.CDPLogging = parseBoolVal(hasVal, val)
		case "chrome-path":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.ChromePath = v
		case "headless":
			n.Headless = parseBoolVal(hasVal, val)
		case "data-dir":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.DataDir = v
		case "node-id":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.NodeID = v
			if !keyExplicit {
				n.Tunnel.ClientKey = v
			}
		case "tags":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			for tk, tv := range ParseTagsCSV(v) {
				n.Tags[tk] = tv
			}
		case "no-log":
			n.NoLogFile = parseBoolVal(hasVal, val)
		case "debug":
			n.Debug = parseBoolVal(hasVal, val)
		case "daemon", "d":
			n.Daemon = parseBoolVal(hasVal, val)
		case "service-name":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.ServiceName = v

		// ProxyForge Tunnel flags
		case "pf-bridge", "P":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.BridgeAddr = v
		case "pf-mode":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.Mode = strings.ToLower(strings.TrimSpace(v))
		case "pf-key", "k":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.ClientKey = v
			keyExplicit = true
		case "pf-proto", "T":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.Proto = strings.ToLower(strings.TrimSpace(v))
		case "pf-sessions":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if sc, err := strconv.Atoi(v); err == nil && sc > 0 {
				n.Tunnel.SessionCount = sc
			}
		case "pf-p2p", "p2p":
			n.Tunnel.EnableP2P = parseBoolVal(hasVal, val)
		case "pf-cert", "C":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.CertFile = v
		case "pf-key-file", "K":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.KeyFile = v
		case "pf-ca", "ca-bundle":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.CABundle = v
		case "pf-tls-pin", "tls-pin":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.TLSPin = v
		case "pf-single-tls", "single-tls":
			n.Tunnel.SingleTLS = parseBoolVal(hasVal, val)
		case "pf-ws-path":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.WSPath = v
		case "pf-pass", "Z":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.Password = v
		case "pf-compress", "M":
			n.Tunnel.Compress = parseBoolVal(hasVal, val)
		case "pf-kcp-method":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.KCPMethod = v
		case "pf-kcp-key":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.KCPKey = v
		case "pf-kcp-mode":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.KCPMode = v
		case "pf-kcp-mtu":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if nVal, err := strconv.Atoi(v); err == nil && nVal > 0 {
				n.Tunnel.KCPMTU = nVal
			}
		case "pf-kcp-sndwnd":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if nVal, err := strconv.Atoi(v); err == nil && nVal > 0 {
				n.Tunnel.KCPSndWnd = nVal
			}
		case "pf-kcp-rcvwnd":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if nVal, err := strconv.Atoi(v); err == nil && nVal > 0 {
				n.Tunnel.KCPRcvWnd = nVal
			}
		case "pf-kcp-datashard":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if nVal, err := strconv.Atoi(v); err == nil && nVal >= 0 {
				n.Tunnel.KCPDataShard = nVal
			}
		case "pf-kcp-parityshard":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if nVal, err := strconv.Atoi(v); err == nil && nVal >= 0 {
				n.Tunnel.KCPParityShard = nVal
			}
		case "pf-kcp-nocomp":
			n.Tunnel.KCPNoComp = parseBoolVal(hasVal, val)
		case "pf-hub":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.HubAddr = v
		case "pf-hub-key":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.HubSecret = v
		case "pf-hub-pin":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.HubPin = v
		case "pf-hub-ca":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.Tunnel.HubCA = v
		case "webrtc-stun":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.WebRTC.STUNServers = splitCSV(v)
		case "webrtc-turn":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.WebRTC.TURNServers = append(n.WebRTC.TURNServers, splitCSV(v)...)
		case "webrtc-fps":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if fps, err := strconv.Atoi(v); err == nil && fps >= 5 && fps <= 60 {
				n.WebRTC.FPS = fps
			}
		case "webrtc-encoder":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.WebRTC.Encoder = strings.ToLower(strings.TrimSpace(v))
		case "ffmpeg-path":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			n.WebRTC.FFmpegPath = v
		default:
			return fmt.Errorf("unknown node flag %q", arg)
		}
	}

	// Security-by-default: shrink local bind address to 127.0.0.1 when tunnel mode is active
	if n.Tunnel.BridgeAddr != "" && !n.HostExplicit {
		n.Host = "127.0.0.1"
	}
	return nil
}

func parsePoolFlags(cmd *Command, args []string) error {
	p := &cmd.Pool
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-h" || arg == "--help" {
			cmd.Subcommand = "help"
			return nil
		}
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name, val, hasVal := splitFlag(arg)
		switch name {
		case "host":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.Host = v
		case "port", "p":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			port, err := strconv.Atoi(v)
			if err != nil || port < 0 || port > 65535 {
				return fmt.Errorf("invalid --port %q", v)
			}
			p.Port = port
		case "token":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.Token = v
		case "strict-auth":
			p.StrictAuth = parseBoolVal(hasVal, val)
		case "queue-timeout":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if d, err := time.ParseDuration(v); err == nil && d >= 0 {
				p.QueueTimeout = d
			}
		case "probe-interval":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if d, err := time.ParseDuration(v); err == nil && d > 0 {
				p.ProbeEvery = d
			}
		case "backends", "backend":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			for _, item := range strings.Split(v, ",") {
				item = strings.TrimSpace(item)
				if item != "" {
					p.Backends = append(p.Backends, item)
				}
			}
		case "data-dir":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.DataDir = v
		case "no-log":
			p.NoLogFile = parseBoolVal(hasVal, val)
		case "debug":
			p.Debug = parseBoolVal(hasVal, val)
		case "daemon", "d":
			p.Daemon = parseBoolVal(hasVal, val)
		case "service-name":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.ServiceName = v
		case "pf-listen":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFListen = v
		case "pf-proto":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFProto = strings.ToLower(strings.TrimSpace(v))
		case "pf-cert", "C":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFCertFile = v
		case "pf-key-file", "K":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFKeyFile = v
		case "pf-single-tls", "single-tls":
			p.PFSingleTLS = parseBoolVal(hasVal, val)
		case "pf-client-keys", "client-keys":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFClientKeys = v
		case "pf-pass", "z":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.PFPassword = v
		case "pf-compress", "m":
			p.PFCompress = parseBoolVal(hasVal, val)
		case "pf-p2p", "p2p":
			p.PFEnableP2P = parseBoolVal(hasVal, val)
		case "webrtc-stun":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.WebRTC.STUNServers = splitCSV(v)
		case "webrtc-turn":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.WebRTC.TURNServers = append(p.WebRTC.TURNServers, splitCSV(v)...)
		case "webrtc-turn-listen":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.WebRTC.TURNListen = v
		case "webrtc-public-ip":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.WebRTC.TURNPublicIP = v
		case "webrtc-turn-secret":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			p.WebRTC.TURNSecret = v
		default:
			return fmt.Errorf("unknown pool flag %q", arg)
		}
	}
	if len(p.Backends) == 0 && p.PFListen == "" {
		return errors.New("pool mode requires --pf-listen=<addr> and/or --backends=<list>")
	}
	return nil
}

func parseKeygenFlags(cmd *Command, args []string) error {
	kg := &cmd.Keygen
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-h" || arg == "--help" {
			cmd.Subcommand = "help"
			return nil
		}
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name, val, hasVal := splitFlag(arg)
		switch name {
		case "s", "sign", "leaf":
			if parseBoolVal(hasVal, val) {
				kg.Mode = "leaf"
			}
		case "d", "domain":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			kg.Domain = v
		case "days":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if d, err := strconv.Atoi(v); err == nil && d > 0 {
				kg.ValidDays = d
			}
		case "out", "c":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			kg.OutPrefix = v
		case "C", "ca":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			if kg.Mode == "leaf" {
				kg.CACert = v + ".crt"
				kg.CAKey = v + ".key"
			} else {
				kg.OutPrefix = v
			}
		case "ca-cert":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			kg.CACert = v
			kg.Mode = "leaf"
		case "ca-key":
			v, err := nextVal(args, &i, val, hasVal)
			if err != nil {
				return err
			}
			kg.CAKey = v
			kg.Mode = "leaf"
		case "json":
			kg.JSONOut = parseBoolVal(hasVal, val)
		default:
			return fmt.Errorf("unknown keygen flag %q", arg)
		}
	}
	return nil
}

var pathBearingFlags = map[string]bool{
	"data-dir":    true,
	"chrome-path": true,
	"pf-cert":     true,
	"C":           true,
	"pf-key-file": true,
	"K":           true,
	"pf-ca":       true,
	"ca-bundle":   true,
	"pf-hub-ca":   true,
}

func resolveServicePathValue(v string) string {
	s := strings.TrimSpace(v)
	if s == "" || s == "default" || strings.Contains(s, "://") {
		return s
	}
	if abs, err := filepath.Abs(s); err == nil {
		return abs
	}
	return s
}

// NormalizeServiceArgs resolves relative file/directory flags to absolute paths so Windows SCM (cwd=System32) finds certs and data dirs.
func NormalizeServiceArgs(rawArgs []string) []string {
	out := make([]string, 0, len(rawArgs))
	for i := 0; i < len(rawArgs); i++ {
		arg := rawArgs[i]
		if !strings.HasPrefix(arg, "-") {
			out = append(out, arg)
			continue
		}
		name, val, hasVal := splitFlag(arg)
		if name == "daemon" || name == "d" {
			continue
		}
		if pathBearingFlags[name] {
			if hasVal {
				prefix := "--"
				if !strings.HasPrefix(arg, "--") {
					prefix = "-"
				}
				out = append(out, prefix+name+"="+resolveServicePathValue(val))
				continue
			}
			if i+1 < len(rawArgs) {
				out = append(out, arg, resolveServicePathValue(rawArgs[i+1]))
				i++
				continue
			}
		}
		out = append(out, arg)
	}
	if len(out) == 0 || strings.HasPrefix(out[0], "-") {
		out = append([]string{"node"}, out...)
	}
	return out
}

func parseServiceFlags(cmd *Command, args []string) error {
	sc := &cmd.Service
	if sc.Action == "" {
		return errors.New("service command requires an action: install, uninstall, start, stop, or status")
	}

	var passthrough []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "-h" || arg == "--help" {
			cmd.Subcommand = "help"
			return nil
		}
		if strings.HasPrefix(arg, "-") {
			name, val, hasVal := splitFlag(arg)
			switch name {
			case "n", "name", "service-name":
				v, err := nextVal(args, &i, val, hasVal)
				if err != nil {
					return err
				}
				sc.Name = v
				continue
			case "display-name":
				v, err := nextVal(args, &i, val, hasVal)
				if err != nil {
					return err
				}
				sc.DisplayName = v
				continue
			case "json":
				sc.JSONOut = parseBoolVal(hasVal, val)
				continue
			}
		}
		passthrough = append(passthrough, arg)
	}

	if sc.Action == "install" {
		norm := NormalizeServiceArgs(passthrough)
		norm = append(norm, "--service-name="+sc.Name)
		// Validate target node/pool flags upfront before touching Windows SCM
		validated, err := ParseCLI(norm)
		if err != nil {
			return fmt.Errorf("invalid service runtime arguments: %w", err)
		}
		if validated.Subcommand == "pool" && sc.DisplayName == "Browser-Go CDP Service" {
			sc.DisplayName = "Browser-Go CDP Pool Gateway"
		}
		sc.ServiceArgs = norm
	}
	return nil
}
