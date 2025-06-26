# CLAUDE.md

此文件为 Claude Code (claude.ai/code) 在此代码仓库中处理代码时提供指导。

## 项目概述

Browser-Go 是一个基于 Chrome DevTools Protocol (CDP) 的浏览器管理服务，支持多用户并发访问和会话管理。它提供基于 WebSocket 的 Chrome 实例代理，具有自动生命周期管理、用户会话持久性和用于实例控制的 RESTful API。

### 核心架构

应用程序由以下几个模块化组件组成：

1. **主服务 (`src/cli.ts`)**：Express 服务器入口点，集成所有模块并启动 HTTP/WebSocket 服务器
2. **Chrome 管理器 (`src/chrome-manager.ts`)**：Chrome 实例生命周期管理，包含缓存和自动清理
3. **设备管理器 (`src/device-manager.ts`)**：Chrome 扩展设备注册和路由管理
4. **CDP 桥接 (`src/cdp-bridge.ts`)**：Chrome DevTools Protocol 中继桥接，用于 WebSocket 通信
5. **WebSocket 处理器 (`src/websocket-handlers.ts`)**：WebSocket 连接处理和协议路由
6. **API 路由 (`src/api-routes.ts`)**：浏览器实例管理的 RESTful API 端点定义
7. **配置 (`src/config.ts`)**：应用程序配置管理和命令行参数解析
8. **日志记录器 (`src/logger.ts`)**：基于 Winston 的日志记录，支持每日轮换和控制台/文件输出
9. **类型定义 (`src/types.ts`)**：API 响应、配置和内部数据结构的 TypeScript 接口
10. **OpenAPI (`src/openapi.ts`)**：OpenAPI 规范加载和解析工具

### 主要功能

- 多用户并发 Chrome 实例管理，具有可配置的限制
- WebSocket 代理到 Chrome DevTools Protocol 端点
- 基于超时的非活动实例自动清理
- 通过专用 Chrome 用户数据目录实现用户会话持久性
- 用于实例控制的 RESTful API（停止、列表、统计）
- 位于 `/api-docs` 的 Swagger UI 文档
- Chrome 扩展设备注册和管理
- 扩展到服务通信的 CDP 桥接

## 构建、代码检查和测试命令

- **构建项目**：`pnpm run build`
  - 将根目录下的 TypeScript 文件编译到 `./dist` 目录的 JavaScript。
- **构建打包版本**：`pnpm run build:bundle`
  - 使用 Vite 在 `./dist-vite/browser-go.cjs` 创建优化的打包版本。
- **运行代码检查**：
    - `pnpm run lint`：检查代码问题。
    - `pnpm run lint:fix`：检查并尝试自动修复代码问题。
  - ESLint 通过 `eslint.config.js` 配置（使用 `FlatCompat` 加载 `.eslintrc.cjs`）。
- **运行测试**：提供多个测试套件：
  - `pnpm run test:bridge` - 测试 CDP 桥接功能（单元测试）
  - `pnpm run test:e2e:script` - 使用真实 Chrome 和扩展的完整端到端测试
  - `pnpm run test:patchright` - Playwright 兼容性测试
- **手动测试环境**：快速手动测试设置：
  - `pnpm run open:browser` - 启动加载了扩展的 Chrome 进行手动测试
- **启动应用程序**：`pnpm run start` 或 `node dist/cli.js [选项]`
  - **命令行选项**：
    - `--port=<数字>` - 服务器端口（默认：3000）
    - `--max-instances=<数字>` - 最大并发实例数（默认：10）
    - `--instance-timeout=<分钟>` - 实例超时分钟数（默认：60）
    - `--inactive-check-interval=<分钟>` - 清理间隔分钟数（默认：5）
    - `--token=<字符串>` - 访问令牌（默认：'browser-go-token'）
    - `--cdp-logging` - 启用详细的 CDP 协议日志记录
    - `--help` - 显示帮助信息
- **类型检查**：`pnpm run build`（因为它运行 `tsc`）或 `npx tsc --noEmit` 进行空运行。

## 二进制生成命令

### 传统 PKG 二进制生成（旧版）
- **为 macOS 构建二进制文件**：`pnpm run build:binary:macos`
- **为 Windows 构建二进制文件**：`pnpm run build:binary:windows`
- **为所有平台构建二进制文件**：`pnpm run build:binary:all`

### Node.js SEA（单一可执行应用程序）- 推荐
- **准备 SEA 包**：`pnpm run build:sea:prep`
  - 创建应用程序包并生成 `sea-prep.blob` 文件。
- **为 macOS 构建 SEA**：`pnpm run build:sea:macos`
  - 使用 Node.js 官方 SEA 创建 `binary/browser-go-sea-macos`。
- **为 Windows 构建 SEA**：`pnpm run build:sea:windows`
  - 使用 Node.js 官方 SEA 创建 `binary/browser-go-sea-windows.exe`。
- **为 Linux 构建 SEA**：`pnpm run build:sea:linux`
  - 使用 Node.js 官方 SEA 创建 `binary/browser-go-sea-linux`。

