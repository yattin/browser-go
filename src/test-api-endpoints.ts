#!/usr/bin/env node

/**
 * API Endpoints Tests
 * Tests the device management REST API endpoints
 */

import express from 'express';
import http from 'http';
import axios from 'axios';
import { DeviceManager } from './device-manager.js';
import { ApiRoutes } from './api-routes.js';
import { ChromeManager } from './chrome-manager.js';
import WebSocket from 'ws';

class APIEndpointsTests {
  private deviceManager: DeviceManager;
  private chromeManager: ChromeManager;
  private apiRoutes: ApiRoutes;
  private testServer: http.Server | null = null;
  private testPort: number = 0;
  private baseUrl: string = '';

  constructor() {
    this.deviceManager = new DeviceManager();
    
    // Mock chrome manager
    this.chromeManager = {
      getCurrentInstanceCount: () => 2,
      getConfig: () => ({
        maxConcurrentInstances: 10,
        instanceTimeoutMs: 3600000,
        inactiveCheckInterval: 300000
      }),
      shutdown: async () => {}
    } as any;
    
    this.apiRoutes = new ApiRoutes(this.chromeManager, this.deviceManager);
  }

  async setupTestServer(): Promise<void> {
    const app = express();
    app.use(express.json());
    
    // Setup API routes
    this.apiRoutes.setupRoutes(app);
    
    this.testServer = http.createServer(app);
    
    return new Promise((resolve, reject) => {
      this.testServer!.listen(0, () => {
        const address = this.testServer!.address();
        this.testPort = typeof address === 'object' && address ? address.port : 0;
        this.baseUrl = `http://localhost:${this.testPort}`;
        console.log(`📡 API test server started on port ${this.testPort}`);
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
    console.log('🧪 Running API Endpoints Tests...\n');

    try {
      await this.setupTestServer();
      
      await this.testDeviceListEndpoint();
      await this.testDeviceStatsEndpoint();
      await this.testSpecificDeviceEndpoint();
      await this.testBrowserStatsEndpoint();
      await this.testErrorHandling();
      
      console.log('\n✅ All API endpoint tests completed!');
    } finally {
      await this.cleanupTestServer();
      this.deviceManager.shutdown();
    }
  }

  async testDeviceListEndpoint(): Promise<void> {
    console.log('🔧 Testing GET /api/v1/devices...');
    
    // Add test devices
    await this.addTestDevices();
    
    const response = await axios.get(`${this.baseUrl}/api/v1/devices`);
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    const data = response.data;
    if (data.code !== 0) {
      throw new Error(`Expected code 0, got ${data.code}`);
    }
    
    if (!Array.isArray(data.data.devices)) {
      throw new Error('Response should contain devices array');
    }
    
    if (data.data.devices.length < 2) {
      throw new Error('Should have at least 2 test devices');
    }
    
    // Verify device structure
    const device = data.data.devices[0];
    const requiredFields = ['deviceId', 'deviceInfo', 'registeredAt', 'lastSeen', 'isConnected'];
    
    for (const field of requiredFields) {
      if (!(field in device)) {
        throw new Error(`Device should have ${field} field`);
      }
    }
    
    // Verify stats
    if (!data.data.stats) {
      throw new Error('Response should contain stats');
    }
    
    const stats = data.data.stats;
    if (typeof stats.totalDevices !== 'number') {
      throw new Error('Stats should have totalDevices number');
    }
    
    console.log(`  ✅ Listed ${data.data.devices.length} devices`);
  }

  async testDeviceStatsEndpoint(): Promise<void> {
    console.log('🔧 Testing GET /api/v1/device/stats...');
    
    const response = await axios.get(`${this.baseUrl}/api/v1/device/stats`);
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    const data = response.data;
    if (data.code !== 0) {
      throw new Error(`Expected code 0, got ${data.code}`);
    }
    
    const stats = data.data;
    const requiredFields = ['totalDevices', 'connectedDevices', 'devicesWithTargets'];
    
    for (const field of requiredFields) {
      if (typeof stats[field] !== 'number') {
        throw new Error(`Stats should have ${field} as number`);
      }
    }
    
    if (stats.connectedDevices > stats.totalDevices) {
      throw new Error('Connected devices cannot exceed total devices');
    }
    
    console.log(`  ✅ Stats: ${stats.totalDevices} total, ${stats.connectedDevices} connected`);
  }

  async testSpecificDeviceEndpoint(): Promise<void> {
    console.log('🔧 Testing GET /api/v1/devices/:deviceId...');
    
    const testDeviceId = 'device-api-test-001';
    
    // Test existing device
    const response = await axios.get(`${this.baseUrl}/api/v1/devices/${testDeviceId}`);
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    const data = response.data;
    if (data.code !== 0) {
      throw new Error(`Expected code 0, got ${data.code}`);
    }
    
    if (data.data.deviceId !== testDeviceId) {
      throw new Error(`Expected device ID ${testDeviceId}, got ${data.data.deviceId}`);
    }
    
    console.log(`  ✅ Retrieved device: ${data.data.deviceId}`);
    
    // Test non-existent device
    try {
      await axios.get(`${this.baseUrl}/api/v1/devices/non-existent-device`);
      throw new Error('Should return 404 for non-existent device');
    } catch (error: any) {
      if (error.response?.status !== 404) {
        throw new Error(`Expected 404 for non-existent device, got ${error.response?.status}`);
      }
      console.log(`  ✅ Correctly returned 404 for non-existent device`);
    }
  }

  async testBrowserStatsEndpoint(): Promise<void> {
    console.log('🔧 Testing GET /api/v1/browser/stats...');
    
    const response = await axios.get(`${this.baseUrl}/api/v1/browser/stats`);
    
    if (response.status !== 200) {
      throw new Error(`Expected status 200, got ${response.status}`);
    }
    
    const data = response.data;
    if (data.code !== 0) {
      throw new Error(`Expected code 0, got ${data.code}`);
    }
    
    const stats = data.data;
    const requiredFields = [
      'current_instances',
      'max_instances', 
      'available_slots',
      'instance_timeout_ms',
      'inactive_check_interval'
    ];
    
    for (const field of requiredFields) {
      if (typeof stats[field] !== 'number') {
        throw new Error(`Stats should have ${field} as number`);
      }
    }
    
    // Verify calculations
    if (stats.available_slots !== stats.max_instances - stats.current_instances) {
      throw new Error('Available slots calculation is incorrect');
    }
    
    console.log(`  ✅ Browser stats: ${stats.current_instances}/${stats.max_instances} instances`);
  }

  async testErrorHandling(): Promise<void> {
    console.log('🔧 Testing API Error Handling...');
    
    // Test invalid endpoints
    const invalidEndpoints = [
      '/api/v1/invalid',
      '/api/v1/devices/invalid/action',
      '/api/v2/devices'
    ];
    
    for (const endpoint of invalidEndpoints) {
      try {
        await axios.get(`${this.baseUrl}${endpoint}`);
        throw new Error(`Should return 404 for invalid endpoint: ${endpoint}`);
      } catch (error: any) {
        if (error.response?.status !== 404) {
          throw new Error(`Expected 404 for ${endpoint}, got ${error.response?.status}`);
        }
      }
    }
    
    console.log('  ✅ Invalid endpoints correctly return 404');
    
    // Test method not allowed (if applicable)
    try {
      await axios.post(`${this.baseUrl}/api/v1/devices`);
      console.log('  ⚠️  POST to devices endpoint allowed (might be intentional)');
    } catch (error: any) {
      if (error.response?.status === 405) {
        console.log('  ✅ POST to devices endpoint correctly returns 405');
      } else if (error.response?.status === 404) {
        console.log('  ✅ POST to devices endpoint returns 404 (no route defined)');
      }
    }
  }

  private async addTestDevices(): Promise<void> {
    const testDevices = [
      {
        deviceId: 'device-api-test-001',
        deviceInfo: {
          name: 'API Test Device 1',
          version: '1.0.0',
          userAgent: 'APITest/1.0',
          timestamp: new Date().toISOString()
        }
      },
      {
        deviceId: 'device-api-test-002',
        deviceInfo: {
          name: 'API Test Device 2',
          version: '1.1.0',
          userAgent: 'APITest/1.1',
          timestamp: new Date().toISOString()
        }
      }
    ];
    
    for (const deviceData of testDevices) {
      // Create mock WebSocket
      const mockSocket = {
        readyState: WebSocket.OPEN,
        send: () => {},
        close: () => {},
        on: () => {},
        removeListener: () => {}
      } as any;
      
      this.deviceManager.registerDevice(
        deviceData.deviceId,
        deviceData.deviceInfo,
        mockSocket
      );
      
      // Add connection info for one device
      if (deviceData.deviceId === 'device-api-test-001') {
        this.deviceManager.updateDeviceConnectionInfo(deviceData.deviceId, {
          sessionId: 'api-test-session-001',
          targetInfo: {
            targetId: 'api-test-target-001',
            type: 'page',
            title: 'API Test Page',
            url: 'https://api-test.example.com'
          }
        });
      }
    }
  }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const tests = new APIEndpointsTests();
  tests.runAllTests().catch(console.error);
}

export { APIEndpointsTests };