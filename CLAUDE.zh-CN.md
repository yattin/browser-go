# CLAUDE.md (Browser-Go TypeScript 版本项目配置)

此文件为 Claude Code (claude.ai/code) 在此代码仓库中处理代码时提供指导。
项目现已迁移到 TypeScript。

## 项目概述

Browser-Go 是一个基于 Chrome DevTools Protocol (CDP) 的浏览器管理服务，支持多用户并发访问和会话管理。它提供了一个基于 WebSocket 的 API，用于启动 Chrome 浏览器实例，并具有用户会话持久性和自动清理功能。

## 开发命令

- **构建项目**: `pnpm run build`
  - 将根目录下的 TypeScript 文件编译为 JavaScript 到 `./dist` 目录。
- **运行 Linter**:
    - `pnpm run lint`: 检查 linting 问题。
    - `pnpm run lint:fix`: 检查并尝试自动修复 linting 问题。
  - ESLint 通过 `eslint.config.js` (其使用 `FlatCompat` 加载 `.eslintrc.cjs`)进行配置。
- **运行测试**: `pnpm run test`
  - 此命令执行编译后的测试脚本 `dist/test.js`。
  - 运行单个测试文件 (如果适用，取决于测试运行器): 当前 `test.ts` 是一个单独的脚本。如果后续集成 Jest 之类的测试运行器，此命令会更改。
- **启动应用**: `pnpm run start`
  - 此命令执行编译后的主应用脚本 `dist/cli.js`。
  - 或者，在构建后: `node dist/cli.js [选项]`
- **类型检查**: `pnpm run build` (因为它运行 `tsc`) 或 `npx tsc --noEmit` 进行空运行检查。

### 服务选项 (通过 `node dist/cli.js` 使用时)

- `--max-instances=<数量>`：最大并发实例数（默认：10）
- `--instance-timeout=<分钟数>`：实例超时时间（分钟）（默认：60）
- `--inactive-check-interval=<分钟数>`：非活动实例检查间隔（分钟）（默认：5）
- `--token=<字符串>`：访问令牌（默认：'browser-go-token'）

## 代码风格指南

- **语言**: TypeScript。
- **格式化**: 由 Prettier 强制执行。配置位于 `.prettierrc.cjs`。
  - 主要设置: 2个空格缩进，使用分号，优先使用单引号。
- **Linting**: 由 ESLint 结合 TypeScript 支持 (`@typescript-eslint`) 强制执行。配置位于 `eslint.config.js` 和 `.eslintrc.cjs`。
- **命名约定**:
  - 变量和函数: `camelCase`。
  - 接口和类型: `PascalCase`。
  - 类和构造函数: `PascalCase`。
  - 常量: `UPPER_SNAKE_CASE`。
  - 枚举成员: `PascalCase`。
- **错误处理**: 对同步错误使用 try-catch 块。对于异步操作，处理 Promise拒绝。适时使用自定义错误类型。
- **日志记录**: 使用 `logger.ts` 模块进行应用日志记录。
- **导入**: 使用 ES模块 `import/export` 语法。确保类型导入在适当时使用 `import type { ... } from '...'`。
- **类型安全**: 力求强类型安全。尽可能避免使用 `any`；优先使用 `unknown` 或更具体的类型。使用 ESLint 规则 `@typescript-eslint/no-explicit-any` (当前在 `eslint.config.js` 中设置为 'warn'，可考虑设为 'error')。

## 架构

### 核心组件

**`cli.ts`** - 主要服务入口点 (TypeScript)，包含：

- Express HTTP 服务器，支持 WebSocket 升级处理。
- Chrome 实例生命周期管理，具有用户会话持久性。
- 基于可配置超时的非活动实例自动清理。
- 用于浏览器管理的 RESTful API 端点。

**`logger.ts`** - 基于 Winston 的日志系统 (TypeScript)，具有：

- 控制台和文件输出，使用每日轮换。
- 日志存储在 `~/.browser-go/logs/` 目录中。
- 用于结构化日志记录的 JSON 格式。

**`types.ts`** - 定义项目 API 和内部使用的 TypeScript 类型。

### 主要特性

- **多用户支持**：每个用户在 `~/.browser-go/browser_data/<user_id>` 中拥有持久的 Chrome 配置文件。
- **实例池化**：为回头用户重用现有的 Chrome 实例。
- **自动清理**：后台进程在超时后移除非活动实例。
- **并发限制**：可配置的最大实例数，达到限制时返回 503 响应。

### WebSocket 连接模式

支持两种浏览器启动 URL 格式：

1. 查询字符串：`ws://localhost:3000?token=<令牌>&startingUrl=<url>&launch=<启动参数>`
2. 路径格式：`ws://localhost:3000/startingUrl/<url>/token/<令牌>?launch=<启动参数>`

启动参数 JSON 格式：

```json
{
  "user": "user123",
  "args": ["--window-size=1920,1080", "--lang=en-US"]
}
```

### API 端点

- `GET /api/v1/browser/stop?user_id=<id>` - 停止指定的浏览器实例
- `GET /api/v1/browser/list` - 列出所有活动实例及其活动状态
- `GET /api/v1/browser/stats` - 系统状态和容量信息

## 项目结构
```
browser-go/
├── cli.ts                # 主要入口文件 (TypeScript)
├── logger.ts             # 日志模块 (TypeScript)
├── types.ts              # TypeScript 类型定义
├── test.ts               # 测试脚本 (TypeScript)
├── dist/                 # 编译后的 JavaScript 输出目录
│   ├── cli.js
│   ├── logger.js
│   ├── types.js
│   └── test.js
├── tsconfig.json         # TypeScript 编译器配置
├── eslint.config.js      # ESLint 配置 (flat config, 新默认)
├── .eslintrc.cjs         # ESLint 旧式配置 (供 FlatCompat 在 eslint.config.js 中使用)
├── .prettierrc.cjs       # Prettier 代码格式化工具配置
├── package.json          # 项目依赖和脚本
├── pnpm-lock.yaml        # PNPM 锁文件，确保安装一致性
├── openapi.yaml          # API 的 OpenAPI 规范
├── README.md             # 项目文档 (英文)
├── README.zh-CN.md       # 项目文档 (中文)
├── CLAUDE.md             # AI 代理的此配置文件 (英文)
├── CLAUDE.zh-CN.md       # AI 代理的此配置文件 (中文)
└── contexts/             # /flow 模式上下文文件目录
    └── ...
```

## 依赖项

- **express**：Web 服务器框架
- **chrome-launcher**：Chrome 浏览器实例管理
- **http-proxy**：用于 CDP 连接的 WebSocket 代理
- **patchright**：测试中使用的 Playwright 分支 (类型暂定为 `any`)
- **winston**：具有每日轮换功能的结构化日志记录
- **axios**：用于 Chrome 调试器 API 调用的 HTTP 客户端
- **typescript**: TypeScript 语言支持
- **@types/***: 各依赖的类型定义
- **eslint**, **prettier**, **@typescript-eslint/***: Linting 和格式化工具
