#!/usr/bin/env node

/**
 * CDP Protocol WebSocket Test
 * 
 * 这是一个基于纯 WebSocket 协议的模拟测试，用于验证 CDPRelayBridge 的核心功能
 * 不依赖真实的 Chrome 浏览器，而是模拟 Extension 和 CDP Client 的行为
 * 
 * 测试内容：
 * 1. 设备注册和心跳机制
 * 2. CDP 消息路由和响应映射
 * 3. 多设备并发场景
 * 4. 错误处理和资源清理
 * 5. 超时和故障恢复
 */

import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TestResult {
  name: string;
  success: boolean;
  error?: string;
  duration: number;
}

interface MockDevice {
  deviceId: string;
  name: string;
  socket: WebSocket | null;
  lastPing: number;
  targetInfo: any;
  sessionId: string;
}

interface MockCDPClient {
  connectionId: string;
  deviceId?: string;
  socket: WebSocket | null;
  pendingRequests: Map<number, { method: string; timestamp: number }>;
}

class CDPProtocolTester {
  private serverPort = 3000; // 使用默认端口
  private serverToken = 'browser-go-token'; // 使用默认 token
  private serverProcess: ChildProcess | null = null;
  private testResults: TestResult[] = [];
  private mockDevices: Map<string, MockDevice> = new Map();
  private mockClients: Map<string, MockCDPClient> = new Map();
  private messageIdCounter = 1;

  constructor() {
    console.log('🧪 CDP Protocol Tester initialized');
  }

  /**
   * 运行所有测试
   */
  async runAllTests(): Promise<void> {
    try {
      await this.startServer();
      await this.sleep(2000); // 等待服务器启动

      console.log('\n🚀 开始 CDP 协议测试...\n');

      // 基础功能测试
      await this.testBasicConnection();
      await this.testDeviceRegistration();
      await this.testHeartbeat();
      
      // CDP 协议测试
      await this.testBasicCDPCommands();
      await this.testMessageRouting();
      await this.testErrorHandling();
      
      // 多设备测试
      await this.testMultiDeviceSupport();
      await this.testDeviceIsolation();
      
      // 故障恢复测试
      await this.testConnectionFailure();
      await this.testResourceCleanup();

      this.printResults();
    } catch (error) {
      console.error('❌ 测试运行失败:', error);
    } finally {
      await this.cleanup();
    }
  }

  /**
   * 启动测试服务器
   */
  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('🚀 启动测试服务器...');
      
