package pftunnel

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/pem"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestMuxLargePayloadAndMTLSWithPinning(t *testing.T) {
	tmp := t.TempDir()

	caCert, caKey, err := GenerateSelfSignedCAPEM("test-ca.local", 30)
	if err != nil {
		t.Fatalf("generate CA: %v", err)
	}
	srvCert, srvKey, err := SignLeafPEM(caCert, caKey, "127.0.0.1", 30)
	if err != nil {
		t.Fatalf("sign server leaf: %v", err)
	}
	cliCert, cliKey, err := SignLeafPEM(caCert, caKey, "node-1.local", 30)
	if err != nil {
		t.Fatalf("sign client leaf: %v", err)
	}

	caPath := filepath.Join(tmp, "ca.crt")
	srvCrtPath := filepath.Join(tmp, "srv.crt")
	srvKeyPath := filepath.Join(tmp, "srv.key")
	cliCrtPath := filepath.Join(tmp, "cli.crt")
	cliKeyPath := filepath.Join(tmp, "cli.key")

	_ = os.WriteFile(caPath, caCert, 0644)
	_ = os.WriteFile(srvCrtPath, srvCert, 0644)
	_ = os.WriteFile(srvKeyPath, srvKey, 0600)
	_ = os.WriteFile(cliCrtPath, cliCert, 0644)
	_ = os.WriteFile(cliKeyPath, cliKey, 0600)

	blk, _ := pem.Decode(srvCert)
	srvPin := CertFingerprintSHA256(blk.Bytes)

	// Start EmbeddedBridge with strict mTLS (ServerTLSConfig uses caCert+srvCert bundle so ClientCAs trusts CA)
	srvBundlePath := filepath.Join(tmp, "srv-bundle.crt")
	_ = os.WriteFile(srvBundlePath, append(srvCert, caCert...), 0644)

	joined := make(chan string, 1)
	eb := NewEmbeddedBridge(EmbeddedBridgeConfig{
		ListenAddr: "127.0.0.1:0",
		Proto:      "tls",
		AllowedKey: []string{"node-mtls"},
		Transport: TransportOptions{
			CertSpec:       srvBundlePath,
			KeySpec:        srvKeyPath,
			SingleTLS:      false, // strict mutual TLS!
			CustomPassword: "z-pass-test",
			Compress:       true,
		},
		OnNodeJoin: func(clientKey string, _ map[string]string) {
			select {
			case joined <- clientKey:
			default:
			}
		},
	})
	if err := eb.Start(); err != nil {
		t.Fatalf("start embedded bridge: %v", err)
	}
	defer eb.Stop()

	// Negative test: wrong TLS pin must be rejected!
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, badErr := Dial(ctx, "tls", eb.Addr(), TransportOptions{
		CertSpec:     cliCrtPath,
		KeySpec:      cliKeyPath,
		CABundleSpec: caPath,
		TLSPinSHA256: "0000000000000000000000000000000000000000000000000000000000000000",
	})
	if badErr == nil {
		t.Fatalf("expected TLS pin mismatch to fail dial")
	}

	// Start echo target via InProcessDial and connect Client over mTLS + AES-256-GCM + Flate
	bigPayload := make([]byte, 512*1024) // 512KB simulated CDP screenshot frame
	_, _ = rand.Read(bigPayload)

	cli, err := NewClient(ClientConfig{
		BridgeAddr:        eb.Addr(),
		Mode:              "mux",
		ClientKey:         "node-mtls",
		Proto:             "tls",
		SessionCount:      2,
		DefaultTargetAddr: "127.0.0.1:3000",
		Transport: TransportOptions{
			CertSpec:       cliCrtPath,
			KeySpec:        cliKeyPath,
			CABundleSpec:   caPath,
			TLSPinSHA256:   srvPin,
			CustomPassword: "z-pass-test",
			Compress:       true,
		},
		InProcessDial: func() (net.Conn, error) {
			c1, c2 := net.Pipe()
			go func() {
				defer c1.Close()
				_, _ = io.Copy(c1, c1)
			}()
			return c2, nil
		},
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	cli.Start()
	defer cli.Stop()

	select {
	case k := <-joined:
		if k != "node-mtls" {
			t.Fatalf("unexpected key %s", k)
		}
	case <-time.After(4 * time.Second):
		t.Fatalf("timed out waiting for mTLS tunnel client to join bridge")
	}

	stream, err := eb.DialNode(ctx, "node-mtls", "127.0.0.1:3000")
	if err != nil {
		t.Fatalf("DialNode failed: %v", err)
	}
	defer stream.Close()

	go func() {
		_, _ = stream.Write(bigPayload)
	}()

	got := make([]byte, len(bigPayload))
	if _, err := io.ReadFull(stream, got); err != nil {
		t.Fatalf("read echoed 512KB payload: %v", err)
	}
	if !bytes.Equal(got, bigPayload) {
		t.Fatalf("echoed 512KB payload corrupted across mTLS+Z+Flate+Mux stream")
	}
}

func TestKCPTransportTunnel(t *testing.T) {
	joined := make(chan string, 1)
	eb := NewEmbeddedBridge(EmbeddedBridgeConfig{
		ListenAddr: "127.0.0.1:0",
		Proto:      "kcp",
		Transport: TransportOptions{
			KCP: KCPConfig{Method: "aes", Key: "kcp-test-secret", Mode: "fast2"},
		},
		OnNodeJoin: func(k string, _ map[string]string) {
			select {
			case joined <- k:
			default:
			}
		},
	})
	if err := eb.Start(); err != nil {
		t.Fatalf("start KCP bridge: %v", err)
	}
	defer eb.Stop()

	cli, err := NewClient(ClientConfig{
		BridgeAddr:        eb.Addr(),
		Mode:              "mux",
		ClientKey:         "node-kcp",
		Proto:             "kcp",
		SessionCount:      1,
		DefaultTargetAddr: "127.0.0.1:3000",
		Transport: TransportOptions{
			KCP: KCPConfig{Method: "aes", Key: "kcp-test-secret", Mode: "fast2"},
		},
		InProcessDial: func() (net.Conn, error) {
			c1, c2 := net.Pipe()
			go func() {
				defer c1.Close()
				_, _ = c1.Write([]byte("HELLO-OVER-KCP-FEC"))
			}()
			return c2, nil
		},
	})
	if err != nil {
		t.Fatalf("new KCP client: %v", err)
	}
	cli.Start()
	defer cli.Stop()

	select {
	case <-joined:
	case <-time.After(4 * time.Second):
		t.Fatalf("KCP client failed to register")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	st, err := eb.DialNode(ctx, "node-kcp", "127.0.0.1:3000")
	if err != nil {
		t.Fatalf("DialNode over KCP: %v", err)
	}
	defer st.Close()
	data, err := io.ReadAll(st)
	if err != nil || string(data) != "HELLO-OVER-KCP-FEC" {
		t.Fatalf("unexpected KCP payload: %q (err=%v)", string(data), err)
	}
}
