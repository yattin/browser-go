# CLAUDE.md (Golang Edition v2.0)

This document guides development, building, and testing in the `browser-go` repository.

## Architecture Overview

`browser-go` is implemented as a native zero-dependency Golang single binary (the legacy Node.js/TypeScript implementation is archived under `legacy-ts/`):

1. **`cmd/browser-go/main.go`**: Unified CLI entrypoint supporting `node` (default worker node), `pool` (distributed CDP browser pool gateway), `keygen` (mTLS CA/leaf certificate issuer), and `version`.
2. **`internal/config`**: CLI flag parser with security-by-default rules (auto-binding `127.0.0.1` when `--pf-bridge` tunnel mode is enabled, and supporting `--port=0` pure in-memory stealth tunnel mode).
3. **`internal/chrome`**: Cross-platform Chrome/Chromium/Edge/Brave discovery, OS kernel process-tree isolation (Windows Job Objects `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and Unix process groups `-pgid`), atomic slot reservation, per-`user` concurrent launch coalescing, and automatic ephemeral/idle cleanup.
4. **`internal/wsutil`**: RFC 6455 message-level WebSocket codec (up to 64MB fragmented frames) and zero-copy `ProxyRawWebSocket` stream passthrough.
5. **`internal/cdpbridge`**: Multi-device concurrency-safe Chrome Extension CDP relay (isolated per-socket sessions, monotonic request sequence remapping, and `deviceId`-scoped event routing).
6. **`internal/server`**: Worker node HTTP/WebSocket server, embedded OpenAPI 3.0.3 (`/openapi.json` & `/api-docs`), standard `/json/version` discovery, and in-process pipe listener.
7. **`pkg/pftunnel`**: Wire-compatible `ProxyForge` intranet penetration protocol stack (9-byte `MuxSession`, `tclient` multi-link workers, strict mTLS + `--pf-tls-pin`, `-Z` AES-256-GCM, `-M` Flate, `xtaci/kcp-go/v5` KCP+FEC, `--pf-p2p` STUN + UDP hole punching, `EmbeddedBridge`, and `:55333` Cluster Hub telemetry).
8. **`internal/pool`**: Multi-node CDP Browser Pool Scheduler supporting both static `--backends` and built-in `--pf-listen` auto-registration, least-loaded slot balancing, `launch.user` sticky affinity, tag filtering, and burst queueing.

## Build & Test Commands

- **Build binary & run full unit + cross-process E2E test suite (Windows PowerShell)**:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -SelfTest
  ```
- **Run targeted package tests**:
  ```bash
  go test -v ./internal/chrome ./internal/cdpbridge ./internal/pool ./pkg/pftunnel
  ```
