package config

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestServiceInstallPathNormalizationAndValidation(t *testing.T) {
	cmd, err := ParseCLI([]string{
		"install", "-n", "BrowserGoWorker1",
		"node",
		"--port=0",
		"--pf-bridge=pool.example.com:33080",
		"--pf-cert=certs/cli.crt",
		"-K", "certs/cli.key",
		"--pf-ca=certs/ca.crt",
		"--data-dir=./runtime-data",
	})
	if err != nil {
		t.Fatalf("ParseCLI service install failed: %v", err)
	}
	if cmd.Subcommand != "service" || cmd.Service.Action != "install" || cmd.Service.Name != "BrowserGoWorker1" {
		t.Fatalf("unexpected service command: %+v", cmd.Service)
	}

	joined := strings.Join(cmd.Service.ServiceArgs, " ")
	for _, rel := range []string{"certs/cli.crt", "certs/cli.key", "certs/ca.crt", "./runtime-data"} {
		abs, _ := filepath.Abs(rel)
		if !strings.Contains(joined, abs) {
			t.Fatalf("expected relative path %q to be normalized to %q in %v", rel, abs, cmd.Service.ServiceArgs)
		}
	}

	// Invalid target flag must fail validation before SCM install is attempted
	if _, badErr := ParseCLI([]string{"install", "node", "--nonexistent-flag=1"}); badErr == nil {
		t.Fatalf("expected invalid runtime flag to fail pre-install validation")
	}
}

func TestSecurityByDefaultLoopbackWhenTunnelEnabled(t *testing.T) {
	cmd, err := ParseCLI([]string{"--pf-bridge=1.2.3.4:33080", "--pf-key=n1"})
	if err != nil {
		t.Fatalf("ParseCLI failed: %v", err)
	}
	if cmd.Node.Host != "127.0.0.1" {
		t.Fatalf("expected Host auto-shrunk to 127.0.0.1 when --pf-bridge set, got %s", cmd.Node.Host)
	}
}
