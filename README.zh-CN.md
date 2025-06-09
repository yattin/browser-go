# Browser-Go

Browser-Go 是一个基于 Chrome DevTools Protocol (CDP) 的浏览器管理服务，提供基于 WebSocket 的 Chrome 实例代理、自动生命周期管理、用户会话持久化和实例控制的 RESTful API。

[English Documentation](README.md)

## 功能特点

- **多用户并发访问** 支持可配置的实例限制
- **WebSocket 代理** 到 Chrome DevTools Protocol 端点
- **自动生命周期管理** 基于超时的清理机制
- **用户会话持久化** 通过专用的 Chrome 用户数据目录
- **RESTful API** 用于实例控制（停止、列表、统计）
- **Swagger UI 文档** 位于 `/api-docs`
- **多种部署选项** 包括独立可执行文件
- **TypeScript 实现** 提供全面的类型安全
- **结构化日志记录** 支持每日轮转和控制台/文件输出

## 系统要求

- **Node.js 18.0+**（单一可执行应用需要）
- **Chrome 浏览器**（自动检测）
- **操作系统**：Windows/Linux/macOS
- **包管理器**：pnpm（推荐，在 packageManager 字段中指定）

## 安装

### 方式一：从源码构建

1. 克隆仓库：
```bash
git clone https://github.com/yattin/browser-go.git
cd browser-go
```

2. 安装依赖：
```bash
pnpm install
```

3. 构建项目：
```bash
pnpm run build
```

### 方式二：下载二进制文件

