---
name: browser-go
description: Operate Browser-Go (v2.0+) for high-stability Chrome CDP browser pooling, multi-node ProxyForge intranet penetration gateways, Qinghu anti-detect fingerprint browser integration (--qinghu), WebRTC Live View remote takeover with precision drag, Human-in-the-Loop CAPTCHA/2FA handoff, and the built-in pure-Go stdio MCP server (browser-go mcp).
---

# Browser-Go Skill

Use this skill to deploy, operate, and automate **Browser-Go** — a pure-Go single-binary CDP browser pool, ProxyForge-compatible intranet tunnel gateway, WebRTC Live View console, and stdio MCP server.

- **Latest Releases**: https://github.com/yattin/browser-go/releases/latest
- **Full CLI / API / MCP Config Reference**: `references/cli-and-api.md`

## Locating the Binary

Use the helper wrapper `scripts/browser-go-cli.ps1` on Windows (resolves `$env:BROWSER_GO_BIN`, `bin\browser-go.exe`, `%LOCALAPPDATA%\BrowserGo\browser-go.exe`, or `PATH`), or invoke `browser-go` directly on Linux/macOS:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/browser-go-cli.ps1 version
```

## Core Workflows

### 1. Start a Worker Node (Single-Host CDP Pool)

```bash
browser-go node --port=3000 --max-instances=10 --token=<secret> --headless
```

- **Web Console & Live View**: Open `http://127.0.0.1:3000/dashboard` (auto-discovers instances, supports WebRTC Live View with Chrome-style tab bar, IME input, and ordered precision drag — hold `Shift` for 0.25x micro-adjustment on sliders).
- **Qinghu Anti-Detect Fingerprint Browser Mode**: Add `--qinghu` to auto-discover local Qinghu Agent profiles (`%LOCALAPPDATA%\Qinghu`) and route `launch={"provider":"qinghu","user":"<shop_name>"}` directly to isolated Beryl anti-detect profiles.
- **Playwright / Patchright Connection**:
  ```text
  ws://127.0.0.1:3000?token=<secret>&startingUrl=https://example.com&launch={"user":"alice"}
  ```
- **Background Daemon / Windows SCM Service**:
  - Background: append `--daemon`
  - Windows auto-start service (Admin): `browser-go install -n BrowserGoNode node --port=3000 --token=<secret>` then `browser-go start -n BrowserGoNode`
  - Inspect status (no Admin required): `browser-go status -n BrowserGoNode --json`

### 2. Multi-Node Distributed Pool + ProxyForge Intranet Tunnel

1. **Generate mTLS certs** (once): `browser-go keygen --out-dir=./certs --clients=node-sh,node-bj`
2. **Public Pool Gateway**:
   ```bash
   browser-go pool --port=3000 --token=<pool-secret> \
     --pf-listen=0.0.0.0:33080 \
     --pf-cert=certs/server.crt --pf-key-file=certs/server.key --pf-ca=certs/ca.crt \
     --pf-client-keys=node-sh,node-bj
   ```
3. **Intranet Worker Node** (`--port=0` for zero local listening ports):
   ```bash
   browser-go node --port=0 --max-instances=8 --token=<pool-secret> \
     --pf-bridge=<pool-host>:33080 --pf-key=node-sh \
     --pf-cert=certs/node-sh.crt --pf-key-file=certs/node-sh.key --pf-ca=certs/ca.crt \
     --tags="region=shanghai,isp=telecom" --pf-p2p
   ```
4. **Route by tags or sticky user**:
   ```text
   ws://<pool-host>:3000?token=<pool-secret>&tags=region:shanghai&launch={"user":"alice"}
   ```

### 3. AI Agent Built-In Stdio MCP Server (`browser-go mcp`)

Expose any Browser-Go node or pool as a stealth MCP server (never calls `Runtime.enable`, uses human-like Bezier mouse movement):

```bash
browser-go mcp --endpoint=http://127.0.0.1:3000 --token=<secret> --user=agent-1
```

Available MCP tools:
- `browser_list_instances`: Inspect active sessions, current URLs, and pending handoffs.
- `browser_navigate`: Open `http`/`https` URLs in a sticky session (or Qinghu shop profile).
- `browser_aria_snapshot`: Return a compact interactive DOM tree with numeric `[ref]` IDs.
- `browser_screenshot_with_labels`: Capture a PNG screenshot with `[1]`, `[2]`, ... element badges.
- `browser_click`: Click by `[ref]`, CSS `selector`, or visible `text` (`human: true` by default).
- `browser_type`: Type ASCII or CJK text into `[ref]` / `selector` with optional `submit: true`.
- `browser_request_handoff`: Pause automation and summon a human operator on `/dashboard` + WebRTC Live View.

### 4. Human-in-the-Loop Handoff (CAPTCHA / 2FA / Login)

When automation encounters a CAPTCHA, slider verification, 2FA prompt, or login wall:
1. **Trigger Handoff** via MCP tool `browser_request_handoff` or REST API:
   ```bash
   curl -X POST "http://127.0.0.1:3000/api/v1/browser/handoff?token=<secret>" \
     -H "Content-Type: application/json" \
     -d '{"user_id":"alice","reason":"Please complete slider CAPTCHA","timeout_sec":300,"async":false}'
   ```
2. **Human Takeover**: Direct the user to `http://<host>:3000/dashboard` (or the returned `dashboard_url`). The user opens WebRTC Live View, completes verification (holding `Shift` for 0.25x precision drag on tight sliders), and clicks **"完成并交还 Agent"**.
3. **Automatic Resume**: The blocking handoff call returns immediately (`status: "resumed"`) so automation continues seamlessly in the same authenticated session.

## Security & Guardrails

- Always set a strong `--token` and `--strict-auth` when binding to non-loopback interfaces (`--host=0.0.0.0`).
- Never read, print, or exfiltrate Qinghu `agent.json` tokens or user credentials.
- Never attempt to solve or bypass CAPTCHAs/anti-bot challenges programmatically; always use `browser_request_handoff` + WebRTC Live View to let the human operator complete verification.
