# CDP 协议日志记录功能使用指南

## 概述

CDP 桥接模式新增了详细的协议数据日志记录功能，可帮助开发者分析和调试 Chrome DevTools Protocol 通信过程。

## 启用 CDP 日志

### 命令行启用

启动服务时添加 `--cdp-logging` 参数：

```bash
# 启用 CDP 详细日志
node dist/cli.js --cdp-logging

# 结合其他参数使用
node dist/cli.js --cdp-logging --port=3000 --token=debug-token
```

### 默认行为

- **不启用时**：只记录基本的消息类型和方向
- **启用时**：记录完整的协议数据，包括消息内容、大小、时间戳等详细信息

## 日志格式说明

### 基本日志格式

所有 CDP 消息都会以以下格式记录：

```
[timestamp] [info]: → Source → Target: MessageType
```

例如：
```
[2025-06-25 09:49:14.376] [info]: ← CDP Client → Bridge(device-123): Page.navigate
[2025-06-25 09:49:14.377] [info]: → Bridge(device-123) → Extension(device-123): Page.navigate
```

### 详细协议日志格式（启用 --cdp-logging 时）

启用详细日志后，每条消息会包含：

```
[CDP-PROTOCOL] 2025-06-25T01:49:14.376Z ← CDP Client → Bridge(device-123):
[CDP-PROTOCOL] Message Size: 156 bytes
[CDP-PROTOCOL] Full Message: {
  "id": 1,
  "method": "Page.navigate",
  "params": {
    "url": "https://example.com"
  }
}
[CDP-PROTOCOL] Domain: Page, Method: Page.navigate
[CDP-PROTOCOL] Parameters: {
  "url": "https://example.com"
}
[CDP-PROTOCOL] ----------------------------------------
```

### 错误消息日志格式

错误响应会记录额外的错误信息：

```
[CDP-PROTOCOL] Error Code: -32000
[CDP-PROTOCOL] Error Message: Another debugger is already attached
[CDP-PROTOCOL] Error Data: {
  "details": "Extension conflict detected"
}
```

## 消息流向说明

日志中的消息流向使用以下标识：

- `← CDP Client → Bridge(device-id)`: CDP 客户端发送到桥接服务
- `→ Bridge(device-id) → Extension(device-id)`: 桥接服务转发到扩展
- `← Extension(device-id) → Bridge`: 扩展发送到桥接服务  
- `→ Bridge(device-id) → CDP Client(device-id)`: 桥接服务转发到 CDP 客户端

## 日志分析建议

### 性能分析

1. **消息大小监控**：关注 `Message Size` 来识别大型数据传输
2. **时间戳分析**：通过时间戳计算消息处理延迟
3. **错误频率**：统计错误代码出现频率，识别常见问题

### 调试技巧

1. **过滤特定域**：使用 `grep` 过滤特定 CDP 域
   ```bash
   tail -f ~/.browser-go/logs/browser-go-*.log | grep "Domain: Page"
   ```

2. **监控特定设备**：过滤特定设备的消息
   ```bash
   tail -f ~/.browser-go/logs/browser-go-*.log | grep "device-123"
   ```

3. **错误追踪**：快速定位错误消息
   ```bash
   tail -f ~/.browser-go/logs/browser-go-*.log | grep "Error Code"
   ```

## 日志文件位置

日志文件保存在：
- 路径：`~/.browser-go/logs/`
- 格式：`browser-go-YYYY-MM-DD.log`
- 保留：10 天
- 大小限制：每文件 10MB

## 性能影响

启用详细 CDP 日志会对性能产生一定影响：

- **CPU 开销**：消息序列化和格式化
- **磁盘 I/O**：增加日志写入量
- **内存使用**：临时存储格式化数据

建议仅在调试时启用，生产环境可关闭此功能。

## 使用场景

### 开发调试

- 分析 Playwright/Puppeteer 与扩展的通信过程
- 排查 CDP 命令执行失败的原因
- 优化消息传输效率

### 问题排查

- 调试扩展连接问题
- 分析设备注册流程
- 追踪消息路由错误

### 性能优化

- 识别高频消息类型
- 监控消息传输延迟
- 分析带宽使用情况