# Browser-Go

Browser-Go 是一个基于 Chrome DevTools Protocol (CDP) 的浏览器管理服务，支持多用户并发访问和会话管理。

[English Documentation](README.md)

## 功能特点

- 支持多用户并发访问
- 自动管理浏览器实例生命周期
- 支持用户会话持久化
- 自动清理不活跃实例
- 提供 RESTful API 接口
- 支持 WebSocket 连接

## 系统要求

- Node.js 16.0 或更高版本
- Chrome 浏览器
- 操作系统：Windows/Linux/macOS

## 安装

1. 克隆仓库：
```bash
git clone https://github.com/yattin/browser-go.git
cd browser-go
```

2. 安装依赖：
```bash
npm install
```

## 使用方法

### 启动服务

```bash
node cli.js [选项]
```

### 命令行选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--max-instances=<number>` | 最大并发实例数 | 10 |
| `--instance-timeout=<minutes>` | 实例超时时间（分钟） | 60 |
| `--inactive-check-interval=<minutes>` | 检查不活跃实例的间隔（分钟） | 5 |
| `--token=<string>` | 访问令牌 | 'browser-go-token' |
| `--help` | 显示帮助信息 | - |

### 示例

```bash
# 使用默认配置启动
node cli.js

# 自定义配置启动
node cli.js --max-instances=5 --instance-timeout=30 --inactive-check-interval=2

# 设置自定义访问令牌
node cli.js --token=my-secret-token
```

## API 接口

### 1. 启动浏览器实例

通过 WebSocket 连接启动浏览器实例：

支持两种 URL 格式：

1. 查询字符串格式：
```
ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
```

2. 路径格式：
```
ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
```

参数说明：
- `token`: 访问令牌
- `startingUrl`: 浏览器启动后访问的URL（注意在路径格式中需要进行 URL 编码）
- `launch`: JSON格式的启动参数（可选，仅支持作为查询参数传递）
  ```json
  {
    "user": "user123",  // 用户标识，用于会话持久化
    "args": ["--window-size=1920,1080", "--lang=en-US"]  // Chrome启动参数
  }
  ```

### 2. 停止浏览器实例

```
GET /api/v1/browser/stop?user_id=<user_id>
```

### 3. 列出所有实例

```
GET /api/v1/browser/list
```

### 4. 查看系统状态

```
GET /api/v1/browser/stats
```

## 配置说明

### 最大并发实例数

控制同时运行的最大浏览器实例数量。当达到限制时，新的连接请求将被拒绝。

### 实例超时时间

浏览器实例在无活动状态下的最大存活时间。超过此时间后，实例将被自动关闭。

### 检查间隔

系统检查不活跃实例的时间间隔。建议根据实际使用情况调整此值。

### 访问令牌

用于验证客户端请求的令牌。建议在生产环境中使用强随机值。

## 注意事项

1. 确保系统有足够的内存运行多个Chrome实例
2. 建议在生产环境中使用反向代理（如Nginx）进行负载均衡
3. 定期检查日志文件，监控系统运行状态
4. 根据实际需求调整配置参数

## 开发

### 项目结构

```
browser-go/
├── cli.js          # 主程序入口
├── logger.js       # 日志模块
├── package.json    # 项目配置
└── README.md       # 项目文档
```

### 依赖项

- express: Web服务器框架
- chrome-launcher: Chrome浏览器启动器
- http-proxy: HTTP代理
- axios: HTTP客户端

## 许可证

MIT License 