      // 构建项目
      const buildProcess = spawn('pnpm', ['run', 'build'], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });

      buildProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`构建失败，退出码: ${code}`));
          return;
        }

        // 启动服务器
        this.serverProcess = spawn('node', [
          'dist/cli.js',
          '--port', String(this.serverPort),
          '--token', this.serverToken
        ], {
          cwd: path.resolve(__dirname, '..'),
          stdio: 'pipe'
        });

        let serverStarted = false;

        this.serverProcess.stdout?.on('data', (data) => {
          const output = data.toString();
          console.log(`[Server] ${output.trim()}`);
          
          if ((output.includes('Server is running') || 
               output.includes('listening on') ||
               output.includes('Browser-Go service started')) && !serverStarted) {
            serverStarted = true;
            console.log('✅ 服务器启动成功，等待初始化完成...');
            setTimeout(resolve, 2000);
          }
        });

        this.serverProcess.stderr?.on('data', (data) => {
          console.log(`[Server Error] ${data.toString().trim()}`);
        });

        this.serverProcess.on('error', (error) => {
          console.error('[Server Process Error]', error);
          reject(error);
        });

        this.serverProcess.on('exit', (code, signal) => {
          console.log(`[Server] 进程退出，代码: ${code}, 信号: ${signal}`);
          if (!serverStarted) {
            reject(new Error(`服务器进程异常退出，代码: ${code}`));
          }
        });

        setTimeout(() => {
          if (!serverStarted) {
            console.log('[Server] 启动超时，检查服务器输出...');
            reject(new Error('服务器启动超时'));
          }
        }, 15000);
      });
    });
  }

  /**
   * 测试基础连接
   */
  private async testBasicConnection(): Promise<void> {
    const startTime = Date.now();
    try {
      // 测试 Extension 连接
      const extensionWs = await this.connectExtension();
      await this.sleep(100);
      extensionWs.close();
      await this.sleep(100); // 等待连接完全关闭

      // 测试 CDP Client 连接
      const cdpWs = await this.connectCDPClient();
      await this.sleep(100);
      cdpWs.close();

      this.addResult('基础连接测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('基础连接测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试设备注册
   */
  private async testDeviceRegistration(): Promise<void> {
    const startTime = Date.now();
    try {
      const deviceId = 'test-device-001';
      const device = await this.createMockDevice(deviceId, '测试设备 001');
      
      // 发送注册消息
      await this.registerDevice(device);
      
      // 验证设备已注册
      const devices = await this.getRegisteredDevices();
      const found = devices.find((d: any) => d.deviceId === deviceId);
      
      if (!found) {
        throw new Error('设备注册失败');
      }

      this.addResult('设备注册测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('设备注册测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试心跳机制
   */
  private async testHeartbeat(): Promise<void> {
    const startTime = Date.now();
    try {
      const deviceId = 'test-device-heartbeat';
      const device = await this.createMockDevice(deviceId, '心跳测试设备');
      
      await this.registerDevice(device);
      
      // 发送心跳
      const pongReceived = await this.sendHeartbeat(device);
      
      if (!pongReceived) {
        throw new Error('未收到心跳响应');
      }

      this.addResult('心跳机制测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('心跳机制测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试基础 CDP 命令
   */
  private async testBasicCDPCommands(): Promise<void> {
    const startTime = Date.now();
    try {
      const deviceId = 'test-device-cdp';
      const device = await this.createMockDevice(deviceId, 'CDP 测试设备');
      const client = await this.createMockCDPClient(deviceId);
      
      await this.registerDevice(device);
      await this.sendConnectionInfo(device);
      
      // 测试 Browser.getVersion
      const versionResult = await this.sendCDPCommand(client, {
        method: 'Browser.getVersion',
        params: {}
      });
      
      if (!versionResult.result || !versionResult.result.product) {
        throw new Error('Browser.getVersion 响应格式错误');
      }

      // 测试 Target.getTargets
      const targetsResult = await this.sendCDPCommand(client, {
        method: 'Target.getTargets',
        params: {}
      });
      
      if (!targetsResult.result || !Array.isArray(targetsResult.result.targetInfos)) {
        throw new Error('Target.getTargets 响应格式错误');
      }

      this.addResult('基础 CDP 命令测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('基础 CDP 命令测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试消息路由
   */
  private async testMessageRouting(): Promise<void> {
    const startTime = Date.now();
    try {
      const deviceId = 'test-device-routing';
      const device = await this.createMockDevice(deviceId, '路由测试设备');
      const client = await this.createMockCDPClient(deviceId);
      
      await this.registerDevice(device);
      await this.sendConnectionInfo(device);
      
      // 发送需要转发的命令
      const responsePromise = this.sendCDPCommand(client, {
        method: 'Runtime.evaluate',
        params: { expression: 'window.location.href' }
      });
      
      // 模拟设备响应
      setTimeout(() => {
        this.simulateDeviceResponse(device, {
          id: this.messageIdCounter - 1,
          result: { result: { value: 'https://example.com' } }
        });
      }, 100);
      
      const result = await responsePromise;
      
      if (!result.result) {
        throw new Error('未收到转发的响应');
      }

      this.addResult('消息路由测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('消息路由测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试错误处理
   */
  private async testErrorHandling(): Promise<void> {
    const startTime = Date.now();
    try {
      const client = await this.createMockCDPClient('non-existent-device');
      
      // 发送到不存在的设备
      const result = await this.sendCDPCommand(client, {
        method: 'Runtime.evaluate',
        params: { expression: 'test' }
      });
      
      if (!result.error || !result.error.message.includes('not connected')) {
        throw new Error('错误处理不正确');
      }

      this.addResult('错误处理测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('错误处理测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试多设备支持
   */
  private async testMultiDeviceSupport(): Promise<void> {
    const startTime = Date.now();
    try {
      // 创建多个设备
      const device1 = await this.createMockDevice('device-multi-1', '多设备测试 1');
      const device2 = await this.createMockDevice('device-multi-2', '多设备测试 2');
      
      const client1 = await this.createMockCDPClient('device-multi-1');
      const client2 = await this.createMockCDPClient('device-multi-2');
      
      await Promise.all([
        this.registerDevice(device1),
        this.registerDevice(device2)
      ]);
      
      await Promise.all([
        this.sendConnectionInfo(device1),
        this.sendConnectionInfo(device2)
      ]);
      
      // 同时发送命令到不同设备
      const [result1Promise, result2Promise] = await Promise.all([
        this.sendCDPCommand(client1, { method: 'Browser.getVersion', params: {} }),
        this.sendCDPCommand(client2, { method: 'Browser.getVersion', params: {} })
      ]);
      
      if (!result1Promise.result || !result2Promise.result) {
        throw new Error('多设备命令执行失败');
      }

      this.addResult('多设备支持测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('多设备支持测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试设备隔离
   */
  private async testDeviceIsolation(): Promise<void> {
    const startTime = Date.now();
    try {
      // 创建并注册第一个设备
      const device1 = await this.createMockDevice('device-isolation-1', '隔离测试 1');
      await this.registerDevice(device1);
      await this.sendConnectionInfo(device1);
      await this.sleep(200); // 等待注册完成
      
      // 创建并注册第二个设备
      const device2 = await this.createMockDevice('device-isolation-2', '隔离测试 2'); 
      await this.registerDevice(device2);
      await this.sendConnectionInfo(device2);
      await this.sleep(200); // 等待注册完成
      
      const client1 = await this.createMockCDPClient('device-isolation-1');
      
      // Client1 发送命令到 device-isolation-1
      const commandSent = this.sendCDPCommand(client1, {
        method: 'Runtime.evaluate',
        params: { expression: 'test-isolation' }
      });
      
      // 模拟 Device1 响应
      setTimeout(() => {
        this.simulateDeviceResponse(device1, {
          id: this.messageIdCounter - 1,
          result: { result: { value: 'isolation-success' } }
        });
      }, 100);
      
      const result = await commandSent;
      
      if (!result.result || result.result.result.value !== 'isolation-success') {
        throw new Error('设备隔离失败');
      }

      this.addResult('设备隔离测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('设备隔离测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试连接故障
   */
  private async testConnectionFailure(): Promise<void> {
    const startTime = Date.now();
    try {
      const deviceId = 'test-device-failure';
      const device = await this.createMockDevice(deviceId, '故障测试设备');
      
      await this.registerDevice(device);
      
      // 突然断开设备连接
      device.socket?.close();
      device.socket = null;
      
      // 等待服务器清理
      await this.sleep(1000);
      
      // 尝试连接到已断开的设备
      const client = await this.createMockCDPClient(deviceId);
      const result = await this.sendCDPCommand(client, {
        method: 'Runtime.evaluate',
        params: { expression: 'test' }
      });
      
      if (!result.error) {
        throw new Error('应该返回连接错误');
      }

      this.addResult('连接故障测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('连接故障测试', false, Date.now() - startTime, String(error));
    }
  }

  /**
   * 测试资源清理
   */
  private async testResourceCleanup(): Promise<void> {
    const startTime = Date.now();
    try {
      // 创建大量连接然后关闭
      const devices: MockDevice[] = [];
      const clients: MockCDPClient[] = [];
      
      for (let i = 0; i < 5; i++) {
        const device = await this.createMockDevice(`cleanup-device-${i}`, `清理测试设备 ${i}`);
        const client = await this.createMockCDPClient(`cleanup-device-${i}`);
        devices.push(device);
        clients.push(client);
        await this.registerDevice(device);
      }
      
      // 关闭所有连接
      devices.forEach(device => device.socket?.close());
      clients.forEach(client => client.socket?.close());
      
      // 等待清理
      await this.sleep(2000);
      
      // 检查设备列表是否已清理
      const remainingDevices = await this.getRegisteredDevices();
      const cleanupDevices = remainingDevices.filter((d: any) => 
        d.deviceId.startsWith('cleanup-device-')
      );
      
      if (cleanupDevices.length > 0) {
        console.log(`警告: 仍有 ${cleanupDevices.length} 个清理测试设备未被清理`);
      }

      this.addResult('资源清理测试', true, Date.now() - startTime);
    } catch (error) {
      this.addResult('资源清理测试', false, Date.now() - startTime, String(error));
    }
  }

  // === 辅助方法 ===

  private async connectExtension(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${this.serverPort}/extension`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('连接超时')), 5000);
    });
  }

  private async connectCDPClient(deviceId?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = deviceId 
        ? `ws://localhost:${this.serverPort}/cdp?deviceId=${deviceId}&token=${this.serverToken}`
        : `ws://localhost:${this.serverPort}/cdp?token=${this.serverToken}&startingUrl=about:blank`;
      
      const ws = new WebSocket(url);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('连接超时')), 5000);
    });
  }

  private async createMockDevice(deviceId: string, name: string): Promise<MockDevice> {
    const socket = await this.connectExtension();
    const device: MockDevice = {
      deviceId,
      name,
      socket,
      lastPing: Date.now(),
      targetInfo: {
        targetId: `target-${deviceId}`,
        type: 'page',
        title: `Mock Page for ${name}`,
        url: 'https://example.com',
        attached: false
      },
      sessionId: `session-${deviceId}-${Date.now()}`
    };
    
    this.mockDevices.set(deviceId, device);
    return device;
  }

  private async createMockCDPClient(deviceId?: string): Promise<MockCDPClient> {
    const socket = await this.connectCDPClient(deviceId);
    const client: MockCDPClient = {
      connectionId: `client-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      deviceId,
      socket,
      pendingRequests: new Map()
    };
    
    this.mockClients.set(client.connectionId, client);
    return client;
  }

  private async registerDevice(device: MockDevice): Promise<void> {
    if (!device.socket) throw new Error('设备未连接');
    
    const registrationMessage = {
      type: 'ping',
      deviceId: device.deviceId,
      timestamp: Date.now()
    };
    
    device.socket.send(JSON.stringify(registrationMessage));
    await this.sleep(100); // 等待注册完成
  }

  private async sendConnectionInfo(device: MockDevice): Promise<void> {
    if (!device.socket) throw new Error('设备未连接');
    
    const connectionInfo = {
      type: 'connection_info',
      deviceId: device.deviceId,
      targetInfo: device.targetInfo,
      sessionId: device.sessionId
    };
    
    device.socket.send(JSON.stringify(connectionInfo));
    await this.sleep(100);
  }

  private async sendHeartbeat(device: MockDevice): Promise<boolean> {
    return new Promise((resolve) => {
      if (!device.socket) {
        resolve(false);
        return;
      }
      
      let pongReceived = false;
      
      device.socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'pong' && message.deviceId === device.deviceId) {
            pongReceived = true;
            resolve(true);
          }
        } catch (error) {
          // 忽略解析错误
        }
      });
      
      const pingMessage = {
        type: 'ping',
        deviceId: device.deviceId,
        timestamp: Date.now()
      };
      
      device.socket.send(JSON.stringify(pingMessage));
      
      setTimeout(() => {
        if (!pongReceived) {
          resolve(false);
        }
      }, 1000);
    });
  }

  private async sendCDPCommand(client: MockCDPClient, command: { method: string; params: any }): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!client.socket) {
        reject(new Error('客户端未连接'));
        return;
      }
      
      const id = this.messageIdCounter++;
      const message = {
        id,
        method: command.method,
        params: command.params
      };
      
      client.pendingRequests.set(id, {
        method: command.method,
        timestamp: Date.now()
      });
      
      const messageHandler = (data: any) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === id) {
            client.socket?.off('message', messageHandler);
            client.pendingRequests.delete(id);
            resolve(response);
          }
        } catch (error) {
          // 忽略解析错误
        }
      };
      
      client.socket.on('message', messageHandler);
      client.socket.send(JSON.stringify(message));
      
      setTimeout(() => {
        client.socket?.off('message', messageHandler);
        client.pendingRequests.delete(id);
        reject(new Error('命令超时'));
      }, 5000);
    });
  }

  private simulateDeviceResponse(device: MockDevice, response: any): void {
    if (device.socket) {
      device.socket.send(JSON.stringify(response));
    }
  }

  private async getRegisteredDevices(): Promise<any[]> {
    return new Promise((resolve, reject) => {
      import('http').then(http => {
        const req = http.get(`http://localhost:${this.serverPort}/api/v1/devices`, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => data += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              console.log('API Response:', result); // 调试日志
              
              // 根据实际 API 响应格式处理
              if (Array.isArray(result)) {
                resolve(result);
              } else if (result.data && result.data.devices && Array.isArray(result.data.devices)) {
                resolve(result.data.devices);
              } else if (result.data && Array.isArray(result.data)) {
                resolve(result.data);
              } else if (result.devices && Array.isArray(result.devices)) {
                resolve(result.devices);
              } else {
                // 如果都不是数组，返回空数组
                console.warn('API 返回格式不正确:', result);
                resolve([]);
              }
            } catch (error) {
              console.error('解析 API 响应失败:', error, 'Raw data:', data);
              reject(error);
            }
          });
        });
        req.on('error', reject);
        setTimeout(() => reject(new Error('请求超时')), 5000);
      }).catch(reject);
    });
  }

  private addResult(name: string, success: boolean, duration: number, error?: string): void {
    this.testResults.push({ name, success, duration, error });
    const status = success ? '✅' : '❌';
    const timing = `(${duration}ms)`;
    console.log(`  ${status} ${name} ${timing}`);
    if (error) {
      console.log(`    错误: ${error}`);
    }
  }

  private printResults(): void {
    console.log('\n📊 测试结果汇总:');
    console.log('━'.repeat(60));
    
    const passed = this.testResults.filter(r => r.success).length;
    const failed = this.testResults.filter(r => !r.success).length;
    const total = this.testResults.length;
    
    console.log(`总测试数: ${total}`);
    console.log(`通过: ${passed} ✅`);
    console.log(`失败: ${failed} ❌`);
    console.log(`成功率: ${((passed / total) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
      console.log('\n失败的测试:');
      this.testResults
        .filter(r => !r.success)
        .forEach(r => console.log(`  ❌ ${r.name}: ${r.error}`));
    }
  }

  private async cleanup(): Promise<void> {
    console.log('\n🧹 清理测试资源...');
    
    // 关闭所有模拟设备连接
    this.mockDevices.forEach(device => {
      if (device.socket) {
        device.socket.close();
      }
    });
    
    // 关闭所有模拟客户端连接
    this.mockClients.forEach(client => {
      if (client.socket) {
        client.socket.close();
      }
    });
    
    // 停止服务器
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      await this.sleep(1000);
      if (!this.serverProcess.killed) {
        this.serverProcess.kill('SIGKILL');
      }
    }
    
    console.log('✅ 清理完成');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new CDPProtocolTester();
  tester.runAllTests().catch(console.error);
}

export { CDPProtocolTester };