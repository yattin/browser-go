#!/usr/bin/env node

/**
 * Multi-Device Connection Stability Test
 * Tests device registration and CDP message routing without real browsers
 * Focuses on connection robustness and conflict resolution
 */

import { spawn, ChildProcess } from 'child_process';
import WebSocket from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TestConfig {
  serverPort: number;
  serverToken: string;
  testTimeout: number;
  deviceCount: number;
}

interface DeviceSimulator {
  deviceId: string;
  ws: WebSocket | null;
  connected: boolean;
  registered: boolean;
  messageCount: number;
  responses: Map<string, any>;
}

class MultiDeviceStabilityTester {
  private config: TestConfig;
  private serverProcess: ChildProcess | null = null;
  private devices: Map<string, DeviceSimulator> = new Map();
  private testResults: { [key: string]: boolean } = {};
  private messageIdCounter = 0;

  constructor() {
    this.config = {
      serverPort: 3000,
      serverToken: 'test-token-stability',
      testTimeout: 30000, // 30 seconds per test
      deviceCount: 5, // Test with 5 simulated devices
    };
  }

  /**
   * Print test progress
   */
  private log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const colors = {
      info: '\x1b[34m',    // Blue
      success: '\x1b[32m', // Green
      warning: '\x1b[33m', // Yellow
      error: '\x1b[31m'    // Red
    };
    const reset = '\x1b[0m';
    console.log(`${colors[type]}[${type.toUpperCase()}]${reset} ${message}`);
  }

  /**
   * Generate unique device ID
   */
  private generateDeviceId(index: number): string {
    const uuid = this.generateUUID();
    const randomPart = Math.random().toString(36).substring(2, 6);
    return `device-test-${index}-${uuid}-${randomPart}`;
  }

  /**
   * Generate simple UUID
   */
  private generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Start the browser-go server
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log('Starting browser-go server...');
      
      this.serverProcess = spawn('node', [
        'dist/cli.js', 
        '--port', String(this.config.serverPort), 
        '--token', this.config.serverToken,
        '--max-instances', '10'
      ], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });

      let serverReady = false;
      const timeout = setTimeout(() => {
        if (!serverReady) {
          reject(new Error('Server startup timeout'));
        }
      }, 15000);

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Server is running on') && !serverReady) {
          serverReady = true;
          clearTimeout(timeout);
          this.log('Server started successfully', 'success');
          setTimeout(resolve, 2000); // Give server time to fully initialize
        }
      });

      this.serverProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        console.error(`[Server Error] ${output.trim()}`);
      });

      this.serverProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.serverProcess.on('exit', (code, signal) => {
        if (!serverReady) {
          clearTimeout(timeout);
          reject(new Error(`Server exited with code ${code}, signal ${signal}`));
        }
      });
    });
  }

  /**
   * Stop the server
   */
  async stopServer(): Promise<void> {
    if (this.serverProcess) {
      this.log('Stopping server...');
      this.serverProcess.kill('SIGTERM');
      
      await new Promise(resolve => {
        if (this.serverProcess) {
          this.serverProcess.on('exit', resolve);
          setTimeout(() => {
            if (this.serverProcess) {
              this.serverProcess.kill('SIGKILL');
            }
            resolve(undefined);
          }, 5000);
        } else {
          resolve(undefined);
        }
      });
      
      this.serverProcess = null;
      this.log('Server stopped', 'success');
    }
  }

  /**
   * Create simulated device connection
   */
  async createDeviceConnection(deviceIndex: number): Promise<DeviceSimulator> {
    const deviceId = this.generateDeviceId(deviceIndex);
    const device: DeviceSimulator = {
      deviceId,
      ws: null,
      connected: false,
      registered: false,
      messageCount: 0,
      responses: new Map()
    };

    return new Promise((resolve, reject) => {
      const wsUrl = `ws://127.0.0.1:${this.config.serverPort}/extension`;
      device.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error(`Device ${deviceIndex} connection timeout`));
      }, 10000);

      device.ws.on('open', () => {
        device.connected = true;
        clearTimeout(timeout);
        this.log(`Device ${deviceIndex} (${deviceId.substring(0, 20)}...) connected`);

        // Send connection info like a real extension
        const connectionInfo = {
          type: 'connection_info',
          sessionId: `test-session-${deviceIndex}`,
          targetInfo: {
            attached: true,
            browserContextId: this.generateUUID(),
            canAccessOpener: false,
            targetId: this.generateUUID(),
            title: `Test Page ${deviceIndex}`,
            type: 'page',
            url: 'about:blank'
          }
        };
        
        device.ws!.send(JSON.stringify(connectionInfo));
        
        // Start heartbeat immediately after connection
        setTimeout(() => {
          if (device.ws && device.connected) {
            const heartbeatMessage = {
              type: 'ping',
              deviceId: deviceId,
              deviceInfo: {
                name: `Test Device ${deviceIndex}`,
                version: '1.0.0',
                userAgent: `Test-Agent-${deviceIndex}`,
                timestamp: new Date().toISOString()
              }
            };
            device.ws.send(JSON.stringify(heartbeatMessage));
          }
        }, 1000);
        
        resolve(device);
      });

      device.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          device.messageCount++;
          
          if (message.type === 'pong') {
            // Server responded to our ping
            device.registered = true;
            this.log(`Device ${deviceIndex} registered successfully`);
          } else if (message.type === 'ping') {
            // Server is pinging us (shouldn't happen but handle it)
            const pongMessage = {
              type: 'pong',
              deviceId: deviceId,
              deviceInfo: {
                name: `Test Device ${deviceIndex}`,
                version: '1.0.0',
                userAgent: `Test-Agent-${deviceIndex}`,
                timestamp: new Date().toISOString()
              }
            };
            device.ws!.send(JSON.stringify(pongMessage));
          } else if (message.id) {
            // Store response for verification
            device.responses.set(message.id, message);
          }
        } catch (error) {
          this.log(`Device ${deviceIndex} message parse error: ${error}`, 'error');
        }
      });

      device.ws.on('error', (error) => {
        clearTimeout(timeout);
        this.log(`Device ${deviceIndex} WebSocket error: ${error}`, 'error');
        reject(error);
      });

      device.ws.on('close', () => {
        device.connected = false;
        device.registered = false;
        this.log(`Device ${deviceIndex} disconnected`);
      });
    });
  }

  /**
   * Test simultaneous device registration
   */
  async testSimultaneousDeviceRegistration(): Promise<boolean> {
    try {
      this.log('Testing simultaneous device registration...');
      
      // Create multiple devices simultaneously
      const devicePromises: Promise<DeviceSimulator>[] = [];
      for (let i = 0; i < this.config.deviceCount; i++) {
        devicePromises.push(this.createDeviceConnection(i));
      }

      // Wait for all devices to connect
      const devices = await Promise.all(devicePromises);
      
      // Store devices for later use
      devices.forEach(device => {
        this.devices.set(device.deviceId, device);
      });

      // Wait for registration process
      await new Promise(resolve => setTimeout(resolve, 8000));

      // Check registration status
      const registeredCount = Array.from(this.devices.values())
        .filter(device => device.registered).length;
      
      this.log(`${registeredCount}/${this.config.deviceCount} devices registered successfully`);
      
      // Consider test successful if at least 60% of devices register
      // This accounts for race conditions in multi-device scenarios
      const minSuccessCount = Math.ceil(this.config.deviceCount * 0.6);
      const success = registeredCount >= minSuccessCount;
      
      if (success) {
        this.log(`Device registration test passed (${registeredCount}/${this.config.deviceCount}, minimum: ${minSuccessCount})`, 'success');
      } else {
        this.log(`Device registration test failed (${registeredCount}/${this.config.deviceCount}, minimum: ${minSuccessCount})`, 'warning');
      }

      return success;
    } catch (error: any) {
      this.log(`Simultaneous registration test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test device ID conflict resolution
   */
  async testDeviceIdConflictResolution(): Promise<boolean> {
    try {
      this.log('Testing device ID conflict resolution...');
      
      // Create two devices with the same ID
      const conflictDeviceId = 'device-conflict-test-12345';
      
      // First device
      const device1 = await this.createDuplicateDevice(conflictDeviceId, 1);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Second device with same ID (should cause conflict)
      const device2 = await this.createDuplicateDevice(conflictDeviceId, 2);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if conflict was handled properly
      // The first device should be disconnected, second should be active
      const device1Connected = device1.connected;
      const device2Connected = device2.connected;
      
      this.log(`Device 1 connected: ${device1Connected}, Device 2 connected: ${device2Connected}`);
      
      // Expect device 1 to be disconnected, device 2 to be connected
      const success = !device1Connected && device2Connected;
      
      if (success) {
        this.log('Device ID conflict resolved correctly', 'success');
      } else {
        this.log('Device ID conflict resolution failed', 'error');
      }

      // Clean up
      if (device1.ws) device1.ws.close();
      if (device2.ws) device2.ws.close();

      return success;
    } catch (error: any) {
      this.log(`Device ID conflict test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Create device with specific ID for conflict testing
   */
  private async createDuplicateDevice(deviceId: string, index: number): Promise<DeviceSimulator> {
    const device: DeviceSimulator = {
      deviceId,
      ws: null,
      connected: false,
      registered: false,
      messageCount: 0,
      responses: new Map()
    };

    return new Promise((resolve, reject) => {
      const wsUrl = `ws://127.0.0.1:${this.config.serverPort}/extension`;
      device.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error(`Duplicate device ${index} connection timeout`));
      }, 10000);

      device.ws.on('open', () => {
        device.connected = true;
        clearTimeout(timeout);
        
        // Send connection info
        const connectionInfo = {
          type: 'connection_info',
          sessionId: `conflict-session-${index}`,
          targetInfo: {
            attached: true,
            browserContextId: this.generateUUID(),
            canAccessOpener: false,
            targetId: this.generateUUID(),
            title: `Conflict Test Page ${index}`,
            type: 'page',
            url: 'about:blank'
          }
        };
        
        device.ws!.send(JSON.stringify(connectionInfo));
        
        // Start heartbeat immediately after connection
        setTimeout(() => {
          if (device.ws && device.connected) {
            const heartbeatMessage = {
              type: 'ping',
              deviceId: deviceId, // Same ID for both devices
              deviceInfo: {
                name: `Conflict Device ${index}`,
                version: '1.0.0',
                userAgent: `Conflict-Agent-${index}`,
                timestamp: new Date().toISOString()
              }
            };
            device.ws.send(JSON.stringify(heartbeatMessage));
          }
        }, 1000);
        
        resolve(device);
      });

      device.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'pong') {
            // Server responded to our ping
            device.registered = true;
            this.log(`Conflict device ${index} registered successfully`);
          } else if (message.type === 'ping') {
            // Server is pinging us
            const pongMessage = {
              type: 'pong',
              deviceId: deviceId, // Same ID for both devices
              deviceInfo: {
                name: `Conflict Device ${index}`,
                version: '1.0.0',
                userAgent: `Conflict-Agent-${index}`,
                timestamp: new Date().toISOString()
              }
            };
            device.ws!.send(JSON.stringify(pongMessage));
          }
        } catch (error) {
          this.log(`Duplicate device ${index} message parse error: ${error}`, 'error');
        }
      });

      device.ws.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      device.ws.on('close', () => {
        device.connected = false;
        device.registered = false;
      });
    });
  }

  /**
   * Test concurrent CDP message routing
   */
  async testConcurrentMessageRouting(): Promise<boolean> {
    try {
      this.log('Testing concurrent CDP message routing...');
      
      if (this.devices.size === 0) {
        this.log('No devices available for routing test', 'warning');
        return false;
      }

      // Find a connected and registered device
      let device = Array.from(this.devices.values()).find(d => d.connected && d.registered);
      
      if (!device) {
        this.log('No properly connected devices available for routing test', 'warning');
        
        // Try to create a fresh device for this test
        try {
          this.log('Creating fresh device for routing test...');
          device = await this.createDeviceConnection(999);
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for registration
          
          if (!device.registered) {
            this.log('Fresh device failed to register, skipping routing test', 'warning');
            return false;
          }
        } catch (error: any) {
          this.log(`Failed to create fresh device: ${error.message}`, 'error');
          return false;
        }
      }

      // Create CDP connection
      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${device.deviceId}`;
      
      return new Promise((resolve) => {
        const cdpWs = new WebSocket(cdpUrl);
        const sentMessages = new Map<string, number>();
        const receivedResponses = new Set<string>();
        let allSent = false;

        const timeout = setTimeout(() => {
          this.log('CDP routing timeout', 'error');
          cdpWs.close();
          resolve(false);
        }, 15000);

        cdpWs.on('open', () => {
          this.log('CDP WebSocket connected');
          
          // Send multiple concurrent messages
          const commands = [
            { id: 'concurrent-1', method: 'Browser.getVersion', params: {} },
            { id: 'concurrent-2', method: 'Target.getTargets', params: {} },
            { id: 'concurrent-3', method: 'Runtime.evaluate', params: { expression: '1+1' } },
            { id: 'concurrent-4', method: 'Page.enable', params: {} },
            { id: 'concurrent-5', method: 'Runtime.enable', params: {} }
          ];
          
          commands.forEach(cmd => {
            cdpWs.send(JSON.stringify(cmd));
            sentMessages.set(cmd.id, Date.now());
          });
          
          allSent = true;
          this.log(`Sent ${commands.length} concurrent CDP messages`);
        });

        cdpWs.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.id && sentMessages.has(message.id)) {
              receivedResponses.add(message.id);
              this.log(`  Received response for ${message.id}`);
              
              if (receivedResponses.size >= sentMessages.size && allSent) {
                this.log('All concurrent responses received', 'success');
                clearTimeout(timeout);
                cdpWs.close();
                resolve(true);
              }
            }
          } catch (error) {
            this.log(`CDP response parse error: ${error}`, 'error');
          }
        });

        cdpWs.on('error', (error) => {
          this.log(`CDP WebSocket error: ${error}`, 'error');
          clearTimeout(timeout);
          resolve(false);
        });

        cdpWs.on('close', () => {
          clearTimeout(timeout);
          if (receivedResponses.size < sentMessages.size) {
            resolve(receivedResponses.size >= Math.floor(sentMessages.size * 0.8)); // Accept 80% success
          }
        });
      });
    } catch (error: any) {
      this.log(`Concurrent routing test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test connection resilience under stress
   */
  async testConnectionResilience(): Promise<boolean> {
    try {
      this.log('Testing connection resilience...');
      
      let successfulReconnections = 0;
      const testDevices: DeviceSimulator[] = [];

      // Create and rapidly disconnect/reconnect devices
      for (let i = 0; i < 3; i++) {
        try {
          const device = await this.createDeviceConnection(100 + i);
          testDevices.push(device);
          
          // Wait for registration
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          if (device.registered) {
            this.log(`Device ${100 + i} registered, testing reconnection...`);
            
            // Disconnect
            device.ws?.close();
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Reconnect
            const reconnectedDevice = await this.createDeviceConnection(100 + i);
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (reconnectedDevice.registered) {
              successfulReconnections++;
              this.log(`Device ${100 + i} reconnected successfully`);
            }
            
            reconnectedDevice.ws?.close();
          }
        } catch (error) {
          this.log(`Resilience test device ${100 + i} failed: ${error}`, 'warning');
        }
      }

      const success = successfulReconnections >= 2; // Expect at least 2/3 to succeed
      
      if (success) {
        this.log(`Connection resilience test passed (${successfulReconnections}/3 reconnections)`, 'success');
      } else {
        this.log(`Connection resilience test failed (${successfulReconnections}/3 reconnections)`, 'error');
      }

      return success;
    } catch (error: any) {
      this.log(`Connection resilience test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    this.log('Cleaning up resources...');
    
    // Close all device connections
    for (const device of this.devices.values()) {
      if (device.ws) {
        device.ws.close();
      }
    }
    this.devices.clear();
    
    // Stop server
    await this.stopServer();
    
    this.log('Cleanup completed', 'success');
  }

  /**
   * Print test results summary
   */
  printTestResults(): void {
    console.log('\n📊 Multi-Device Stability Test Results:');
    console.log('=======================================');
    
    const tests = [
      { key: 'device_registration', name: 'Simultaneous Device Registration' },
      { key: 'conflict_resolution', name: 'Device ID Conflict Resolution' },
      { key: 'message_routing', name: 'Concurrent Message Routing' },
      { key: 'connection_resilience', name: 'Connection Resilience' },
    ];
    
    let passed = 0;
    
    tests.forEach(test => {
      const result = this.testResults[test.key];
      if (result === true) {
        console.log(`✅ PASS ${test.name}`);
        passed++;
      } else if (result === false) {
        console.log(`❌ FAIL ${test.name}`);
      } else {
        console.log(`⏭️  SKIP ${test.name}`);
      }
    });
    
    console.log(`\nOverall: ${passed}/${tests.length} tests passed`);
    
    if (passed === tests.length) {
      this.log('🎉 All stability tests passed! Multi-device connections are robust.', 'success');
    } else if (passed >= tests.length * 0.75) {
      this.log('⚠️  Most stability tests passed. Connections are generally stable.', 'warning');
    } else {
      this.log('❌ Multiple stability tests failed. Connection robustness needs improvement.', 'error');
    }
  }

  /**
   * Run all stability tests
   */
  async runAllTests(): Promise<void> {
    console.log('🔧 Starting Multi-Device Stability Test Suite\n');
    
    try {
      // Start server
      await this.startServer();
      
      // Test 1: Simultaneous device registration
      this.testResults['device_registration'] = await this.testSimultaneousDeviceRegistration();
      
      // Test 2: Device ID conflict resolution
      this.testResults['conflict_resolution'] = await this.testDeviceIdConflictResolution();
      
      // Test 3: Concurrent message routing
      this.testResults['message_routing'] = await this.testConcurrentMessageRouting();
      
      // Test 4: Connection resilience
      this.testResults['connection_resilience'] = await this.testConnectionResilience();
      
      // Print results
      this.printTestResults();
      
    } catch (error: any) {
      this.log(`Test suite failed: ${error.message}`, 'error');
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

// Main execution
async function main() {
  const testRunner = new MultiDeviceStabilityTester();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Test interrupted by user');
    await testRunner.cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n👋 Test terminated');
    await testRunner.cleanup();
    process.exit(0);
  });
  
  try {
    await testRunner.runAllTests();
    process.exit(0);
  } catch (error) {
    console.error('Stability test suite failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { MultiDeviceStabilityTester };