**注意**：SEA（单一可执行应用程序）是 Node.js 官方创建独立可执行文件的解决方案，取代了 PKG 等第三方工具。SEA 需要 Node.js 20+ 并使用 `sea-config.json` 配置文件。

## 自动化构建

GitHub Actions 自动为所有平台构建 SEA 可执行文件：

- **触发器**：推送到 `main`/`ts` 分支、以 `v*` 开头的标签，或向 `main` 的拉取请求
- **平台**：Linux、Windows、macOS
- **工件**：构建完成后可用 30 天
- **发布**：为版本标签自动创建，附带所有平台二进制文件

构建工作流定义在 `.github/workflows/build-sea.yml` 中。

## WebSocket 连接格式

服务支持两种用于浏览器实例启动的 WebSocket URL 格式：

1. **查询字符串格式**：
   ```
   ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
   ```

2. **路径格式**：
   ```
   ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
   ```

启动参数（`launch`）为 JSON 格式，包括：
- `user`：用于会话持久性的用户标识符（创建专用的 Chrome 用户数据目录）
- `args`：Chrome 启动参数数组（例如：`["--window-size=1920,1080", "--lang=en-US"]`）

## 实例管理

- **会话持久性**：提供 `user` 参数时，Chrome 实例会被缓存并为同一用户的后续连接重用
- **用户数据目录**：位于 `~/.browser-go/browser_data/<user_id>/`
- **自动清理**：基于可配置的超时清理非活动实例（默认：60 分钟）
- **并发限制**：可配置的最大并发实例数（默认：10）

## 手动测试环境

项目提供了一个专用脚本，用于快速手动测试 Chrome 扩展和 CDP 桥接功能：

### 浏览器启动器（`src/open-browser.ts`）
- **用途**：启动预加载扩展的 Chrome 进行手动测试
- **命令**：`pnpm run open:browser`
- **功能**：
  - 自动从 `extension/` 目录加载项目扩展
  - 在 `.runtime/` 创建隔离的用户数据目录用于测试
  - 以扩展管理页面启动，便于扩展状态验证
  - 支持使用 Ctrl+C 优雅关闭
  - 在控制台输出中提供有用的测试指导

### 使用工作流
1. 运行 `pnpm run open:browser` 启动测试环境
2. 浏览器打开并加载扩展，显示扩展管理页面
3. 验证扩展已激活并启用
4. 可选择在另一个终端启动 browser-go 服务器：`pnpm run start`
5. 如果服务器正在运行，扩展将自动连接到 localhost:3000
6. 导航到任何网站进行扩展功能的手动测试
7. 按 Ctrl+C 优雅关闭测试环境

此工具非常适合：
- 快速验证扩展功能
- 手动测试 CDP 桥接功能
- 扩展开发和调试
- 在受控环境中重现用户报告的问题

## Chrome 扩展集成

项目包含一个 Chrome 扩展（`extension/`），提供设备注册和 CDP 通信：

### 扩展组件
- **清单（`extension/manifest.json`）**：扩展配置，具有 tabs、activeTab 和 CDP 访问权限
- **后台脚本（`extension/background.js`）**：处理设备注册和 WebSocket 通信
- **弹出界面（`extension/popup.html`、`extension/popup.js`）**：扩展交互的用户界面
- **图标（`extension/icons/`）**：多种尺寸的扩展图标（16x16、32x32、48x48、128x128）

### 设备管理流程
1. **设备注册**：Chrome 扩展通过 WebSocket 使用唯一设备 ID 注册
2. **连接路由**：DeviceManager 在客户端和注册设备之间路由连接
3. **CDP 桥接**：CDP 消息在扩展设备和客户端连接之间中继
4. **生命周期管理**：自动清理断开连接的设备和过期连接

## API 端点

- `GET /api/v1/browser/stop?user_id=<id>` - 停止特定浏览器实例
- `GET /api/v1/browser/list` - 列出所有活动实例及活动数据
- `GET /api/v1/browser/stats` - 系统统计和配置
- `GET /api/v1/devices` - 列出已注册设备（用于多设备支持）
- `GET /api-docs` - Swagger UI 文档
- `GET /openapi.json` - OpenAPI 规范
- `ws://localhost:3000/cdp?deviceId=<id>` - 带设备路由的 CDP WebSocket 连接

## 代码风格指南

- **语言**：TypeScript。
- **格式化**：由 Prettier 强制执行。配置在 `.prettierrc.cjs` 中。
  - 关键设置：2 个空格缩进、分号、单引号。
- **代码检查**：由 ESLint 与 TypeScript 支持（`@typescript-eslint`）强制执行。配置在 `eslint.config.js` 和 `.eslintrc.cjs` 中。
- **命名约定**：
  - 变量和函数：`camelCase`。
  - 接口和类型：`PascalCase`。
  - 类和构造函数：`PascalCase`。
  - 常量：`UPPER_SNAKE_CASE`。
  - 枚举成员：`PascalCase`。
