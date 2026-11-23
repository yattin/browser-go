# Browser-Go CLI, REST API & MCP Reference

## 1. CLI Subcommands & Key Flags

| Subcommand | Purpose |
| --- | --- |
| `browser-go [node]` | Start a worker node (CDP proxy, `/dashboard`, WebRTC Live View, extension bridge) |
| `browser-go pool` | Start a multi-node CDP Pool Gateway with built-in ProxyForge Bridge & TURN relay |
| `browser-go mcp` | Start a pure-Go stdio MCP server backed by a Browser-Go node or pool |
| `browser-go keygen` | Generate ProxyForge-compatible mTLS Root CA & leaf certificates |
| `browser-go install / uninstall / start / stop / status` | Manage native Windows SCM service (`--json` supported) |
| `browser-go version` | Print binary version |

### Worker Node Flags (`browser-go node`)

- `--host=<ip>` (default `0.0.0.0`, or `127.0.0.1` when `--pf-bridge` is set)
- `--port=<num>` (default `3000`; `0` = stealth tunnel-only mode)
- `--max-instances=<num>` (default `10`)
- `--instance-timeout=<minutes>` (default `60`)
- `--token=<str>` / `--strict-auth`
- `--chrome-path=<path>` / `--headless`
- `--qinghu` / `--qinghu-data-dir=<dir>` (Qinghu Anti-Detect Fingerprint Browser integration)
- `--node-id=<id>` / `--tags=<k=v,k2=v2>` / `--daemon` / `--cdp-logging`

### Built-In ProxyForge Tunnel Flags (`node` & `pool`)

- Node outbound: `--pf-bridge=<host:port>`, `--pf-key=<client_key>`, `--pf-mode=<mux|multi>`, `--pf-proto=<tls|tcp|ws|wss|kcp>`, `--pf-sessions=<num>`, `--pf-p2p`
- TLS & encryption: `--pf-cert=<crt>`, `--pf-key-file=<key>`, `--pf-ca=<ca.crt>`, `--pf-tls-pin=<sha256>`, `--pf-single-tls`, `--pf-pass=<secret>`, `--pf-compress`
- Cluster Hub: `--pf-hub=<host:55333>`, `--pf-hub-key=<secret>`, `--pf-hub-pin=<sha256>`
- Pool listener: `--pf-listen=<addr>`, `--pf-client-keys=<k1,k2>`, `--backends=<n1=http://...#k=v>`, `--queue-timeout=<dur>`

### WebRTC Live View Flags

- `--webrtc-stun=<urls>` (default `stun.l.google.com:19302`)
- `--webrtc-turn=<user:pass@turn:host:port>`
- `--webrtc-fps=<num>` (default `30`)
- `--webrtc-encoder=<auto|nvenc|qsv|amf|mf|x264|datachannel>`
- `--ffmpeg-path=<path>`
- Pool built-in TURN: `--webrtc-turn-listen=<addr>`, `--webrtc-public-ip=<ip>`, `--webrtc-turn-secret=<secret>`

### MCP Server Flags (`browser-go mcp`)

- `--endpoint=<url>` (default `http://127.0.0.1:3000`)
- `--token=<str>`
- `--user=<id>` (default `mcp-agent`; also accepts a Qinghu shop profile name when `--provider=qinghu`)
- `--provider=<chrome|qinghu>`
- `--tags=<k:v,k2:v2>` (Pool routing tags)

---

## 2. MCP Client Configuration Example

Add to Claude Desktop / Cursor / Antigravity MCP config:

```json
{
  "mcpServers": {
    "browser-go": {
      "command": "browser-go",
      "args": [
        "mcp",
        "--endpoint=http://127.0.0.1:3000",
        "--token=my-secret",
        "--user=agent-1"
      ]
    }
  }
}
```

For Qinghu anti-detect shop profile automation:

```json
{
  "mcpServers": {
    "browser-go-qinghu": {
      "command": "browser-go",
      "args": [
        "mcp",
        "--endpoint=http://127.0.0.1:3000",
        "--token=my-secret",
        "--provider=qinghu",
        "--user=vn-temu"
      ]
    }
  }
}
```

---

## 3. RESTful Management & Handoff API

Authenticate via `?token=<secret>`, header `X-API-Token: <secret>`, or `Authorization: Bearer <secret>`.

| Method & Path | Description |
| --- | --- |
| `GET /healthz` | Liveness check |
| `GET /dashboard` | Interactive Web Console & WebRTC Live View |
| `GET /api-docs` & `/openapi.json` | Embedded OpenAPI 3.0.3 documentation |
| `GET /json/version` & `/json/list` | Standard CDP HTTP discovery endpoints |
| `GET /api/v1/browser/stats` | Node or pool capacity & `available_slots` |
| `GET /api/v1/browser/list` | Active browser instances, current URLs, and handoff status |
| `GET /api/v1/browser/stop?user_id=<id>` | Stop a user's browser instance |
| `GET /api/v1/browser/targets?user_id=<id>` | List open tabs/targets of an instance |
| `POST /api/v1/browser/handoff` | Request human takeover (`user_id`, `reason`, `timeout_sec`, `async`) |
| `POST /api/v1/browser/handoff/resume` | Mark handoff resolved and resume waiting agent (`user_id`, `note`) |
| `GET /api/v1/pool/nodes` | (Pool mode) Online nodes, RTT, slots, and routing tags |
| `GET /api/v1/devices` & `/api/v1/device/stats` | Connected Chrome extension devices |
| `WS /extension` & `WS /cdp` | Chrome Extension Tab-Group isolated CDP bridge |
