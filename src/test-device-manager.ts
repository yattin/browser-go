#!/usr/bin/env node

/**
 * Device Manager Unit Tests
 * Tests DeviceManager class functionality in isolation
 */

import WebSocket from 'ws';
import { DeviceManager } from './device-manager.js';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

class DeviceManagerTests {
  private deviceManager: DeviceManager;
  private testResults: TestResult[] = [];

  constructor() {
    this.deviceManager = new DeviceManager();
  }

  async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const startTime = Date.now();
    try {
      await testFn();
      this.testResults.push({
        name,
        passed: true,
        duration: Date.now() - startTime
      });
      console.log(`✅ ${name}`);
    } catch (error: any) {
      this.testResults.push({
        name,
        passed: false,
        error: error.message,
        duration: Date.now() - startTime
      });
      console.log(`❌ ${name}: ${error.message}`);
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🧪 Running DeviceManager Unit Tests...\n');

    await this.runTest('Device Registration', this.testDeviceRegistration.bind(this));
    await this.runTest('Device Lookup', this.testDeviceLookup.bind(this));
    await this.runTest('Device Socket Retrieval', this.testDeviceSocket.bind(this));
    await this.runTest('Device Connection Status', this.testDeviceConnectionStatus.bind(this));
    await this.runTest('Device Unregistration', this.testDeviceUnregistration.bind(this));
    await this.runTest('Connection Info Update', this.testConnectionInfoUpdate.bind(this));
    await this.runTest('Device Statistics', this.testDeviceStatistics.bind(this));
    await this.runTest('Multiple Device Management', this.testMultipleDevices.bind(this));
    await this.runTest('Device Cleanup', this.testDeviceCleanup.bind(this));
    await this.runTest('Invalid Device Handling', this.testInvalidDeviceHandling.bind(this));

    this.printResults();
    this.cleanup();
  }

  // Mock WebSocket class for testing
  private createMockWebSocket(readyState: number = WebSocket.OPEN): any {
    return {
      readyState,
      send: () => {},
      close: () => {},
      on: () => {},
      removeListener: () => {}
    };
  }

  async testDeviceRegistration(): Promise<void> {
    const deviceId = 'device-test-001';
    const deviceInfo = {
      name: 'Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };
    const mockSocket = this.createMockWebSocket();

    this.deviceManager.registerDevice(deviceId, deviceInfo, mockSocket);

    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device was not registered');
    }
    if (device.deviceId !== deviceId) {
      throw new Error('Device ID mismatch');
    }
    if (device.deviceInfo.name !== deviceInfo.name) {
      throw new Error('Device info mismatch');
    }
  }

