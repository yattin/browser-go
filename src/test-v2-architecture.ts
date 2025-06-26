#!/usr/bin/env node

/**
 * Browser-Go V2 Architecture Test
 * Tests the new WebSocket architecture with separated endpoints and improved stability
 */

import { createServer, Server } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { URL } from 'url';
import {
  V2Config,
  DeviceInfo,
  DeviceCapabilities,
  MessageType,
  V2Message,
  CDPMessage,
  ConnectionState
} from './v2-types.js';
import { V2DeviceRegistry } from './v2-device-registry.js';
import { V2MessageRouter } from './v2-message-router.js';
import { V2WebSocketHandlers } from './v2-websocket-handlers.js';
import { logger } from './logger.js';

interface TestResults {
  [testName: string]: boolean;
}

class V2ArchitectureTest {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private deviceRegistry: V2DeviceRegistry;
  private messageRouter: V2MessageRouter;
  private wsHandlers: V2WebSocketHandlers;
  private testResults: TestResults = {};
  private config: V2Config;

  constructor() {
    this.config = {
      heartbeatInterval: 5000,
      connectionTimeout: 10000,
      messageTimeout: 5000,
      maxQueueSize: 100,
      maxRetries: 3,
      retryDelay: 1000,
      maxConcurrentConnections: 10,
      maxConcurrentMessages: 20,
      metricsInterval: 1000,
      enableDetailedLogging: true
    };

    this.deviceRegistry = new V2DeviceRegistry(this.config);
    this.messageRouter = new V2MessageRouter(this.deviceRegistry, this.config);
    this.wsHandlers = new V2WebSocketHandlers(this.deviceRegistry, this.messageRouter, this.config);
  }

