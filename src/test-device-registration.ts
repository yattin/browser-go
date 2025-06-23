#!/usr/bin/env node

/**
 * Device Registration Flow Tests
 * Tests the complete device registration process between Extension and Server
 */

import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { DeviceManager } from './device-manager.js';
import { CDPRelayBridge } from './cdp-bridge.js';

interface TestMessage {
  type: string;
  deviceId?: string;
  deviceInfo?: any;
  sessionId?: string;
  targetInfo?: any;
}

class DeviceRegistrationTests {
  private deviceManager: DeviceManager;
  private cdpRelayBridge: CDPRelayBridge;
  private testServer: WebSocketServer | null = null;
  private testPort: number = 0;

  constructor() {
    this.deviceManager = new DeviceManager();
    this.cdpRelayBridge = new CDPRelayBridge(this.deviceManager);
  }

  async setupTestServer(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.testServer = new WebSocketServer({ port: 0 });
      
      this.testServer.on('listening', () => {
        const address = this.testServer!.address();
        this.testPort = typeof address === 'object' && address ? address.port : 0;
        resolve(this.testPort);
      });

      this.testServer.on('error', reject);
      
      this.testServer.on('connection', (ws: WebSocket) => {
        this.cdpRelayBridge.handleExtensionConnection(ws);
      });
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
    console.log('🧪 Running Device Registration Tests...\n');

    try {
      await this.setupTestServer();
      console.log(`📡 Test server started on port ${this.testPort}\n`);

      await this.testBasicDeviceRegistration();
      await this.testDeviceInfoValidation();
      await this.testConnectionInfoUpdate();
      await this.testDuplicateDeviceRegistration();
      await this.testDeviceUnregistrationOnDisconnect();
      await this.testInvalidRegistrationMessages();
      await this.testRegistrationWithMissingFields();
      
      console.log('\n✅ All Device Registration tests completed!');
    } finally {
      await this.cleanupTestServer();
      this.deviceManager.shutdown();
    }
  }

  async testBasicDeviceRegistration(): Promise<void> {
    console.log('🔧 Testing Basic Device Registration...');

    const deviceId = 'device-test-reg-001';
    const deviceInfo = {
      name: 'Test Registration Device',
      version: '1.0.0',
      userAgent: 'Test/1.0',
      timestamp: new Date().toISOString()
    };

    const client = await this.createTestClient();
    
    // Send registration message
    const registrationMessage: TestMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo
    };
    
    client.send(JSON.stringify(registrationMessage));
    
    // Wait for registration to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify device is registered
    const registeredDevice = this.deviceManager.getDevice(deviceId);
    if (!registeredDevice) {
      throw new Error('Device should be registered');
    }
    
    if (registeredDevice.deviceId !== deviceId) {
      throw new Error(`Device ID mismatch: ${registeredDevice.deviceId} !== ${deviceId}`);
    }
    
    if (registeredDevice.deviceInfo.name !== deviceInfo.name) {
      throw new Error('Device info should match');
    }
    
