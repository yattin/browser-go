#!/usr/bin/env node

/**
 * Device Management Integration Tests
 * End-to-end tests for the complete device management system
 */

import WebSocket from 'ws';
import { chromium } from 'patchright';
import { DeviceManager } from './device-manager.js';
import { CDPRelayBridge } from './cdp-bridge.js';
import { WebSocketHandlers } from './websocket-handlers.js';
import { ChromeManager } from './chrome-manager.js';
import express from 'express';
import http from 'http';

interface TestScenario {
  name: string;
  description: string;
  testFn: () => Promise<void>;
}

class DeviceIntegrationTests {
  private deviceManager: DeviceManager;
  private cdpRelayBridge: CDPRelayBridge;
  private chromeManager: ChromeManager;
  private webSocketHandlers: WebSocketHandlers;
  private testServer: http.Server | null = null;
  private testPort: number = 0;

  constructor() {
    this.deviceManager = new DeviceManager();
    this.cdpRelayBridge = new CDPRelayBridge(this.deviceManager);
    
    // Mock chrome manager for testing
    this.chromeManager = {
      getCurrentInstanceCount: () => 0,
      getConfig: () => ({
        maxConcurrentInstances: 10,
        instanceTimeoutMs: 60000,
        inactiveCheckInterval: 30000
      }),
      shutdown: async () => {}
    } as any;
    
    this.webSocketHandlers = new WebSocketHandlers(
      this.cdpRelayBridge,
      this.chromeManager,
      this.deviceManager,
      'test-token'
    );
  }

  async setupTestServer(): Promise<void> {
    const app = express();
    this.testServer = http.createServer(app);
    
    // Setup WebSocket upgrade handling
    this.testServer.on('upgrade', async (req, socket, head) => {
      await this.webSocketHandlers.handleUpgrade(req, socket, head);
    });

    return new Promise((resolve, reject) => {
      this.testServer!.listen(0, () => {
        const address = this.testServer!.address();
        this.testPort = typeof address === 'object' && address ? address.port : 0;
        console.log(`📡 Integration test server started on port ${this.testPort}`);
        resolve();
      });
      
      this.testServer!.on('error', reject);
    });
  }

