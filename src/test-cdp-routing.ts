#!/usr/bin/env node

/**
 * CDP Device Routing Tests
 * Tests CDP client routing to specific devices based on device ID
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { DeviceManager } from './device-manager.js';
import { CDPRelayBridge } from './cdp-bridge.js';

interface CDPMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

interface TestDevice {
  deviceId: string;
  socket: WebSocket;
  receivedMessages: CDPMessage[];
}

class CDPRoutingTests {
  private deviceManager: DeviceManager;
  private cdpRelayBridge: CDPRelayBridge;
  private extensionServer: WebSocketServer | null = null;
  private cdpServer: WebSocketServer | null = null;
  private extensionPort: number = 0;
  private cdpPort: number = 0;
  private testDevices: TestDevice[] = [];

  constructor() {
    this.deviceManager = new DeviceManager();
    this.cdpRelayBridge = new CDPRelayBridge(this.deviceManager);
  }

  async setupTestServers(): Promise<void> {
    // Extension server
    this.extensionPort = await this.createServer((ws) => {
      this.cdpRelayBridge.handleExtensionConnection(ws);
    });

    // CDP server with device routing
    this.cdpPort = await this.createServer((ws, req) => {
      const url = new URL(req.url!, `http://localhost:${this.cdpPort}`);
      const deviceId = url.searchParams.get('deviceId');
      this.cdpRelayBridge.handleCDPConnection(ws, deviceId || undefined);
    });

    console.log(`📡 Extension server on port ${this.extensionPort}`);
    console.log(`📡 CDP server on port ${this.cdpPort}`);
  }

  private async createServer(connectionHandler: (ws: WebSocket, req: any) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port: 0 });
      
      server.on('listening', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(port);
      });

      server.on('error', reject);
      server.on('connection', connectionHandler);
      
      if (!this.extensionServer) {
        this.extensionServer = server;
      } else {
        this.cdpServer = server;
      }
    });
  }

  async cleanupTestServers(): Promise<void> {
    const cleanupPromises = [];
    
    if (this.extensionServer) {
      cleanupPromises.push(new Promise<void>((resolve) => {
        this.extensionServer!.close(() => resolve());
      }));
    }
    
    if (this.cdpServer) {
      cleanupPromises.push(new Promise<void>((resolve) => {
        this.cdpServer!.close(() => resolve());
      }));
    }

    await Promise.all(cleanupPromises);
    this.extensionServer = null;
    this.cdpServer = null;
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Running CDP Routing Tests...\n');

    try {
      await this.setupTestServers();

      await this.testBasicDeviceRouting();
      await this.testMultipleDeviceRouting();
      await this.testNonExistentDeviceHandling();
      await this.testRoutingWithoutDeviceId();
      await this.testCDPMessageForwarding();
      await this.testDeviceDisconnectionHandling();
      await this.testConcurrentCDPConnections();
      
      console.log('\n✅ All CDP Routing tests completed!');
    } finally {
      await this.cleanupTestDevices();
      await this.cleanupTestServers();
      this.deviceManager.shutdown();
    }
  }

  async testBasicDeviceRouting(): Promise<void> {
    console.log('🔧 Testing Basic Device Routing...');

    // Create test device
    const device = await this.createTestDevice('device-routing-001');
    
    // Create CDP client with device ID
    const cdpClient = await this.createCDPClient(device.deviceId);
    
    // Send test CDP message
    const testMessage: CDPMessage = {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1 + 1' }
    };
    
    cdpClient.send(JSON.stringify(testMessage));
    
    // Wait for message to be forwarded
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify device received the message
    if (device.receivedMessages.length === 0) {
      throw new Error('Device should have received CDP message');
    }
    
    const receivedMessage = device.receivedMessages[0];
    if (receivedMessage.method !== testMessage.method) {
      throw new Error(`Method mismatch: ${receivedMessage.method} !== ${testMessage.method}`);
    }
    
    cdpClient.close();
    console.log(`  ✅ CDP message routed to correct device`);
  }

  async testMultipleDeviceRouting(): Promise<void> {
    console.log('🔧 Testing Multiple Device Routing...');

    // Create multiple devices
    const device1 = await this.createTestDevice('device-routing-002');
    const device2 = await this.createTestDevice('device-routing-003');
    
    // Create CDP clients for each device
    const cdpClient1 = await this.createCDPClient(device1.deviceId);
    const cdpClient2 = await this.createCDPClient(device2.deviceId);
    
    // Send different messages to each device
    const message1: CDPMessage = {
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: 'device1' }
    };
    
    const message2: CDPMessage = {
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: 'device2' }
    };
    
    cdpClient1.send(JSON.stringify(message1));
    cdpClient2.send(JSON.stringify(message2));
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify each device received only its message
    if (device1.receivedMessages.length !== 1) {
      throw new Error(`Device1 should receive 1 message, got ${device1.receivedMessages.length}`);
    }
    
    if (device2.receivedMessages.length !== 1) {
      throw new Error(`Device2 should receive 1 message, got ${device2.receivedMessages.length}`);
    }
    
    if (device1.receivedMessages[0].params?.expression !== 'device1') {
      throw new Error('Device1 received wrong message');
    }
    
    if (device2.receivedMessages[0].params?.expression !== 'device2') {
      throw new Error('Device2 received wrong message');
    }
    
    cdpClient1.close();
    cdpClient2.close();
    console.log(`  ✅ Messages routed to correct devices`);
  }

  async testNonExistentDeviceHandling(): Promise<void> {
    console.log('🔧 Testing Non-existent Device Handling...');

    let connectionClosed = false;
    let closeCode = 0;
    let closeReason = '';

    try {
      const cdpClient = await this.createCDPClient('device-nonexistent');
      
      cdpClient.on('close', (code, reason) => {
        connectionClosed = true;
        closeCode = code;
        closeReason = reason.toString();
      });
      
      // Wait for potential close
      await new Promise(resolve => setTimeout(resolve, 200));
      
      if (!connectionClosed) {
        cdpClient.close();
        throw new Error('Connection should be closed for non-existent device');
      }
      
      if (closeCode !== 1002) {
        throw new Error(`Expected close code 1002, got ${closeCode}`);
      }
      
      console.log(`  ✅ Non-existent device connection rejected with code ${closeCode}`);
    } catch (error: any) {
      if (error.message.includes('Connection should be closed')) {
        throw error;
      }
      // Connection rejection is expected
      console.log(`  ✅ Non-existent device connection rejected: ${error.message}`);
    }
  }

  async testRoutingWithoutDeviceId(): Promise<void> {
    console.log('🔧 Testing Routing without Device ID...');

    // Create CDP client without device ID
    const cdpClient = await this.createCDPClient();
    
    // Send test message
    const testMessage: CDPMessage = {
      id: 1,
      method: 'Browser.getVersion'
    };
    
    let receivedResponse = false;
    
    cdpClient.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.id === 1 && response.result) {
          receivedResponse = true;
        }
      } catch (error) {
        // Ignore parse errors
      }
    });
    
    cdpClient.send(JSON.stringify(testMessage));
    
    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 200));
    
    if (!receivedResponse) {
      throw new Error('Should receive response for Browser domain methods');
    }
    
    cdpClient.close();
    console.log(`  ✅ Routing without device ID works for local methods`);
  }

  async testCDPMessageForwarding(): Promise<void> {
    console.log('🔧 Testing CDP Message Forwarding...');

    const device = await this.createTestDevice('device-forwarding-001');
    const cdpClient = await this.createCDPClient(device.deviceId);
    
    // Test different types of CDP messages
    const testMessages: CDPMessage[] = [
      {
        id: 1,
        method: 'Runtime.enable'
      },
      {
        id: 2,
        method: 'Page.navigate',
        params: { url: 'https://example.com' }
      },
      {
        id: 3,
        method: 'Runtime.evaluate',
        params: { 
          expression: 'document.title',
          returnByValue: true 
        }
      }
    ];
    
    // Send all messages
    for (const message of testMessages) {
      cdpClient.send(JSON.stringify(message));
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Verify all messages were forwarded
    if (device.receivedMessages.length !== testMessages.length) {
      throw new Error(`Expected ${testMessages.length} messages, got ${device.receivedMessages.length}`);
    }
    
    // Verify message content
    for (let i = 0; i < testMessages.length; i++) {
      const sent = testMessages[i];
      const received = device.receivedMessages[i];
      
      if (sent.id !== received.id) {
        throw new Error(`Message ${i} ID mismatch: ${sent.id} !== ${received.id}`);
      }
      
      if (sent.method !== received.method) {
        throw new Error(`Message ${i} method mismatch: ${sent.method} !== ${received.method}`);
      }
    }
    
    cdpClient.close();
    console.log(`  ✅ All CDP messages forwarded correctly`);
  }

  async testDeviceDisconnectionHandling(): Promise<void> {
    console.log('🔧 Testing Device Disconnection Handling...');

    const device = await this.createTestDevice('device-disconnect-001');
    const cdpClient = await this.createCDPClient(device.deviceId);
    
    // Verify connection works initially
    const testMessage: CDPMessage = {
      id: 1,
      method: 'Runtime.enable'
    };
    
    cdpClient.send(JSON.stringify(testMessage));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (device.receivedMessages.length === 0) {
      throw new Error('Initial message should be delivered');
    }
    
    // Disconnect device
    device.socket.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Clear previous messages
    device.receivedMessages = [];
    
    // Try to send another message
    const testMessage2: CDPMessage = {
      id: 2,
      method: 'Runtime.evaluate',
      params: { expression: '2 + 2' }
    };
    
    let errorReceived = false;
    
    cdpClient.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.error) {
          errorReceived = true;
        }
      } catch (error) {
        // Ignore parse errors
      }
    });
    
    cdpClient.send(JSON.stringify(testMessage2));
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Should receive error or no message forwarded
    if (device.receivedMessages.length > 0) {
      throw new Error('Message should not be delivered to disconnected device');
    }
    
    cdpClient.close();
    console.log(`  ✅ Device disconnection handled correctly`);
  }

  async testConcurrentCDPConnections(): Promise<void> {
    console.log('🔧 Testing Concurrent CDP Connections...');

    const device = await this.createTestDevice('device-concurrent-001');
    
    // Create multiple CDP clients for the same device
    const cdpClients = await Promise.all([
      this.createCDPClient(device.deviceId),
      this.createCDPClient(device.deviceId),
      this.createCDPClient(device.deviceId)
    ]);
    
    // Send messages from all clients
    const messages: CDPMessage[] = [
      { id: 1, method: 'Runtime.enable' },
      { id: 2, method: 'Page.enable' },
      { id: 3, method: 'Network.enable' }
    ];
    
    for (let i = 0; i < cdpClients.length; i++) {
      cdpClients[i].send(JSON.stringify(messages[i]));
    }
    
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // All messages should be forwarded to the device
    if (device.receivedMessages.length !== messages.length) {
      throw new Error(`Expected ${messages.length} messages, got ${device.receivedMessages.length}`);
    }
    
    // Close all clients
    cdpClients.forEach(client => client.close());
    
    console.log(`  ✅ Concurrent CDP connections handled correctly`);
  }

  private async createTestDevice(deviceId: string): Promise<TestDevice> {
    const socket = await this.createExtensionClient();
    const device: TestDevice = {
      deviceId,
      socket,
      receivedMessages: []
    };

    // Register device
    const registrationMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo: {
        name: `Test Device ${deviceId}`,
        version: '1.0.0',
        userAgent: 'Test/1.0',
        timestamp: new Date().toISOString()
      }
    };
    
    socket.send(JSON.stringify(registrationMessage));
    
    // Set up message capture
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        device.receivedMessages.push(message);
      } catch (error) {
        // Ignore parse errors
      }
    });
    
    await new Promise(resolve => setTimeout(resolve, 100));
    this.testDevices.push(device);
    return device;
  }

  private async createExtensionClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${this.extensionPort}`);
      
      client.on('open', () => resolve(client));
      client.on('error', reject);
      
      setTimeout(() => {
        if (client.readyState !== WebSocket.OPEN) {
          reject(new Error('Extension connection timeout'));
        }
      }, 5000);
    });
  }

  private async createCDPClient(deviceId?: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const url = deviceId 
        ? `ws://localhost:${this.cdpPort}?deviceId=${deviceId}`
        : `ws://localhost:${this.cdpPort}`;
      
      const client = new WebSocket(url);
      
      client.on('open', () => resolve(client));
      client.on('error', reject);
      
      setTimeout(() => {
        if (client.readyState !== WebSocket.OPEN) {
          reject(new Error('CDP connection timeout'));
        }
      }, 5000);
    });
  }

  private async cleanupTestDevices(): Promise<void> {
    for (const device of this.testDevices) {
      if (device.socket.readyState === WebSocket.OPEN) {
        device.socket.close();
      }
    }
    this.testDevices = [];
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new CDPRoutingTests();
  tests.runAllTests().catch(console.error);
}

export { CDPRoutingTests };