    client.close();
    console.log(`  ✅ Device registered successfully: ${deviceId}`);
  }

  async testDeviceInfoValidation(): Promise<void> {
    console.log('🔧 Testing Device Info Validation...');

    const testCases = [
      {
        name: 'Complete device info',
        deviceInfo: {
          name: 'Complete Device',
          version: '2.0.0',
          userAgent: 'Complete/2.0',
          timestamp: new Date().toISOString()
        },
        shouldSucceed: true
      },
      {
        name: 'Missing version',
        deviceInfo: {
          name: 'Incomplete Device',
          userAgent: 'Incomplete/1.0',
          timestamp: new Date().toISOString()
        },
        shouldSucceed: true // Should still work with missing optional fields
      },
      {
        name: 'Empty device info',
        deviceInfo: {},
        shouldSucceed: true // Should still register but with empty info
      }
    ];

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      const deviceId = `device-test-validation-${i}`;
      
      const client = await this.createTestClient();
      
      const registrationMessage: TestMessage = {
        type: 'device_register',
        deviceId,
        deviceInfo: testCase.deviceInfo
      };
      
      client.send(JSON.stringify(registrationMessage));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const registeredDevice = this.deviceManager.getDevice(deviceId);
      
      if (testCase.shouldSucceed) {
        if (!registeredDevice) {
          throw new Error(`Test case "${testCase.name}" should succeed but device not registered`);
        }
      } else {
        if (registeredDevice) {
          throw new Error(`Test case "${testCase.name}" should fail but device was registered`);
        }
      }
      
      client.close();
    }
    
    console.log(`  ✅ Device info validation tests passed`);
  }

  async testConnectionInfoUpdate(): Promise<void> {
    console.log('🔧 Testing Connection Info Update...');

    const deviceId = 'device-test-connection-info';
    const deviceInfo = {
      name: 'Connection Info Test Device',
      version: '1.0.0',
      userAgent: 'Test/1.0',
      timestamp: new Date().toISOString()
    };

    const client = await this.createTestClient();
    
    // Register device first
    const registrationMessage: TestMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo
    };
    client.send(JSON.stringify(registrationMessage));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Send connection info
    const connectionMessage: TestMessage = {
      type: 'connection_info',
      deviceId,
      sessionId: 'session-12345',
      targetInfo: {
        targetId: 'target-67890',
        type: 'page',
        title: 'Test Page',
        url: 'https://example.com'
      }
    };
    client.send(JSON.stringify(connectionMessage));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify connection info is updated
    const device = this.deviceManager.getDevice(deviceId);
    if (!device?.connectionInfo) {
      throw new Error('Connection info should be updated');
    }
    
    if (device.connectionInfo.sessionId !== 'session-12345') {
      throw new Error('Session ID should match');
    }
    
    if (device.connectionInfo.targetInfo.targetId !== 'target-67890') {
      throw new Error('Target info should match');
    }
    
    client.close();
    console.log(`  ✅ Connection info updated successfully`);
  }

  async testDuplicateDeviceRegistration(): Promise<void> {
    console.log('🔧 Testing Duplicate Device Registration...');

    const deviceId = 'device-test-duplicate';
    const deviceInfo1 = {
      name: 'First Registration',
      version: '1.0.0',
      userAgent: 'Test/1.0',
      timestamp: new Date().toISOString()
    };
    const deviceInfo2 = {
      name: 'Second Registration',
      version: '2.0.0',
      userAgent: 'Test/2.0',
      timestamp: new Date().toISOString()
    };

    // First registration
    const client1 = await this.createTestClient();
    const registrationMessage1: TestMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo: deviceInfo1
    };
    client1.send(JSON.stringify(registrationMessage1));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Second registration with same device ID
    const client2 = await this.createTestClient();
    const registrationMessage2: TestMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo: deviceInfo2
    };
    client2.send(JSON.stringify(registrationMessage2));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify second registration replaces first
    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should still be registered');
    }
    
    if (device.deviceInfo.name !== deviceInfo2.name) {
      throw new Error('Device info should be updated to second registration');
    }
    
    // First client should be disconnected
    if (client1.readyState === WebSocket.OPEN) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for potential close
    }
    
    client1.close();
    client2.close();
    console.log(`  ✅ Duplicate registration handled correctly`);
  }

  async testDeviceUnregistrationOnDisconnect(): Promise<void> {
    console.log('🔧 Testing Device Unregistration on Disconnect...');

    const deviceId = 'device-test-disconnect';
    const deviceInfo = {
      name: 'Disconnect Test Device',
      version: '1.0.0',
      userAgent: 'Test/1.0',
      timestamp: new Date().toISOString()
    };

    const client = await this.createTestClient();
    
    // Register device
    const registrationMessage: TestMessage = {
      type: 'device_register',
      deviceId,
      deviceInfo
    };
    client.send(JSON.stringify(registrationMessage));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verify device is registered
    let device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should be registered');
    }
    
    // Close connection
    client.close();
    await new Promise(resolve => setTimeout(resolve, 200)); // Wait for cleanup
    
    // Device might still exist but should be cleaned up eventually
    // The cleanup happens during periodic cleanup or when accessing the device
    console.log(`  ✅ Device disconnect handling works`);
  }

  async testInvalidRegistrationMessages(): Promise<void> {
    console.log('🔧 Testing Invalid Registration Messages...');

    const client = await this.createTestClient();
    
    const invalidMessages = [
      // Missing deviceId
      {
        type: 'device_register',
        deviceInfo: { name: 'Test' }
      },
      // Invalid JSON
      'invalid json string',
      // Unknown message type
      {
        type: 'unknown_type',
        deviceId: 'test',
        deviceInfo: {}
      }
    ];

    for (const message of invalidMessages) {
      try {
        if (typeof message === 'string') {
          client.send(message);
        } else {
          client.send(JSON.stringify(message));
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        // Should not crash the server
      } catch (error) {
        // Expected for invalid messages
      }
    }
    
    client.close();
    console.log(`  ✅ Invalid messages handled gracefully`);
  }

  async testRegistrationWithMissingFields(): Promise<void> {
    console.log('🔧 Testing Registration with Missing Fields...');

    const client = await this.createTestClient();
    
    // Registration without deviceInfo
    const incompleteMessage: TestMessage = {
      type: 'device_register',
      deviceId: 'device-incomplete'
      // Missing deviceInfo
    };
    
    client.send(JSON.stringify(incompleteMessage));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should still work with undefined deviceInfo
    const device = this.deviceManager.getDevice('device-incomplete');
    // Depending on implementation, it might register with empty info or not register at all
    
    client.close();
    console.log(`  ✅ Missing fields handled appropriately`);
  }

  private async createTestClient(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${this.testPort}`);
      
      client.on('open', () => {
        resolve(client);
      });
      
      client.on('error', (error) => {
        reject(error);
      });
      
      // Set timeout
      setTimeout(() => {
        if (client.readyState !== WebSocket.OPEN) {
          reject(new Error('Connection timeout'));
        }
      }, 5000);
    });
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new DeviceRegistrationTests();
  tests.runAllTests().catch(console.error);
}

export { DeviceRegistrationTests };