  private log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const colors = {
      info: '\x1b[34m',    // Blue
      success: '\x1b[32m', // Green
      warning: '\x1b[33m', // Yellow
      error: '\x1b[31m'    // Red
    };
    const reset = '\x1b[0m';
    console.log(`${colors[type]}[V2-TEST]${reset} ${message}`);
  }

  async startServer(port: number = 3001): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer();
      this.wss = new WebSocketServer({ 
        server: this.server
      });

      // Handle WebSocket connections with routing
      this.wss.on('connection', async (ws, req) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const pathSegments = url.pathname.split('/').filter(Boolean);

        try {
          if (pathSegments.length >= 2 && pathSegments[0] === 'v2') {
            const endpoint = pathSegments[1];
            
            switch (endpoint) {
              case 'device':
                await this.wsHandlers.handleDeviceEndpoint(ws, req);
                break;
              case 'cdp':
                await this.wsHandlers.handleCDPEndpoint(ws, req);
                break;
              case 'control':
                await this.wsHandlers.handleControlEndpoint(ws, req);
                break;
              default:
                ws.close(4000, `Unknown endpoint: ${endpoint}`);
            }
          } else {
            ws.close(4000, 'Invalid path - use /v2/{device|cdp|control}');
          }
        } catch (error) {
          logger.error('WebSocket connection error:', error);
          ws.close(4001, 'Internal server error');
        }
      });

      this.server.listen(port, () => {
        this.log(`V2 test server started on port ${port}`, 'success');
        resolve();
      });

      this.server.on('error', (error) => {
        reject(error);
      });
    });
  }

  async stopServer(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => {
          if (this.server) {
            this.server.close(() => {
              this.log('V2 test server stopped', 'success');
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  async testDeviceRegistration(): Promise<boolean> {
    this.log('Testing device registration...');
    
    return new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:3001/v2/device');
      let registrationSuccessful = false;

      ws.on('open', () => {
        const deviceInfo: DeviceInfo = {
          deviceId: 'test-device-001',
          name: 'Test Device',
          version: '1.0.0',
          type: 'extension',
          capabilities: {
            browserName: 'Chrome',
            browserVersion: '120.0.0.0',
            platform: 'macOS',
            userAgent: 'Test User Agent',
            supportedDomains: ['Runtime', 'Page', 'Target'],
            maxConcurrentRequests: 10,
            features: ['screenshots', 'navigation']
          },
          metadata: { test: true }
        };

        const registerMessage: V2Message = {
          type: MessageType.DEVICE_REGISTER,
          id: 'reg-001',
          timestamp: new Date(),
          data: { deviceInfo }
        };

        ws.send(JSON.stringify(registerMessage));
      });

      ws.on('message', (data) => {
        try {
          const message: V2Message = JSON.parse(data.toString());
          
          if (message.type === MessageType.DEVICE_REGISTER_ACK) {
            this.log('Device registration successful', 'success');
            registrationSuccessful = true;
            ws.close();
          }
        } catch (error) {
          this.log(`Registration message parse error: ${error}`, 'error');
        }
      });

      ws.on('close', () => {
        resolve(registrationSuccessful);
      });

      ws.on('error', (error) => {
        this.log(`Registration error: ${error}`, 'error');
        resolve(false);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!registrationSuccessful) {
          ws.close();
          resolve(false);
        }
      }, 10000);
    });
  }

  async testHeartbeat(): Promise<boolean> {
    this.log('Testing heartbeat mechanism...');
    
    return new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:3001/v2/device');
      let deviceRegistered = false;
      let heartbeatReceived = false;

      ws.on('open', () => {
        const deviceInfo: DeviceInfo = {
          deviceId: 'test-device-heartbeat',
          name: 'Heartbeat Test Device',
          version: '1.0.0',
          type: 'extension',
          capabilities: {
            browserName: 'Chrome',
            browserVersion: '120.0.0.0',
            platform: 'macOS',
            userAgent: 'Test User Agent',
            supportedDomains: ['Runtime'],
            maxConcurrentRequests: 5,
            features: []
          },
          metadata: {}
        };

        const registerMessage: V2Message = {
          type: MessageType.DEVICE_REGISTER,
          id: 'hb-reg-001',
          timestamp: new Date(),
          data: { deviceInfo }
        };

        ws.send(JSON.stringify(registerMessage));
      });

      ws.on('message', (data) => {
        try {
          const message: V2Message = JSON.parse(data.toString());
          
          if (message.type === MessageType.DEVICE_REGISTER_ACK) {
            deviceRegistered = true;
            
            // Send heartbeat
            const heartbeatMessage: V2Message = {
              type: MessageType.DEVICE_HEARTBEAT,
              id: 'hb-001',
              timestamp: new Date(),
              data: {}
            };
            
            ws.send(JSON.stringify(heartbeatMessage));
          } else if (message.type === MessageType.DEVICE_HEARTBEAT_ACK) {
            this.log('Heartbeat acknowledged', 'success');
            heartbeatReceived = true;
            ws.close();
          }
        } catch (error) {
          this.log(`Heartbeat message parse error: ${error}`, 'error');
        }
      });

      ws.on('close', () => {
        resolve(deviceRegistered && heartbeatReceived);
      });

      ws.on('error', (error) => {
        this.log(`Heartbeat error: ${error}`, 'error');
        resolve(false);
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!heartbeatReceived) {
          ws.close();
          resolve(false);
        }
      }, 15000);
    });
  }

  async testCDPRouting(): Promise<boolean> {
    this.log('Testing CDP message routing...');
    
    return new Promise(async (resolve) => {
      // First register a device
      const deviceWs = new WebSocket('ws://localhost:3001/v2/device');
      let deviceReady = false;
      const deviceId = 'test-device-cdp';

      deviceWs.on('open', () => {
        const deviceInfo: DeviceInfo = {
          deviceId,
          name: 'CDP Test Device',
          version: '1.0.0',
          type: 'extension',
          capabilities: {
            browserName: 'Chrome',
            browserVersion: '120.0.0.0',
            platform: 'macOS',
            userAgent: 'Test User Agent',
            supportedDomains: ['Runtime', 'Target'],
            maxConcurrentRequests: 10,
            features: []
          },
          metadata: {}
        };

        const registerMessage: V2Message = {
          type: MessageType.DEVICE_REGISTER,
          timestamp: new Date(),
          data: { deviceInfo }
        };

        deviceWs.send(JSON.stringify(registerMessage));
      });

      deviceWs.on('message', (data) => {
        try {
          const message: V2Message = JSON.parse(data.toString());
          
          if (message.type === MessageType.DEVICE_REGISTER_ACK) {
            deviceReady = true;
            
            // Now test CDP connection
            setTimeout(() => {
              const cdpWs = new WebSocket(`ws://localhost:3001/v2/cdp/${deviceId}`);
              let cdpMessageSent = false;
              
              cdpWs.on('open', () => {
                const cdpRequest: CDPMessage = {
                  id: 'cdp-test-001',
                  method: 'Runtime.evaluate',
                  params: { expression: '2 + 2' }
                };
                
                cdpWs.send(JSON.stringify(cdpRequest));
                cdpMessageSent = true;
              });

              cdpWs.on('message', (cdpData) => {
                try {
                  const response = JSON.parse(cdpData.toString());
                  if (response.id === 'cdp-test-001') {
                    this.log('CDP routing successful', 'success');
                    cdpWs.close();
                    deviceWs.close();
                    resolve(true);
                  }
                } catch (error) {
                  this.log(`CDP response parse error: ${error}`, 'error');
                }
              });

              cdpWs.on('error', (error) => {
                this.log(`CDP connection error: ${error}`, 'error');
                deviceWs.close();
                resolve(false);
              });

              // Timeout for CDP test
              setTimeout(() => {
                if (cdpMessageSent) {
                  cdpWs.close();
                  deviceWs.close();
                  resolve(false);
                }
              }, 10000);
            }, 1000);
          }
        } catch (error) {
          this.log(`Device message parse error: ${error}`, 'error');
        }
      });

      deviceWs.on('error', (error) => {
        this.log(`Device connection error: ${error}`, 'error');
        resolve(false);
      });

      // Overall timeout
      setTimeout(() => {
        if (!deviceReady) {
          deviceWs.close();
          resolve(false);
        }
      }, 20000);
    });
  }

  async testControlEndpoint(): Promise<boolean> {
    this.log('Testing control endpoint...');
    
    return new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:3001/v2/control');
      let statusReceived = false;

      ws.on('open', () => {
        const statusRequest: V2Message = {
          type: MessageType.CONTROL_STATUS,
          id: 'status-001',
          timestamp: new Date(),
          data: {}
        };

        ws.send(JSON.stringify(statusRequest));
      });

      ws.on('message', (data) => {
        try {
          const message: V2Message = JSON.parse(data.toString());
          
          if (message.type === MessageType.CONTROL_STATUS) {
            this.log('Control status received', 'success');
            statusReceived = true;
            ws.close();
          }
        } catch (error) {
          this.log(`Control message parse error: ${error}`, 'error');
        }
      });

      ws.on('close', () => {
        resolve(statusReceived);
      });

      ws.on('error', (error) => {
        this.log(`Control error: ${error}`, 'error');
        resolve(false);
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!statusReceived) {
          ws.close();
          resolve(false);
        }
      }, 10000);
    });
  }

  async testMultiDeviceStability(): Promise<boolean> {
    this.log('Testing multi-device stability...');
    
    return new Promise(async (resolve) => {
      const deviceConnections: WebSocket[] = [];
      let registeredDevices = 0;
      const targetDevices = 3;

      for (let i = 0; i < targetDevices; i++) {
        const ws = new WebSocket('ws://localhost:3001/v2/device');
        deviceConnections.push(ws);

        ws.on('open', () => {
          const deviceInfo: DeviceInfo = {
            deviceId: `multi-test-device-${i}`,
            name: `Multi Test Device ${i}`,
            version: '1.0.0',
            type: 'extension',
            capabilities: {
              browserName: 'Chrome',
              browserVersion: '120.0.0.0',
              platform: 'macOS',
              userAgent: 'Test User Agent',
              supportedDomains: ['Runtime'],
              maxConcurrentRequests: 5,
              features: []
            },
            metadata: { index: i }
          };

          const registerMessage: V2Message = {
            type: MessageType.DEVICE_REGISTER,
            timestamp: new Date(),
            data: { deviceInfo }
          };

          ws.send(JSON.stringify(registerMessage));
        });

        ws.on('message', (data) => {
          try {
            const message: V2Message = JSON.parse(data.toString());
            
            if (message.type === MessageType.DEVICE_REGISTER_ACK) {
              registeredDevices++;
              this.log(`Device ${i} registered (${registeredDevices}/${targetDevices})`);
              
              if (registeredDevices >= targetDevices) {
                this.log('All devices registered successfully', 'success');
                
                // Close all connections
                setTimeout(() => {
                  deviceConnections.forEach(conn => conn.close());
                  resolve(true);
                }, 2000);
              }
            }
          } catch (error) {
            this.log(`Multi-device message parse error: ${error}`, 'error');
          }
        });

        ws.on('error', (error) => {
          this.log(`Multi-device connection ${i} error: ${error}`, 'error');
        });

        // Stagger connections
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (registeredDevices < targetDevices) {
          deviceConnections.forEach(conn => conn.close());
          resolve(false);
        }
      }, 30000);
    });
  }

  printResults(): void {
    console.log('\n📊 V2 Architecture Test Results:');
    console.log('==================================');
    
    const tests = [
      { key: 'deviceRegistration', name: 'Device Registration' },
      { key: 'heartbeat', name: 'Heartbeat Mechanism' },
      { key: 'cdpRouting', name: 'CDP Message Routing' },
      { key: 'controlEndpoint', name: 'Control Endpoint' },
      { key: 'multiDeviceStability', name: 'Multi-Device Stability' },
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
      this.log('🎉 All V2 architecture tests passed! New architecture is working correctly.', 'success');
    } else if (passed >= tests.length * 0.8) {
      this.log('⚠️  Most V2 tests passed. Architecture is mostly functional.', 'warning');
    } else {
      this.log('❌ Multiple V2 tests failed. Architecture needs more work.', 'error');
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting V2 Architecture Test Suite\n');
    
    try {
      // Start test server
      await this.startServer();
      
      // Run tests
      this.testResults['deviceRegistration'] = await this.testDeviceRegistration();
      this.testResults['heartbeat'] = await this.testHeartbeat();
      this.testResults['cdpRouting'] = await this.testCDPRouting();
      this.testResults['controlEndpoint'] = await this.testControlEndpoint();
      this.testResults['multiDeviceStability'] = await this.testMultiDeviceStability();
      
      // Print results
      this.printResults();
      
    } catch (error) {
      this.log(`Test suite failed: ${(error as Error).message}`, 'error');
      throw error;
    } finally {
      // Cleanup
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    this.log('Cleaning up...');
    
    try {
      await this.messageRouter.cleanup();
      await this.deviceRegistry.cleanup();
      await this.stopServer();
      this.log('Cleanup completed', 'success');
    } catch (error) {
      this.log(`Cleanup error: ${(error as Error).message}`, 'error');
    }
  }
}

// Main execution
async function main() {
  const testRunner = new V2ArchitectureTest();
  
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
    console.error('V2 architecture test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { V2ArchitectureTest };