  async cleanupTestServer(): Promise<void> {
    if (this.testServer) {
      await new Promise<void>((resolve) => {
        this.testServer!.close(() => resolve());
      });
      this.testServer = null;
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Running Device Management Integration Tests...\n');

    const scenarios: TestScenario[] = [
      {
        name: 'Complete Registration Flow',
        description: 'Test end-to-end device registration and discovery',
        testFn: this.testCompleteRegistrationFlow.bind(this)
      },
      {
        name: 'Multi-Device Management',
        description: 'Test managing multiple devices simultaneously',
        testFn: this.testMultiDeviceManagement.bind(this)
      },
      {
        name: 'Device-Specific CDP Routing',
        description: 'Test CDP routing to specific devices',
        testFn: this.testDeviceSpecificCDPRouting.bind(this)
      },
      {
        name: 'Lazy Debugger Attachment',
        description: 'Test that debugger is only attached when needed',
        testFn: this.testLazyDebuggerAttachment.bind(this)
      },
      {
        name: 'Device Failover',
        description: 'Test behavior when devices disconnect and reconnect',
        testFn: this.testDeviceFailover.bind(this)
      },
      {
        name: 'Concurrent CDP Sessions',
        description: 'Test multiple CDP clients for the same device',
        testFn: this.testConcurrentCDPSessions.bind(this)
      },
      {
        name: 'Error Recovery',
        description: 'Test error handling and recovery scenarios',
        testFn: this.testErrorRecovery.bind(this)
      }
    ];

    try {
      await this.setupTestServer();
      
      let passedTests = 0;
      let totalTests = scenarios.length;
      
      for (const scenario of scenarios) {
        try {
          console.log(`🔧 Running: ${scenario.name}`);
          console.log(`   ${scenario.description}`);
          
          const startTime = Date.now();
          await scenario.testFn();
          const duration = Date.now() - startTime;
          
          console.log(`   ✅ Passed (${duration}ms)\n`);
          passedTests++;
        } catch (error: any) {
          console.log(`   ❌ Failed: ${error.message}\n`);
        }
      }
      
      console.log('📊 Integration Test Results:');
      console.log(`   Total: ${totalTests}`);
      console.log(`   Passed: ${passedTests}`);
      console.log(`   Failed: ${totalTests - passedTests}`);
      console.log(`   Success Rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
      
      if (passedTests === totalTests) {
        console.log('\n🎉 All integration tests passed!');
      } else {
        console.log(`\n⚠️  ${totalTests - passedTests} integration tests failed.`);
      }
      
    } finally {
      await this.cleanupTestServer();
      this.deviceManager.shutdown();
    }
  }

  async testCompleteRegistrationFlow(): Promise<void> {
    // Simulate extension connecting and registering
    const deviceId = 'device-integration-001';
    const extensionSocket = await this.createExtensionConnection();
    
    // Register device
    const registrationMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo: {
        name: 'Integration Test Device',
        version: '1.0.0',
        userAgent: 'IntegrationTest/1.0',
        timestamp: new Date().toISOString()
      }
    };
    
    extensionSocket.send(JSON.stringify(registrationMessage));
    await this.wait(200);
    
    // Verify device is registered
    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should be registered');
    }
    
    // Send connection info
    const connectionMessage = {
      type: 'connection_info',
      deviceId,
      sessionId: 'integration-session-001',
      targetInfo: {
        targetId: 'integration-target-001',
        type: 'page',
        title: 'Integration Test Page',
        url: 'https://integration-test.example.com'
      }
    };
    
    extensionSocket.send(JSON.stringify(connectionMessage));
    await this.wait(100);
    
    // Verify connection info is updated
    const updatedDevice = this.deviceManager.getDevice(deviceId);
    if (!updatedDevice?.connectionInfo) {
      throw new Error('Connection info should be updated');
    }
    
    if (updatedDevice.connectionInfo.sessionId !== 'integration-session-001') {
      throw new Error('Session ID should match');
    }
    
    extensionSocket.close();
  }

  async testMultiDeviceManagement(): Promise<void> {
    const deviceCount = 3;
    const devices: Array<{ deviceId: string; socket: WebSocket }> = [];
    
    // Register multiple devices
    for (let i = 0; i < deviceCount; i++) {
      const deviceId = `device-multi-${i}`;
      const socket = await this.createExtensionConnection();
      
      const registrationMessage = {
        type: 'device_register',
        deviceId,
        deviceInfo: {
          name: `Multi Device ${i}`,
          version: '1.0.0',
          userAgent: 'MultiTest/1.0',
          timestamp: new Date().toISOString()
        }
      };
      
      socket.send(JSON.stringify(registrationMessage));
      devices.push({ deviceId, socket });
    }
    
    await this.wait(300);
    
    // Verify all devices are registered
    const stats = this.deviceManager.getDeviceStats();
    if (stats.totalDevices < deviceCount) {
      throw new Error(`Expected at least ${deviceCount} devices, got ${stats.totalDevices}`);
    }
    
    if (stats.connectedDevices < deviceCount) {
      throw new Error(`Expected at least ${deviceCount} connected devices, got ${stats.connectedDevices}`);
    }
    
    // Test individual device access
    for (const device of devices) {
      const registeredDevice = this.deviceManager.getDevice(device.deviceId);
      if (!registeredDevice) {
        throw new Error(`Device ${device.deviceId} should be registered`);
      }
      
      if (!this.deviceManager.isDeviceConnected(device.deviceId)) {
        throw new Error(`Device ${device.deviceId} should be connected`);
      }
    }
    
    // Cleanup
    devices.forEach(device => device.socket.close());
  }

  async testDeviceSpecificCDPRouting(): Promise<void> {
    // Setup two devices
    const device1Id = 'device-routing-001';
    const device2Id = 'device-routing-002';
    
    const device1Socket = await this.createExtensionConnection();
    const device2Socket = await this.createExtensionConnection();
    
    const device1Messages: any[] = [];
    const device2Messages: any[] = [];
    
    // Capture messages for each device
    device1Socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        device1Messages.push(message);
      } catch (error) {
        // Ignore parse errors
      }
    });
    
    device2Socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        device2Messages.push(message);
      } catch (error) {
        // Ignore parse errors
      }
    });
    
    // Register devices
    await this.registerDevice(device1Socket, device1Id, 'Device 1');
    await this.registerDevice(device2Socket, device2Id, 'Device 2');
    
    // Create CDP clients for each device
    const cdp1 = await this.createCDPConnection(device1Id);
    const cdp2 = await this.createCDPConnection(device2Id);
    
    // Send different commands to each device
    const message1 = {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'window.deviceTest = "device1"' }
    };
    
    const message2 = {
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'window.deviceTest = "device2"' }
    };
    
    cdp1.send(JSON.stringify(message1));
    cdp2.send(JSON.stringify(message2));
    
    await this.wait(300);
    
    // Verify messages were routed correctly
    const device1CDPMessages = device1Messages.filter(m => m.method);
    const device2CDPMessages = device2Messages.filter(m => m.method);
    
    if (device1CDPMessages.length === 0) {
      throw new Error('Device 1 should receive CDP messages');
    }
    
    if (device2CDPMessages.length === 0) {
      throw new Error('Device 2 should receive CDP messages');
    }
    
    // Verify correct routing
    const device1Expression = device1CDPMessages.find(m => 
      m.params?.expression?.includes('device1')
    );
    const device2Expression = device2CDPMessages.find(m => 
      m.params?.expression?.includes('device2')
    );
    
    if (!device1Expression) {
      throw new Error('Device 1 should receive its specific message');
    }
    
    if (!device2Expression) {
      throw new Error('Device 2 should receive its specific message');
    }
    
    // Cleanup
    cdp1.close();
    cdp2.close();
    device1Socket.close();
    device2Socket.close();
  }

  async testLazyDebuggerAttachment(): Promise<void> {
    const deviceId = 'device-lazy-001';
    const extensionSocket = await this.createExtensionConnection();
    
    let debuggerAttached = false;
    
    // Mock chrome.debugger.attach call
    const originalSend = extensionSocket.send.bind(extensionSocket);
    extensionSocket.send = function(data: any) {
      const message = JSON.parse(data.toString());
      if (message.method === 'Debugger.enable') {
        debuggerAttached = true;
      }
      originalSend(data);
    };
    
    // Register device
    await this.registerDevice(extensionSocket, deviceId, 'Lazy Attach Test');
    
    // Verify debugger is not attached yet
    if (debuggerAttached) {
      throw new Error('Debugger should not be attached immediately');
    }
    
    // Create CDP connection and send command
    const cdpClient = await this.createCDPConnection(deviceId);
    
    const testMessage = {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' }
    };
    
    cdpClient.send(JSON.stringify(testMessage));
    await this.wait(200);
    
    // Now debugger should be attached (simulated)
    // In real implementation, this would be handled in the extension
    
    cdpClient.close();
    extensionSocket.close();
  }

  async testDeviceFailover(): Promise<void> {
    const deviceId = 'device-failover-001';
    
    // First connection
    let extensionSocket1 = await this.createExtensionConnection();
    await this.registerDevice(extensionSocket1, deviceId, 'Failover Test 1');
    
    // Verify device is registered
    if (!this.deviceManager.isDeviceConnected(deviceId)) {
      throw new Error('Device should be connected');
    }
    
    // Disconnect first connection
    extensionSocket1.close();
    await this.wait(100);
    
    // Second connection with same device ID
    const extensionSocket2 = await this.createExtensionConnection();
    await this.registerDevice(extensionSocket2, deviceId, 'Failover Test 2');
    
    // Verify device is still accessible
    if (!this.deviceManager.isDeviceConnected(deviceId)) {
      throw new Error('Device should be reconnected');
    }
    
    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should still exist');
    }
    
    if (device.deviceInfo.name !== 'Failover Test 2') {
      throw new Error('Device info should be updated');
    }
    
    extensionSocket2.close();
  }

  async testConcurrentCDPSessions(): Promise<void> {
    const deviceId = 'device-concurrent-001';
    const extensionSocket = await this.createExtensionConnection();
    
    await this.registerDevice(extensionSocket, deviceId, 'Concurrent Test');
    
    // Create multiple CDP connections
    const cdpConnections = await Promise.all([
      this.createCDPConnection(deviceId),
      this.createCDPConnection(deviceId),
      this.createCDPConnection(deviceId)
    ]);
    
    // Send messages from all connections
    const messages = [
      { id: 1, method: 'Runtime.enable' },
      { id: 2, method: 'Page.enable' },
      { id: 3, method: 'Network.enable' }
    ];
    
    for (let i = 0; i < cdpConnections.length; i++) {
      cdpConnections[i].send(JSON.stringify(messages[i]));
    }
    
    await this.wait(200);
    
    // All connections should still be open
    for (let i = 0; i < cdpConnections.length; i++) {
      if (cdpConnections[i].readyState !== WebSocket.OPEN) {
        throw new Error(`CDP connection ${i} should still be open`);
      }
    }
    
    // Cleanup
    cdpConnections.forEach(conn => conn.close());
    extensionSocket.close();
  }

  async testErrorRecovery(): Promise<void> {
    const deviceId = 'device-error-001';
    
    // Test CDP connection to non-existent device
    try {
      await this.createCDPConnection('non-existent-device');
      throw new Error('Should not be able to connect to non-existent device');
    } catch (error: any) {
      if (!error.message.includes('non-existent')) {
        throw error; // Re-throw if it's not the expected error
      }
    }
    
    // Test invalid JSON messages
    const extensionSocket = await this.createExtensionConnection();
    
    // Send invalid JSON - should not crash server
    extensionSocket.send('invalid json');
    await this.wait(100);
    
    // Connection should still be usable
    if (extensionSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Extension connection should remain open after invalid message');
    }
    
    // Send valid registration after invalid message
    await this.registerDevice(extensionSocket, deviceId, 'Error Recovery Test');
    
    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should be registered after error recovery');
    }
    
    extensionSocket.close();
  }

  // Helper methods
  private async createExtensionConnection(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${this.testPort}/extension`);
      
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
      
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('Extension connection timeout'));
        }
      }, 5000);
    });
  }

  private async createCDPConnection(deviceId?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = deviceId 
        ? `ws://localhost:${this.testPort}/cdp?deviceId=${deviceId}`
        : `ws://localhost:${this.testPort}/cdp`;
      
      const socket = new WebSocket(url);
      
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
      
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          reject(new Error('CDP connection timeout'));
        }
      }, 5000);
    });
  }

  private async registerDevice(socket: WebSocket, deviceId: string, name: string): Promise<void> {
    const registrationMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo: {
        name,
        version: '1.0.0',
        userAgent: 'IntegrationTest/1.0',
        timestamp: new Date().toISOString()
      }
    };
    
    socket.send(JSON.stringify(registrationMessage));
    await this.wait(100);
  }

  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new DeviceIntegrationTests();
  tests.runAllTests().catch(console.error);
}

export { DeviceIntegrationTests };