- **错误处理**：对同步错误使用 try-catch 块。对于异步操作，处理 promise 拒绝。在定义时使用自定义错误类型。
- **日志记录**：使用 `logger.ts` 模块进行应用程序日志记录。
- **导入**：使用 ES 模块 `import/export` 语法。确保类型导入在适当时使用 `import type { ... } from '...'`。
- **类型安全**：力求强类型安全。尽可能避免 `any`；优先使用 `unknown` 或更具体的类型。使用 ESLint 规则 `@typescript-eslint/no-explicit-any`（当前在 `eslint.config.js` 中设置为 'warn'，考虑 'error'）。

## 构建系统

项目使用双重构建系统：

1. **TypeScript 编译**（`pnpm run build`）：从 `src/` 直接 tsc 编译到 `dist/`
2. **Vite 打包**（`pnpm run build:bundle`）：在 `dist-vite/browser-go.cjs` 创建单个打包的 CommonJS 文件

### Vite 配置

- **目标**：Node.js 18+ 与 CommonJS 输出
- **打包策略**：打包所有第三方依赖，仅排除 Node.js 内置模块
- **入口点**：`src/cli.ts` → `dist-vite/browser-go.cjs`
- **外部依赖**：仅 Node.js 内置模块（fs、path、http 等）

## YAML 解析

应用程序包含一个自定义的简单 YAML 解析器（`src/cli.ts` 中的 `parseSimpleYaml()`），用于加载 OpenAPI 规范。这个轻量级解析器处理基本的 YAML 结构，在修改 `openapi.yaml` 时应考虑这一点。

## 日志配置

日志写入到：
- **控制台**：用于开发的彩色格式
- **文件**：`~/.browser-go/logs/browser-go-YYYY-MM-DD.log`，带每日轮换
- **保留**：10 天，每个文件最大 10MB

## 测试架构

项目使用带有自定义测试运行器的综合测试系统：

### 测试类别
- **单元测试**：独立测试各个组件（DeviceManager、ChromeManager 等）
- **集成测试**：测试组件交互和 API 端点
- **端到端测试**：使用真实 Chrome 实例和 WebSocket 连接的完整系统测试

### 测试运行器（`src/test-runner.ts`）
自定义测试编排系统，提供：
- 并行测试执行支持
- 测试分类和过滤
- 跨所有测试套件的统一报告
- 详细和安静输出模式
- 单个测试套件执行

### 测试文件结构
- `test-bridge.ts` - CDP 桥接功能测试
- `test-e2e-complete.ts` - 带有多设备支持和 Playwright 集成的完整端到端测试
- `test-patchright.ts` - Playwright 兼容性测试
- `test-cleanup.ts` - 浏览器进程清理机制测试
- `test-exception-cleanup.ts` - 异常处理和清理验证

### 运行单个测试
- `pnpm run test:bridge` - 仅运行 CDP 桥接测试
- `pnpm run test:patchright` - 运行 Playwright 兼容性测试
- `pnpm run test:e2e:script` - 运行完整的 E2E 测试套件
- 构建后：`node dist/test-<name>.js` 用于任何特定测试

## 测试数据管理

所有测试文件使用 `.runtime/` 内的隔离用户数据目录，以防止交叉测试污染：
- 主 E2E 测试：`.runtime/test-e2e-main/`
- 多设备测试：`.runtime/test-device-0/`、`.runtime/test-device-1/` 等
- Playwright 测试：`.runtime/test-patchright/`
- 清理测试：`.runtime/test-cleanup/`
- 异常测试：`.runtime/test-exception-cleanup/`
- 手动测试：`.runtime/`（通过 `pnpm run open:browser`）

`.runtime` 目录被 git 忽略，并在测试期间自动清理。

## 多设备架构

CDP 桥接支持具有适当消息路由的多个并发设备连接：

### 关键组件
- **CDPRelayBridge**（`src/cdp-bridge.ts`）：管理具有请求-响应映射的多个 CDP 连接
- **DeviceManager**（`src/device-manager.ts`）：处理设备注册和连接路由
- **消息路由**：响应仅发送到发起连接，不广播

### 多设备消息流
1. **设备注册**：Chrome 扩展通过 WebSocket 使用唯一设备 ID 注册
2. **连接映射**：每个 CDP 连接映射到特定的设备 ID
3. **请求跟踪**：消息 ID 映射到连接 ID 以进行正确的响应路由
4. **心跳维护**：Ping/pong 消息自动维护设备注册

### 关键实现注意事项
- `_handleBrowserDomainMethod` 和 `_handleTargetDomainMethod` 处理本地 CDP 操作
- 设备寻址是核心 CDP 方法的唯一添加 - 其他逻辑应保持不变
- 心跳 ping 自动在 DeviceManager 中注册/更新设备

## 错误处理模式

- WebSocket 错误通过适当的套接字清理优雅地处理
- Chrome 实例故障触发缓存实例的自动清理
- 所有 API 端点返回一致的 JSON 响应格式，包含 `code`、`msg` 和可选的 `data` 字段
- 多设备路由故障向请求连接返回特定的错误消息