  async testDeviceLookup(): Promise<void> {
    const deviceId = 'device-test-002';
    
    // Test non-existent device
    const nonExistent = this.deviceManager.getDevice(deviceId);
    if (nonExistent) {
      throw new Error('Non-existent device should return undefined');
    }

    // Register device and test lookup
    const deviceInfo = {
      name: 'Lookup Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };
    const mockSocket = this.createMockWebSocket();

    this.deviceManager.registerDevice(deviceId, deviceInfo, mockSocket);
    
    const found = this.deviceManager.getDevice(deviceId);
    if (!found) {
      throw new Error('Registered device should be found');
    }
    if (found.deviceId !== deviceId) {
      throw new Error('Found device ID mismatch');
    }
  }

  async testDeviceSocket(): Promise<void> {
    const deviceId = 'device-test-003';
    const deviceInfo = {
      name: 'Socket Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };

    // Test with connected socket
    const connectedSocket = this.createMockWebSocket(WebSocket.OPEN);
    this.deviceManager.registerDevice(deviceId, deviceInfo, connectedSocket);
    
    const retrievedSocket = this.deviceManager.getDeviceSocket(deviceId);
    if (!retrievedSocket) {
      throw new Error('Should return connected socket');
    }

    // Test with disconnected socket
    const disconnectedSocket = this.createMockWebSocket(WebSocket.CLOSED);
    this.deviceManager.registerDevice(deviceId + '-disconnected', deviceInfo, disconnectedSocket);
    
    const nullSocket = this.deviceManager.getDeviceSocket(deviceId + '-disconnected');
    if (nullSocket) {
      throw new Error('Should return null for disconnected socket');
    }
  }

  async testDeviceConnectionStatus(): Promise<void> {
    const deviceId = 'device-test-004';
    const deviceInfo = {
      name: 'Connection Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };

    // Test non-existent device
    if (this.deviceManager.isDeviceConnected('non-existent')) {
      throw new Error('Non-existent device should not be connected');
    }

    // Test connected device
    const connectedSocket = this.createMockWebSocket(WebSocket.OPEN);
    this.deviceManager.registerDevice(deviceId, deviceInfo, connectedSocket);
    
    if (!this.deviceManager.isDeviceConnected(deviceId)) {
      throw new Error('Connected device should return true');
    }

    // Test disconnected device
    const disconnectedSocket = this.createMockWebSocket(WebSocket.CLOSED);
    this.deviceManager.registerDevice(deviceId + '-disconnected', deviceInfo, disconnectedSocket);
    
    if (this.deviceManager.isDeviceConnected(deviceId + '-disconnected')) {
      throw new Error('Disconnected device should return false');
    }
  }

  async testDeviceUnregistration(): Promise<void> {
    const deviceId = 'device-test-005';
    const deviceInfo = {
      name: 'Unregister Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };
    const mockSocket = this.createMockWebSocket();

    // Register device
    this.deviceManager.registerDevice(deviceId, deviceInfo, mockSocket);
    
    if (!this.deviceManager.getDevice(deviceId)) {
      throw new Error('Device should be registered');
    }

    // Unregister device
    this.deviceManager.unregisterDevice(deviceId);
    
    if (this.deviceManager.getDevice(deviceId)) {
      throw new Error('Device should be unregistered');
    }
  }

  async testConnectionInfoUpdate(): Promise<void> {
    const deviceId = 'device-test-006';
    const deviceInfo = {
      name: 'Connection Info Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };
    const mockSocket = this.createMockWebSocket();

    this.deviceManager.registerDevice(deviceId, deviceInfo, mockSocket);

    const connectionInfo = {
      sessionId: 'session-123',
      targetInfo: {
        targetId: 'target-456',
        type: 'page',
        title: 'Test Page',
        url: 'https://example.com'
      }
    };

    this.deviceManager.updateDeviceConnectionInfo(deviceId, connectionInfo);

    const device = this.deviceManager.getDevice(deviceId);
    if (!device?.connectionInfo) {
      throw new Error('Connection info should be updated');
    }
    if (device.connectionInfo.sessionId !== 'session-123') {
      throw new Error('Session ID mismatch');
    }
  }

  async testDeviceStatistics(): Promise<void> {
    // Clear any existing devices
    const existingDevices = this.deviceManager.getAllDevices();
    existingDevices.forEach(device => {
      this.deviceManager.unregisterDevice(device.deviceId);
    });

    const stats1 = this.deviceManager.getDeviceStats();
    if (stats1.totalDevices !== 0) {
      throw new Error('Initial total devices should be 0');
    }

    // Add connected devices
    for (let i = 0; i < 3; i++) {
      const deviceInfo = {
        name: `Stats Test Device ${i}`,
        version: '1.0.0',
        userAgent: 'Test Agent',
        timestamp: new Date().toISOString()
      };
      const mockSocket = this.createMockWebSocket(WebSocket.OPEN);
      this.deviceManager.registerDevice(`device-stats-${i}`, deviceInfo, mockSocket);
    }

    // Add disconnected device
    const disconnectedDeviceInfo = {
      name: 'Disconnected Stats Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };
    const disconnectedSocket = this.createMockWebSocket(WebSocket.CLOSED);
    this.deviceManager.registerDevice('device-stats-disconnected', disconnectedDeviceInfo, disconnectedSocket);

    const stats2 = this.deviceManager.getDeviceStats();
    if (stats2.totalDevices !== 4) {
      throw new Error(`Total devices should be 4, got ${stats2.totalDevices}`);
    }
    if (stats2.connectedDevices !== 3) {
      throw new Error(`Connected devices should be 3, got ${stats2.connectedDevices}`);
    }
  }

  async testMultipleDevices(): Promise<void> {
    const deviceCount = 5;
    const deviceIds: string[] = [];

    // Register multiple devices
    for (let i = 0; i < deviceCount; i++) {
      const deviceId = `device-multi-${i}`;
      deviceIds.push(deviceId);
      
      const deviceInfo = {
        name: `Multi Test Device ${i}`,
        version: '1.0.0',
        userAgent: 'Test Agent',
        timestamp: new Date().toISOString()
      };
      const mockSocket = this.createMockWebSocket();
      this.deviceManager.registerDevice(deviceId, deviceInfo, mockSocket);
    }

    // Verify all devices are registered
    const allDevices = this.deviceManager.getAllDevices();
    const registeredIds = allDevices.map(d => d.deviceId);
    
    for (const deviceId of deviceIds) {
      if (!registeredIds.includes(deviceId)) {
        throw new Error(`Device ${deviceId} not found in registered devices`);
      }
    }

    if (allDevices.length < deviceCount) {
      throw new Error(`Expected at least ${deviceCount} devices, got ${allDevices.length}`);
    }
  }

  async testDeviceCleanup(): Promise<void> {
    const deviceId = 'device-test-cleanup';
    const deviceInfo = {
      name: 'Cleanup Test Device',
      version: '1.0.0',
      userAgent: 'Test Agent',
      timestamp: new Date().toISOString()
    };

    // Test duplicate registration (should replace old connection)
    const oldSocket = this.createMockWebSocket();
    const newSocket = this.createMockWebSocket();

    this.deviceManager.registerDevice(deviceId, deviceInfo, oldSocket);
    this.deviceManager.registerDevice(deviceId, deviceInfo, newSocket);

    const device = this.deviceManager.getDevice(deviceId);
    if (!device) {
      throw new Error('Device should still be registered');
    }
    if (device.extensionSocket !== newSocket) {
      throw new Error('Device should use new socket');
    }
  }

  async testInvalidDeviceHandling(): Promise<void> {
    // Test updating connection info for non-existent device
    this.deviceManager.updateDeviceConnectionInfo('non-existent', {
      sessionId: 'test',
      targetInfo: {}
    });
    // Should not throw error, just log warning

    // Test getting socket for non-existent device
    const socket = this.deviceManager.getDeviceSocket('non-existent');
    if (socket) {
      throw new Error('Non-existent device should return null socket');
    }
  }

  private printResults(): void {
    console.log('\n📊 Test Results Summary:');
    console.log('========================');
    
    const passed = this.testResults.filter(r => r.passed).length;
    const failed = this.testResults.filter(r => !r.passed).length;
    const total = this.testResults.length;
    
    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
      console.log('\n❌ Failed Tests:');
      this.testResults.filter(r => !r.passed).forEach(result => {
        console.log(`  - ${result.name}: ${result.error}`);
      });
    }
    
    const avgDuration = this.testResults.reduce((sum, r) => sum + r.duration, 0) / total;
    console.log(`\nAverage Test Duration: ${avgDuration.toFixed(2)}ms`);
  }

  private cleanup(): void {
    this.deviceManager.shutdown();
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new DeviceManagerTests();
  tests.runAllTests().catch(console.error);
}

export { DeviceManagerTests };