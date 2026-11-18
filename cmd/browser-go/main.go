package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	browsergo "browser-go"
	"browser-go/internal/chrome"
	"browser-go/internal/config"
	"browser-go/internal/logger"
	"browser-go/internal/pool"
	"browser-go/internal/server"
	"browser-go/pkg/pftunnel"
)

func main() {
	cmd, err := config.ParseCLI(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\nRun 'browser-go --help' for usage.\n", err)
		os.Exit(2)
	}

	switch cmd.Subcommand {
	case "help":
		printHelp()
		return
	case "version":
		fmt.Printf("browser-go v%s\n", browsergo.AppVersion)
		return
	case "keygen":
		if err := runKeygen(cmd.Keygen); err != nil {
			fmt.Fprintf(os.Stderr, "keygen failed: %v\n", err)
			os.Exit(1)
		}
		return
	case "pool":
		if err := runPool(cmd.Pool); err != nil {
			fmt.Fprintf(os.Stderr, "pool failed: %v\n", err)
			os.Exit(1)
		}
		return
	default: // "node"
		if err := runNode(cmd.Node); err != nil {
			fmt.Fprintf(os.Stderr, "node failed: %v\n", err)
			os.Exit(1)
		}
	}
}

func runNode(cfg config.NodeConfig) error {
	log, _ := logger.New(cfg.NodeID, cfg.DataDir, cfg.Debug, cfg.NoLogFile, true)
	defer log.Close()
	logger.SetDefault(log)

	chromeMgr := chrome.NewManager(chrome.ManagerConfig{
		MaxInstances:          cfg.MaxInstances,
		InstanceTimeout:       cfg.InstanceTimeout,
		InactiveCheckInterval: cfg.InactiveCheckInterval,
		ChromePath:            cfg.ChromePath,
		DefaultHeadless:       cfg.Headless,
		DataDir:               cfg.DataDir,
		Logger:                log,
	})

	srv := server.NewNodeServer(cfg, log, chromeMgr)
	if err := srv.Start(); err != nil {
		chromeMgr.Shutdown()
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var tunCli *pftunnel.Client
	if cfg.Tunnel.BridgeAddr != "" {
		defPort := srv.BoundPort()
		if defPort <= 0 {
			defPort = 3000
		}
		var err error
		tunCli, err = pftunnel.NewClient(pftunnel.ClientConfig{
			BridgeAddr:   cfg.Tunnel.BridgeAddr,
			Mode:         cfg.Tunnel.Mode,
			ClientKey:    cfg.Tunnel.ClientKey,
			Proto:        cfg.Tunnel.Proto,
			SessionCount: cfg.Tunnel.SessionCount,
			EnableP2P:    cfg.Tunnel.EnableP2P,
			NodeTags:     cfg.Tags,
			Transport: pftunnel.TransportOptions{
				CertSpec:       cfg.Tunnel.CertFile,
				KeySpec:        cfg.Tunnel.KeyFile,
				CABundleSpec:   cfg.Tunnel.CABundle,
				TLSPinSHA256:   cfg.Tunnel.TLSPin,
				SingleTLS:      cfg.Tunnel.SingleTLS,
				WSPath:         cfg.Tunnel.WSPath,
				CustomPassword: cfg.Tunnel.Password,
				Compress:       cfg.Tunnel.Compress,
				Timeout:        cfg.Tunnel.Timeout,
				KCP: pftunnel.KCPConfig{
					Method:      cfg.Tunnel.KCPMethod,
					Key:         cfg.Tunnel.KCPKey,
					Mode:        cfg.Tunnel.KCPMode,
					MTU:         cfg.Tunnel.KCPMTU,
					SndWnd:      cfg.Tunnel.KCPSndWnd,
					RcvWnd:      cfg.Tunnel.KCPRcvWnd,
					DataShard:   cfg.Tunnel.KCPDataShard,
					ParityShard: cfg.Tunnel.KCPParityShard,
					NoComp:      cfg.Tunnel.KCPNoComp,
				},
			},
			Logger:            log,
			DefaultTargetAddr: "127.0.0.1:" + strconv.Itoa(defPort),
			InProcessDial:     srv.DialInProcess,
		})
		if err != nil {
			_ = srv.Shutdown(context.Background())
			return err
		}
		tunCli.Start()
	}

	if cfg.Tunnel.HubAddr != "" && cfg.Tunnel.HubSecret != "" {
		pftunnel.StartClusterHubReporter(
			ctx,
			cfg.Tunnel.HubAddr,
			cfg.Tunnel.HubSecret,
			cfg.NodeID,
			cfg.Tunnel.HubCA,
			cfg.Tunnel.HubPin,
			browsergo.AppVersion,
			log,
			func() (int, int64, int64, int) {
				act := int(srv.ActiveWSConns.Load())
				var bIn, bOut int64
				if tunCli != nil {
					act += int(tunCli.ActiveStreams.Load())
					bIn = tunCli.BytesIn.Load()
					bOut = tunCli.BytesOut.Load()
				}
				st := chromeMgr.Stats()
				return act, bIn, bOut, st.CurrentInstances
			},
		)
	}

	log.Infof("Browser-Go service started (max_instances=%d, timeout=%s, tunnel=%q)",
		cfg.MaxInstances, cfg.InstanceTimeout, cfg.Tunnel.BridgeAddr)

	waitForShutdownSignal(log)

	cancel()
	if tunCli != nil {
		tunCli.Stop()
	}
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	return srv.Shutdown(shutCtx)
}

func runPool(cfg config.PoolConfig) error {
	log, _ := logger.New("pool", cfg.DataDir, cfg.Debug, cfg.NoLogFile, true)
	defer log.Close()
	logger.SetDefault(log)

	gw, err := pool.NewGateway(cfg, log)
	if err != nil {
		return err
	}
	if err := gw.Start(); err != nil {
		return err
	}

	waitForShutdownSignal(log)

	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	return gw.Shutdown(shutCtx)
}

func runKeygen(cfg config.KeygenConfig) error {
	var certPEM, keyPEM []byte
	var err error
	if cfg.Mode == "leaf" {
		caCert, rErr := os.ReadFile(cfg.CACert)
		if rErr != nil {
			return fmt.Errorf("read CA cert %q: %w", cfg.CACert, rErr)
		}
		caKey, kErr := os.ReadFile(cfg.CAKey)
		if kErr != nil {
			return fmt.Errorf("read CA key %q: %w", cfg.CAKey, kErr)
		}
		certPEM, keyPEM, err = pftunnel.SignLeafPEM(caCert, caKey, cfg.Domain, cfg.ValidDays)
	} else {
		certPEM, keyPEM, err = pftunnel.GenerateSelfSignedCAPEM(cfg.Domain, cfg.ValidDays)
	}
	if err != nil {
		return err
	}
	crtFile := cfg.OutPrefix + ".crt"
	keyFile := cfg.OutPrefix + ".key"
	if err := os.WriteFile(crtFile, certPEM, 0644); err != nil {
		return err
	}
	if err := os.WriteFile(keyFile, keyPEM, 0600); err != nil {
		return err
	}
	var fp string
	if blk, _ := pem.Decode(certPEM); blk != nil {
		fp = pftunnel.CertFingerprintSHA256(blk.Bytes)
	}
	if cfg.JSONOut {
		out, _ := json.MarshalIndent(map[string]any{
			"mode":              cfg.Mode,
			"certFile":          crtFile,
			"keyFile":           keyFile,
			"domain":            cfg.Domain,
			"sha256Fingerprint": fp,
		}, "", "  ")
		fmt.Println(string(out))
	} else {
		fmt.Printf("Generated %s certificate: %s, %s\nSHA-256 Fingerprint: %s\n", cfg.Mode, crtFile, keyFile, fp)
	}
	return nil
}

func waitForShutdownSignal(log *logger.Logger) {
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	log.Infof("Received signal %v, shutting down gracefully...", sig)
}

func printHelp() {
	fmt.Printf(`Browser-Go v%s — High-Stability CDP Browser Service, Intranet Tunnel & Pool Gateway

Usage:
  browser-go [node] [options]      Start a Browser-Go worker node (default mode, CLI-compatible)
  browser-go pool [options]        Start a multi-node CDP Browser Pool Scheduler & Bridge Gateway
  browser-go keygen [options]      Generate ProxyForge-compatible mTLS Root CA / Leaf certificates
  browser-go version               Print version

Worker Node Options:
  --host=<ip>                      Listen IP (default: 0.0.0.0, or 127.0.0.1 when --pf-bridge is set)
  --port=<num>                     Listen port (default: 3000; set 0 for pure tunnel-only mode)
  --max-instances=<num>            Maximum concurrent Chrome instances (default: 10)
  --instance-timeout=<minutes>     Idle persistent instance timeout in minutes (default: 60)
  --inactive-check-interval=<min>  Idle cleanup check interval in minutes (default: 5)
  --token=<str>                    Access token (default: browser-go-token)
  --strict-auth                    Enforce token on loopback management/extension endpoints too
  --chrome-path=<path>             Explicit Chrome / Chromium / Edge / Brave executable path
  --headless                       Launch browsers in --headless=new mode by default
  --cdp-logging                    Enable detailed CDP relay frame logging
  --node-id=<id>                   Unique node identifier
  --tags=<k=v,k2=v2>               Node routing tags (e.g. region=shanghai,isp=telecom)

Built-in ProxyForge Intranet Penetration Options (100%% wire-compatible with proxyforge):
  --pf-bridge=<host:port>          Connect outbound to ProxyForge bridge/tbridge or browser-go pool
  --pf-key=<client_key>            Tunnel client_key (default: hostname / --node-id)
  --pf-mode=<mux|multi>            Tunnel mode: mux (bridge) or multi (tbridge) (default: mux)
  --pf-proto=<tls|tcp|ws|wss|kcp>  Tunnel transport protocol (default: tls)
  --pf-sessions=<num>              Parallel mux sessions to prevent HoL blocking (default: 2)
  --pf-p2p                         Enable UDP STUN + NAT hole-punching KCP direct stream
  --pf-cert=<crt> --pf-key-file=<k> Client mTLS certificate and private key
  --pf-ca=<ca.crt>                 Verify bridge server certificate against Root CA
  --pf-tls-pin=<sha256>            Pin bridge TLS certificate SHA-256 fingerprint
  --pf-single-tls                  Use one-way server TLS (when mTLS client cert is not required)
  --pf-pass=<secret>               Enable ProxyForge -Z AES-256-GCM stream encryption
  --pf-compress                    Enable ProxyForge -M Flate stream compression
  --pf-hub=<host:55333>            Optional ProxyForge Admin Cluster Hub address
  --pf-hub-key=<secret>            Cluster Hub HMAC secret key (--pf-hub-pin=<sha256> optional)

Pool Gateway Options (browser-go pool):
  --port=<num>                     Public CDP Pool HTTP/WS port (default: 3000)
  --token=<str>                    Pool & backend access token (default: browser-go-token)
  --pf-listen=<addr>               Start built-in ProxyForge Bridge listener (e.g. :33080)
  --pf-client-keys=<k1,k2>         Whitelist of allowed intranet node client_keys
  --backends=<spec1,spec2>         Static ProxyForge server backends (e.g. n1=http://127.0.0.1:13001#isp=ct)
  --queue-timeout=<dur>            Wait queue timeout when all slots are full (default: 20s)
`, browsergo.AppVersion)
}
