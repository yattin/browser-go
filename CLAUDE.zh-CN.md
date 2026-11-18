# CLAUDE.md (Golang Edition v2.0)

此文档指导在 `browser-go` 仓库中进行 Golang 代码开发、构建与测试。

## 架构概览

`browser-go` 现已重构为纯 Golang 单二进制架构（旧版 TypeScript 代码归档于 `legacy-ts/`）：

1. **`cmd/browser-go/main.go`**：CLI 主入口，支持 `node`（默认工作节点）、`pool`（分布式浏览器池网关）、`keygen`（mTLS 证书签发）、`version`。
2. **`internal/config`**：命令行参数解析与默认安全策略（开启 `--pf-bridge` 时默认收敛监听至 `127.0.0.1`）。
3. **`internal/chrome`**：Chrome/Chromium/Edge/Brave 自动探测、Windows Job Object / Unix 进程组内核级隔离、槽位原子预占、同用户并发合并与空闲/临时实例回收。
4. **`internal/wsutil`**：RFC 6455 消息级 WebSocket 编解码（支持 64MB 大帧分片重组）与零拷贝 `ProxyRawWebSocket` 流透传。
5. **`internal/cdpbridge`**：多设备并发安全的 Chrome 扩展 CDP 桥接器（独立会话上下文、请求序号重映射、按 `deviceId` 事件隔离）。
6. **`internal/server`**：工作节点 HTTP/WebSocket 路由、OpenAPI 3.0.3 内嵌文档（`/openapi.json` & `/api-docs`）及内存管道监听（`--port=0` 零端口穿透）。
7. **`pkg/pftunnel`**：与 `ProxyForge` 100% 线级互通的内网穿透协议栈（9 字节头 `MuxSession`、`tclient` 多链路、双向 mTLS / `--pf-tls-pin`、`-Z` AES-256-GCM、`-M` Flate、`xtaci/kcp-go/v5` KCP+FEC、`--pf-p2p` STUN+UDP 打洞、`EmbeddedBridge` 及 `:55333` Cluster Hub 上报）。
8. **`internal/pool`**：多节点 CDP 浏览器池中心调度器（支持静态 `--backends` 与内置 `--pf-listen` 自动注册，实现槽位感知分发、`launch.user` 粘性路由、标签过滤与满载排队）。

## 构建与测试命令

- **构建并执行全量自动化测试**：
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1 -SelfTest
  ```
- **单独运行指定包测试**：
  ```bash
  go test -v ./internal/chrome ./internal/cdpbridge ./internal/pool ./pkg/pftunnel
  ```
