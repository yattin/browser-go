# Browser-Go (Golang Edition v2.0)

Browser-Go is a zero-dependency, high-stability **Chrome DevTools Protocol (CDP)** browser instance manager and **distributed intranet-penetrated CDP Browser Pool Gateway**, natively rewritten in **Golang** with built-in wire-compatible **ProxyForge** tunnel protocols (`bridge`/`tbridge`/mTLS/`KCP+FEC`/`--pf-p2p` UDP NAT hole-punching & Cluster Hub telemetry).

[中文文档](README.zh-CN.md) | Legacy TypeScript Archive: [`legacy-ts/`](./legacy-ts)

---

## Key Features

- **Dual-Role Single Binary (~10 MB)**:
  - `browser-go [node]`: Worker node managing local Chrome/Chromium/Edge/Brave instances and extension relays (100% backward-compatible CLI flags, WebSocket URLs, and OpenAPI REST routes);
  - `browser-go pool`: Central multi-node CDP Browser Pool Scheduler & ProxyForge Bridge Gateway (least-loaded slot scheduling, `launch.user` sticky profile routing, region/ISP tag filtering, and burst wait queue).
- **OS Kernel Process-Tree Isolation**:
  - Uses Windows **Job Objects** (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) and Unix Process Groups (`-pgid`), guaranteeing zero orphaned `chrome.exe` processes even on abnormal termination.
- **Zero-Leak Concurrency & Fast DevTools Readiness**:
  - Atomic slot reservation, per-`user` concurrent launch coalescing (`SingletonLock` protection), immediate teardown of ephemeral anonymous sessions on disconnect, and `60ms` DevTools polling.
- **Built-in Wire-Compatible `ProxyForge` Tunnel Stack (`pkg/pftunnel`)**:
  - Connects directly to vanilla `proxyforge bridge` / `tbridge` or `browser-go pool --pf-listen` with zero extra sidecars;
  - Supports strict mutual TLS (mTLS), `--pf-tls-pin` SHA-256 certificate pinning, `-Z` AES-256-GCM encryption, `-M` Flate compression, `xtaci/kcp-go/v5` Reed-Solomon FEC, `--pf-p2p` direct UDP hole punching, and `--pf-hub` telemetry reporting to `ProxyForge Admin (:55333)`.
- **Concurrency-Safe Chrome Extension Relay (`/extension` + `/cdp`)**:
  - Per-socket extension isolation, monotonic request ID remapping, and strict `deviceId`-scoped event delivery.

---

## Quick Build & Self-Test

```powershell
# Windows PowerShell build + full unit/integration test suite
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -SelfTest

# Standard Go build
go build -trimpath -ldflags="-s -w" -o bin/browser-go ./cmd/browser-go
```

---

## Usage Examples

### 1. Standalone Browser Node
```bash
./bin/browser-go --port=3000 --max-instances=10 --token=my-secret --headless
```

### 2. Distributed Intranet-Penetrated CDP Browser Pool
```bash
# Public Cloud: Start Pool Gateway with built-in ProxyForge Bridge
./bin/browser-go pool --port=3000 --token=pool-secret --pf-listen=:33080 --pf-cert=ca.crt --pf-key-file=ca.key

# Intranet Hosts: Start stealth worker nodes (--port=0 opens zero local ports!)
./bin/browser-go node --port=0 --max-instances=8 --token=pool-secret \
  --pf-bridge=pool.example.com:33080 --pf-key=office-node-1 \
  --pf-cert=cli.crt --pf-key-file=cli.key --pf-ca=ca.crt --tags="region=shanghai,isp=telecom"
```

### 3. Direct Interoperability with `ProxyForge`
```bash
proxyforge bridge -p :33080 -C ca.crt -K ca.key --client-keys node-01
proxyforge server -P 127.0.0.1:33080 -C srv.crt -K srv.key --ca-bundle ca.crt -r 127.0.0.1:13001@[node-01]127.0.0.1:3000

./bin/browser-go node --port=0 --token=my-secret \
  --pf-bridge=127.0.0.1:33080 --pf-key=node-01 \
  --pf-cert=cli.crt --pf-key-file=cli.key --pf-ca=ca.crt --pf-p2p
```

### 4. Web Dashboard (`/dashboard`), Background `--daemon`, and Windows SCM Service
- Open `http://<pool-or-node>:3000/dashboard` for real-time node slot matrix, active instance eviction, and interactive Playwright code generation.
- Run `--daemon` to detach into background, or manage native Windows services (`browser-go install | uninstall | start | stop | status --json`).
