# browser-go

一个基于Node.js的Chrome浏览器管理服务，可以通过WebSocket启动和管理多个Chrome浏览器实例。

## 功能特性

- 通过WebSocket启动Chrome浏览器实例
- 支持多用户隔离（每个用户有自己的浏览器数据目录）
- 提供REST API管理浏览器实例
- 支持自定义Chrome启动参数
- 并发实例数量限制，防止资源耗尽
- 自动清理不活跃实例

## 安装步骤

1. 确保已安装Node.js (>=16.x)
2. 克隆项目仓库
3. 安装依赖：
```bash
npm install
```
4. 创建.env文件并配置环境变量：
```env
TOKEN=your_secret_token
MAX_INSTANCES=10
INSTANCE_TIMEOUT_MS=3600000
INACTIVE_CHECK_INTERVAL=300000
```

## 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| TOKEN | 认证令牌 | 必填 |
| MAX_INSTANCES | 最大并发浏览器实例数 | 10 |
| INSTANCE_TIMEOUT_MS | 实例超时时间（毫秒） | 3600000 (1小时) |
| INACTIVE_CHECK_INTERVAL | 检查不活跃实例的间隔（毫秒） | 300000 (5分钟) |

## 使用方法

1. 启动服务：
```bash
npm start
```
2. 通过WebSocket连接服务：
```
ws://localhost:3000/?token=your_token&startingUrl=https://example.com
```

## API文档

### 停止浏览器实例
- `GET /api/v1/browser/stop`
- 参数：
  - `user_id`: 环境ID
- 成功响应：
```json
{
  "code": 0,
  "msg": "success"
}
```

### 列出浏览器实例
- `GET /api/v1/browser/list`
- 成功响应：
```json
{
  "code": 0,
  "data": [
    {
      "user_id": "user1",
      "last_activity": "2023-05-01T12:34:56.789Z",
      "idle_time_seconds": 120
    }
  ],
  "stats": {
    "current_instances": 1,
    "max_instances": 10,
    "instance_timeout_ms": 3600000
  },
  "msg": "success"
}
```

### 查看系统状态
- `GET /api/v1/browser/stats`
- 成功响应：
```json
{
  "code": 0,
  "data": {
    "current_instances": 1,
    "max_instances": 10,
    "available_slots": 9,
    "instance_timeout_ms": 3600000,
    "inactive_check_interval": 300000
  },
  "msg": "success"
}
```

## 资源限制说明

- 当达到最大实例数量限制时，新的连接请求会收到 `503 Service Unavailable` 错误
- 连续不活跃超过 `INSTANCE_TIMEOUT_MS` 的实例会被自动清理
- 系统会定期（每 `INACTIVE_CHECK_INTERVAL` 毫秒）检查并清理不活跃实例

## 测试

运行测试：
```bash
npm test
```

## 依赖项

- express
- chrome-launcher
- axios
- http-proxy
- ws
- dotenv