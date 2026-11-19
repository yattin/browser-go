# Browser-Go (Golang Edition v2.0)

Browser-Go 是一个使用 **Golang** 原生构建的高稳定性 Chrome DevTools Protocol (CDP) 浏览器实例管理服务与**分布式内网穿透浏览器池网关**。单文件零外部运行时依赖（~10 MB），内置与 `ProxyForge` 100% 线级互通的内网穿透协议栈（`bridge`/`tbridge`/mTLS/`KCP+FEC`/`--pf-p2p` UDP 打洞与 Cluster Hub 监控上报）。

> 旧版 Node.js/TypeScript 实现已完整归档至 [`legacy-ts/`](./legacy-ts)。

---

## 核心特性

- **双角色单二进制**：
  - `browser-go [node]`：工作节点模式（100% 兼容旧版 CLI 参数、REST API、启动 WebSocket 与 Chrome 扩展桥接）；
  - `browser-go pool`：多节点 CDP 浏览器池中心调度网关（槽位感知分发、`launch.user` 会话粘性路由、地域/运营商标签路由、满载等待队列）。
- **操作系统内核级进程强隔离**：
  - Windows 采用 `Job Object`（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），Linux/macOS 采用独立进程组（`-pgid`），即使主进程意外强退也绝不残留僵尸 `chrome.exe` 子进程。
- **零泄漏并发池控制**：
  - 槽位原子预占、同 `user` 并发启动合并（防止 `SingletonLock` 损坏）、匿名临时会话断开即销毁、`60ms` 极速 DevTools 就绪探测。
- **内置 `ProxyForge` 线级兼容内网穿透 (`pkg/pftunnel`)**：
  - 无需额外部署穿透客户端，通过 `--pf-bridge` 即可直连原版 `ProxyForge bridge/tbridge` 或 `browser-go pool --pf-listen`；
  - 支持双向 mTLS、`--pf-tls-pin` 证书指纹锁定、`-Z` AES-256-GCM 流加密、`-M` Flate 压缩、`xtaci/kcp-go/v5` KCP+FEC 弱网加速、`--pf-p2p` UDP 打洞直连，以及 `--pf-hub` 接入 `ProxyForge Admin (:55333)` 实时上报指标。
- **无串流多设备 Chrome 扩展桥接 (`/extension` + `/cdp`)**：
  - 独立会话隔离、单调请求序号重映射与按 `deviceId` 严格路由 CDP 事件。

---

## 快速构建与自检

```powershell
# Windows PowerShell 一键编译并运行单元与分布式集成测试
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -SelfTest

# 标准 Go 编译
go build -trimpath -ldflags="-s -w" -o bin/browser-go ./cmd/browser-go
```

---

## 典型部署拓扑

### 场景 1：单机 CDP 浏览器池（兼容旧版全部用法）
```bash
./bin/browser-go --port=3000 --max-instances=10 --token=my-secret --headless
```
Playwright / Patchright 连接：
```ts
const browser = await chromium.connectOverCDP(
  'ws://127.0.0.1:3000?token=my-secret&startingUrl=https://example.com&launch={"user":"u1"}'
);
```

### 场景 2：一键组建跨内网分布式 CDP 浏览器池（内置 Bridge 自动注册）
1. **公网中心启动 `pool` 网关**：
   ```bash
   ./bin/browser-go pool \
     --port=3000 \
     --token=pool-secret \
     --pf-listen=0.0.0.0:33080 \
     --pf-cert=ca.crt --pf-key-file=ca.key \
     --pf-client-keys=office-sh,home-bj
   ```
2. **多台内网机器启动 `node` 节点（支持 `--port=0` 纯内存隐身穿透，主机零监听端口）**：
   ```bash
   ./bin/browser-go node \
     --port=0 \
     --max-instances=8 \
     --token=pool-secret \
     --pf-bridge=pool.example.com:33080 \
     --pf-key=office-sh \
     --pf-cert=client.crt --pf-key-file=client.key --pf-ca=ca.crt \
     --tags="region=shanghai,isp=telecom"
   ```
3. **按地域标签或粘性用户连接池网关**：
   ```text
   ws://pool.example.com:3000?token=pool-secret&tags=region:shanghai&startingUrl=https://example.com&launch={"user":"alice"}
   ```

### 场景 3：直连原版 `ProxyForge` (`bridge` / `tbridge` + `ProxyForge Admin`)
```bash
# 公网运行原版 ProxyForge
proxyforge bridge -p :33080 -C ca.crt -K ca.key --client-keys node-01
proxyforge server -P 127.0.0.1:33080 -C srv.crt -K srv.key --ca-bundle ca.crt -r 127.0.0.1:13001@[node-01]127.0.0.1:3000

# 内网单二进制运行 browser-go 直接穿透并接入 ProxyForge Admin Cluster Hub
browser-go node --port=0 --token=my-secret \
  --pf-bridge=<public_ip>:33080 --pf-key=node-01 \
  --pf-cert=cli.crt --pf-key-file=cli.key --pf-ca=ca.crt --pf-p2p \
  --pf-hub=<public_ip>:55333 --pf-hub-key=<cluster_secret>
```

---

## RESTful 管理 API、可视化控制台与系统服务

### 可视化 Web 控制台 (`/dashboard`)
- **池网关控制台 (`http://<pool>:3000/dashboard`)**：实时查看健康穿透节点矩阵、RTT 延迟、槽位进度条、全池活跃浏览器实例一键强杀、以及交互式 Playwright 连接代码生成器。
- **单机节点控制台 (`http://<node>:3000/dashboard`)**：管理本机 Chrome 实例池与 Chrome 扩展桥接设备。

### 原生 Windows SCM 系统服务与后台守护 (`--daemon`)
```powershell
# 非提权只读检查系统服务状态（支持结构化 JSON）
.\bin\browser-go.exe status --json

# 终端无阻塞后台拉起（自动写入 PID 文件）
.\bin\browser-go.exe node --port=0 --pf-bridge=pool.example.com:33080 --pf-key=node-01 --daemon

# 注册为开机自启 Windows 系统服务（管理员权限运行，自动将相对证书/数据路径转为绝对路径并启用崩溃自愈）
.\bin\browser-go.exe install -n BrowserGoNode node --port=0 --pf-bridge=pool.example.com:33080 --pf-key=node-01 --pf-cert=cli.crt --pf-key-file=cli.key --pf-ca=ca.crt
.\bin\browser-go.exe start -n BrowserGoNode
```

### RESTful API
- `GET /api/v1/browser/stats` — 当前节点或全池容量与可用槽位（`available_slots`）
- `GET /api/v1/browser/list` — 列出活跃浏览器实例（`pool` 模式下聚合所有节点并标注 `node_id`）
- `GET /api/v1/browser/stop?user_id=<id>` — 停止指定用户的浏览器实例（`pool` 模式自动路由至持有该会话的节点）
- `GET /api/v1/pool/nodes` — （`pool` 模式专属）查看所有已穿透注册节点的在线状态、RTT、槽位与标签
- `GET /api/v1/devices` & `/api/v1/device/stats` — Chrome 扩展设备列表与状态
- `GET /json/version` — 标准 CDP HTTP 发现接口（支持 `connectOverCDP("http://...")`）
- `GET /api-docs` & `/openapi.json` — 内嵌 API 文档与 OpenAPI 3.0.3 规范