从 [Releases](https://github.com/yattin/browser-go/releases) 页面下载预构建的二进制文件：
- `browser-go-sea-linux`（Linux）
- `browser-go-sea-windows.exe`（Windows）
- `browser-go-sea-macos`（macOS）

## 使用方法

### 启动服务

#### 从源码构建启动
```bash
# 构建并启动
pnpm run build
node dist/cli.js [选项]

# 或使用启动脚本
pnpm run start -- [选项]
```

#### 从二进制文件启动
```bash
# Linux/macOS
./browser-go-sea-linux [选项]

# Windows
browser-go-sea-windows.exe [选项]
```

### 命令行选项

| 选项                                  | 说明                         | 默认值             |
| ------------------------------------- | ---------------------------- | ------------------ |
| `--max-instances=<number>`            | 最大并发实例数               | 10                 |
| `--instance-timeout=<minutes>`        | 实例超时时间（分钟）         | 60                 |
| `--inactive-check-interval=<minutes>` | 检查不活跃实例的间隔（分钟） | 5                  |
| `--token=<string>`                    | 身份验证访问令牌             | 'browser-go-token' |
| `--help`                              | 显示帮助信息                 | -                  |

### 示例

```bash
# 使用默认配置启动
node dist/cli.js
# 或使用二进制文件
./browser-go-sea-linux

# 自定义配置启动
node dist/cli.js --max-instances=5 --instance-timeout=30 --inactive-check-interval=2

# 设置自定义访问令牌
node dist/cli.js --token=my-secret-token

# 使用 pnpm 启动脚本传递选项
pnpm run start -- --max-instances=5 --token=custom-token
```

## API 接口

服务提供 WebSocket 和 RESTful API 端点。运行时可在 `/api-docs`（Swagger UI）查看完整的 API 文档。

### WebSocket 连接（浏览器启动）

通过 WebSocket 连接启动浏览器实例，支持两种 URL 格式：

#### 1. 查询字符串格式
```
ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
```

#### 2. 路径格式
```
ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
```

**参数说明：**
- `token`：身份验证访问令牌（必需）
- `startingUrl`：浏览器启动后访问的 URL（必需，路径格式中需要 URL 编码）
- `launch`：JSON 格式的启动参数（可选，仅作为查询参数）

**启动参数示例：**
```json
{
  "user": "user123", 
  "args": ["--window-size=1920,1080", "--lang=zh-CN", "--disable-web-security"]
}
```

**用户会话持久化：** 当提供 `user` 参数时，Chrome 实例会被缓存并在同一用户的后续连接中重复使用。用户数据存储在 `~/.browser-go/browser_data/<user_id>/`。

### RESTful API 端点

#### 停止浏览器实例
```http
GET /api/v1/browser/stop?user_id=<user_id>
```
停止指定用户的特定浏览器实例。

#### 列出活跃实例
```http
GET /api/v1/browser/list
```
返回所有活跃的浏览器实例以及活动数据和系统统计信息。

#### 系统统计信息
```http
GET /api/v1/browser/stats
```
返回当前系统状态，包括实例计数、限制和配置信息。

#### API 文档
```http
GET /api-docs
```
所有端点的交互式 Swagger UI 文档。

```http
GET /openapi.json
```
JSON 格式的 OpenAPI 3.0 规范。

## 配置说明

### 实例管理

- **最大并发实例数**：控制可同时运行的最大浏览器实例数。达到此限制时，新连接请求将被拒绝。
- **实例超时时间**：浏览器实例在非活跃状态下的最大存活时间（默认：60分钟）。超过此时间后，实例将被自动关闭。
- **非活跃检查间隔**：系统检查非活跃实例的频率（默认：5分钟）。根据使用模式调整。
- **访问令牌**：用于验证客户端请求的令牌。生产环境中使用强随机值。

### 文件位置

- **用户数据**：`~/.browser-go/browser_data/<user_id>/` - Chrome 用户数据目录
- **日志**：`~/.browser-go/logs/browser-go-YYYY-MM-DD.log` - 每日轮转日志（保留10天，每文件最大10MB）

### 日志记录

使用 Winston 的结构化日志记录功能：
- **控制台输出**：开发用的彩色格式
- **文件输出**：每日轮转与自动清理
- **日志级别**：error、warn、info、debug

## 生产环境部署

### 性能考虑

1. **内存需求**：确保有足够的系统内存运行多个 Chrome 实例（推荐：每10个实例2GB+）
2. **反向代理**：使用 Nginx 或类似工具进行负载均衡和 SSL 终端
3. **进程管理**：使用 PM2、systemd 或 Docker 进行进程监督
4. **监控**：定期检查日志和 `/api/v1/browser/stats` 端点

### 安全建议

1. 生产环境中使用强、唯一的访问令牌
2. 考虑网络级访问控制
3. 监控资源使用并设置适当限制
4. 定期审查日志以发现可疑活动

## 开发

### 项目结构

```
browser-go/
├── src/                    # TypeScript 源代码
│   ├── cli.ts             # 主入口点
│   ├── logger.ts          # 基于 Winston 的日志模块
│   ├── types.ts           # TypeScript 类型定义
│   └── test.ts            # 测试脚本
├── dist/                   # 编译的 JavaScript 输出（tsc）
├── dist-vite/              # 打包输出（Vite）
├── binary/                 # 构建的可执行文件
├── .github/workflows/      # GitHub Actions CI/CD
├── openapi.yaml           # API 规范
├── sea-config.json        # 单一可执行应用配置
├── vite.config.ts         # Vite 打包器配置
├── tsconfig.json          # TypeScript 编译器配置
├── eslint.config.js       # ESLint 配置（扁平配置）
├── .prettierrc.cjs        # Prettier 配置
├── package.json           # 项目配置
└── pnpm-lock.yaml         # PNPM 锁定文件
```

### 构建系统

项目使用**双构建系统**：

1. **TypeScript 编译**（`pnpm run build`）：用于开发的直接 tsc 编译
2. **Vite 打包**（`pnpm run build:bundle`）：为分发创建优化的单文件包

### 开发脚本

#### 核心开发
- `pnpm run build` - 编译 TypeScript 到 JavaScript
- `pnpm run start` - 启动编译后的应用程序
- `pnpm run test` - 运行测试
- `pnpm run lint` - 代码检查
- `pnpm run lint:fix` - 代码检查并自动修复

#### 二进制文件生成
- `pnpm run build:sea:macos` - 构建 macOS SEA 可执行文件
- `pnpm run build:sea:windows` - 构建 Windows SEA 可执行文件
- `pnpm run build:sea:linux` - 构建 Linux SEA 可执行文件
- `pnpm run build:binary:all` - 构建 PKG 二进制文件（传统）

#### 打包
- `pnpm run build:bundle` - 使用 Vite 创建单文件包

### 代码风格与质量

- **TypeScript**：严格配置的完全类型安全
- **ESLint**：支持 TypeScript 的代码检查
- **Prettier**：代码格式化（2空格，单引号，分号）
- **命名约定**：变量/函数使用 camelCase，类型/类使用 PascalCase

### 依赖项

#### 运行时依赖
- **express** - Web 服务器框架
- **chrome-launcher** - Chrome 浏览器启动器
- **ws** - WebSocket 实现
- **http-proxy** - HTTP 代理
- **winston** - 结构化日志记录
- **swagger-ui-express** - API 文档
- **uuid** - 唯一标识符生成

#### 开发依赖
- **typescript** - TypeScript 编译器
- **vite** - 快速打包器
- **eslint** - 代码检查
- **prettier** - 代码格式化
- **pkg** - 二进制文件打包（传统）
- **postject** - SEA 二进制文件注入

### 自动化构建

GitHub Actions 自动为所有平台构建 SEA 可执行文件：

- **触发器**：推送到 `main`/`ts` 分支、版本标签（`v*`）或到 `main` 的拉取请求
- **平台**：Linux、Windows、macOS
- **构件**：构建完成后30天内可用
- **发布**：为版本标签自动创建，附带所有平台二进制文件

构建工作流在 `.github/workflows/build-sea.yml` 中定义。

### 单一可执行应用（SEA）

项目支持 Node.js 20+ SEA 创建独立可执行文件：

- **配置**：`sea-config.json`
- **优势**：官方 Node.js 解决方案，无外部依赖
- **替代**：第三方工具如 PKG，具有更好的兼容性和性能

## 许可证

ISC License