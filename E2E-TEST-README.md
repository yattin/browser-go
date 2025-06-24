# Complete E2E Test for CDP Bridge

这是一个完整的端到端测试套件，用于验证 CDP Bridge 的所有核心功能，包括：

## 测试覆盖范围

### 🚀 服务器和基础设施
- ✅ 服务器启动和健康检查
- ✅ Chrome 扩展加载和初始化
- ✅ 设备注册和连接管理

### 🔗 CDP 连接和路由
- ✅ CDP 客户端连接
- ✅ 设备路由机制
- ✅ 消息转发和处理

### 🌐 CDP 协议支持
- ✅ Browser domain 方法 (本地处理)
- ✅ Target domain 方法 (本地处理)
- ✅ 其他 CDP 命令转发到扩展

### 🚨 错误处理
- ✅ 错误消息类型识别
- ✅ -32000 错误特殊处理
- ✅ 独立错误消息处理
- ✅ WebSocket 连接错误

### 📝 消息处理
- ✅ 消息类型识别 (method, error_response, standalone_error)
- ✅ 参数验证和类型检查
- ✅ 消息转发逻辑

## 运行方式

### 前提条件
1. 确保项目已构建：`pnpm run build`
2. 确保没有其他服务占用 3000 端口
3. 确保 Chrome 浏览器已安装

### 运行完整 E2E 测试
```bash
# 运行完整的 E2E 测试套件
pnpm run test:e2e:script
```

## 测试流程

### 1. 自动化服务器启动
- 构建项目
- 启动 browser-go 服务器 (端口 3000)
- 等待服务器就绪

### 2. Chrome 扩展加载
- 启动 Chrome 浏览器
- 自动加载 `extension/` 目录下的扩展
- 等待扩展初始化和自动连接

### 3. 设备注册验证
- 检查扩展设备注册状态
- 验证设备信息和连接状态
- 通过 `/api/v1/devices` API 获取设备列表

### 4. CDP 连接测试
- 使用 Playwright 连接到 CDP bridge
- 测试基本导航功能
- 验证连接稳定性

### 5. 协议功能测试
- **Browser Domain**: 测试 `Browser.getVersion` 等本地方法
- **Target Domain**: 测试 `Target.getTargets` 等目标管理方法
- **消息类型**: 测试各种 CDP 消息的处理

### 6. 错误处理测试
- 发送无效命令测试错误响应
- 验证错误消息格式和代码
- 测试连接中断处理

## 测试结果

测试完成后会显示详细的结果摘要：

```
📊 Test Results Summary:
========================
✅ PASS Server Startup
✅ PASS Server Health Check  
✅ PASS Chrome with Extension Launch
✅ PASS Device Registration
✅ PASS CDP Connection
✅ PASS Error Handling
✅ PASS Browser Domain Methods
✅ PASS Target Domain Methods
✅ PASS Message Type Identification

Overall: 9/9 tests passed
🎉 All tests passed! CDP Bridge is working correctly.
```

## 故障排除

### 常见问题

#### 服务器启动失败
- 检查端口 3000 是否被占用
- 确保项目构建成功
- 检查权限问题

#### 设备注册失败
- 确保扩展正确加载
- 检查 Chrome 扩展权限
- 查看扩展控制台错误

#### CDP 连接失败
- 确保设备已注册
- 检查 WebSocket 连接
- 验证路由配置

#### Chrome 启动问题
- 确保 Chrome 已安装且可执行
- 检查扩展路径是否正确
- 查看 Chrome 启动参数

### 调试模式

E2E 测试脚本会自动显示详细的服务器日志和测试过程信息。如需更多调试信息，可以查看：
- 服务器实时日志输出
- 测试进度和结果摘要  
- 错误详情和故障排除提示

这将显示：
- 服务器详细日志
- WebSocket 消息内容
- CDP 命令和响应
- 扩展连接状态

## 架构验证

这个 E2E 测试验证了完整的架构流程：

```
[CDP Client] ←→ [browser-go Server] ←→ [Chrome Extension] ←→ [Chrome Browser]
     ↑                    ↑                      ↑               ↑
  Playwright        CDP Bridge            background.js      实际浏览器
   测试客户端         消息路由               设备代理          目标环境
```

通过这个测试，我们可以确保：
- 整个消息链路正常工作
- 错误处理机制正确
- 设备路由功能稳定
- 协议兼容性良好

## 持续集成

这个测试可以集成到 CI/CD 流程中：

```yaml
# GitHub Actions 示例
- name: Run E2E Tests
  run: |
    pnpm install
    pnpm run build
    pnpm run test:e2e:script
```

注意：CI 环境可能需要 headless Chrome 配置调整。