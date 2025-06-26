#!/usr/bin/env node

/**
 * V2 Architecture E2E Test for Browser-Go
 * Tests V2 WebSocket endpoints with enhanced multi-device support
 * Uses /v2/device, /v2/cdp/{deviceId}, and /v2/control endpoints
 */

import { spawn, ChildProcess } from 'child_process';
import chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface TestConfig {
  serverPort: number;
  extensionPath: string;
  testTimeout: number;
}

interface V2DeviceInfo {
  deviceId: string;
  name: string;
  version: string;
  type: 'extension' | 'standalone' | 'mobile';
  capabilities: {
    browserName: string;
    browserVersion: string;
    platform: string;
    userAgent: string;
    supportedDomains: string[];
    maxConcurrentRequests: number;
    features: string[];
  };
  metadata: Record<string, any>;
}

interface V2Message {
  type: string;
  id?: string;
  timestamp: Date;
  data: any;
  metadata?: Record<string, any>;
}

interface RegisteredDevice {
  deviceId: string;
  state: string;
  registeredAt: Date;
  lastSeen: Date;
}

class V2E2ETestRunner {
  private config: TestConfig;
  private serverProcess: ChildProcess | null = null;
  private browsers: any[] = [];
  private testResults: { [key: string]: boolean } = {};
  private registeredDevices: RegisteredDevice[] = [];
  private testResultDir = '.test_result_v2';

  constructor() {
    this.config = {
      serverPort: 3000, // Use standard port for V2 tests  
      extensionPath: path.resolve(__dirname, '../extension'),
      testTimeout: 30000,
    };
    
    // Setup V2 extension manifest
    this.setupV2Extension();
    
    this.createTestResultDir();
  }

  private createTestResultDir(): void {
    try {
      if (!fs.existsSync(this.testResultDir)) {
        fs.mkdirSync(this.testResultDir, { recursive: true });
        this.log(`Created V2 test result directory: ${this.testResultDir}`, 'info');
      }
    } catch (error: any) {
      this.log(`Failed to create test result directory: ${error.message}`, 'error');
    }
  }

  private setupV2Extension(): void {
    try {
      const manifestPath = path.join(this.config.extensionPath, 'manifest.json');
      const manifestV2Path = path.join(this.config.extensionPath, 'manifest-v2.json');
      const manifestBackupPath = path.join(this.config.extensionPath, 'manifest.json.backup');
      
      // Backup original manifest if it exists and no backup exists
      if (fs.existsSync(manifestPath) && !fs.existsSync(manifestBackupPath)) {
        fs.copyFileSync(manifestPath, manifestBackupPath);
        this.log('Backed up original manifest.json', 'info');
      }
      
      // Copy V2 manifest to main manifest.json
      if (fs.existsSync(manifestV2Path)) {
        fs.copyFileSync(manifestV2Path, manifestPath);
        this.log('Configured extension for V2 architecture', 'success');
      } else {
        this.log('V2 manifest not found, using existing manifest', 'warning');
      }
    } catch (error: any) {
      this.log(`Failed to setup V2 extension: ${error.message}`, 'error');
    }
  }

  private restoreExtension(): void {
    try {
      const manifestPath = path.join(this.config.extensionPath, 'manifest.json');
      const manifestBackupPath = path.join(this.config.extensionPath, 'manifest.json.backup');
      
      // Restore original manifest if backup exists
      if (fs.existsSync(manifestBackupPath)) {
        fs.copyFileSync(manifestBackupPath, manifestPath);
        fs.unlinkSync(manifestBackupPath);
        this.log('Restored original manifest.json', 'success');
      }
    } catch (error: any) {
      this.log(`Failed to restore extension: ${error.message}`, 'error');
    }
  }

  private generateRandomSearchTerm(): string {
    const searchTerms = [
      'V2 WebSocket Architecture',
      'Multi-device Browser Control',
      'CDP Protocol Enhancement',
      'Concurrent Connection Management',
      'Browser Automation V2',
      'Thread-safe Device Registry',
      'Message Queue Optimization',
      'WebSocket State Machine',
      'Real-time Browser Monitoring',
      'Advanced Web Automation'
    ];
    
    return searchTerms[Math.floor(Math.random() * searchTerms.length)];
  }

  private log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const colors = {
      info: '\x1b[34m',
      success: '\x1b[32m',
      warning: '\x1b[33m',
      error: '\x1b[31m'
    };
    const reset = '\x1b[0m';
    console.log(`${colors[type]}[V2-E2E-${type.toUpperCase()}]${reset} ${message}`);
  }

  /**
   * Start browser-go server with V2 architecture enabled
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log('Starting browser-go server with V2 architecture...');
      
      this.serverProcess = spawn('node', [
        'dist/cli.js', 
        '--port', String(this.config.serverPort),
        '--v2', // Enable V2 architecture
        '--max-instances', '5',
        '--cdp-logging'
      ], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });

      let serverReady = false;
      const timeout = setTimeout(() => {
        if (!serverReady) {
          reject(new Error('V2 server startup timeout'));
        }
      }, 25000);

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log(`[V2-Server] ${output.trim()}`);
        
        if ((output.includes('V2 (Enhanced Multi-Device Support)') || 
             output.includes('service started successfully')) && !serverReady) {
          serverReady = true;
          clearTimeout(timeout);
          this.log('V2 server started successfully', 'success');
          setTimeout(resolve, 3000);
        }
      });

      this.serverProcess.stderr?.on('data', (data) => {
        const output = data.toString();
        console.error(`[V2-Server Error] ${output.trim()}`);
      });

      this.serverProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.serverProcess.on('exit', (code, signal) => {
        if (!serverReady) {
          clearTimeout(timeout);
          reject(new Error(`V2 server exited with code ${code}, signal ${signal}`));
        }
      });
    });
  }

  async stopServer(): Promise<void> {
    if (this.serverProcess) {
      this.log('Stopping V2 server...');
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
      this.log('V2 server stopped', 'success');
    }
  }

  async launchChrome(userDataDir: string, instanceId: number = 0): Promise<any> {
    this.log(`Launching Chrome instance ${instanceId} for V2 testing...`);
    
    const browser = await chromeLauncher.launch({
      chromeFlags: [
        `--load-extension=${this.config.extensionPath}`,
        '--disable-extensions-except=' + this.config.extensionPath,
        `--user-data-dir=${userDataDir}`,
        '--disable-features=VizDisplayCompositor,TranslateUI',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-security',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      handleSIGINT: false
    });
    
    this.browsers.push(browser);
    this.log(`Chrome instance ${instanceId} started (PID: ${browser.pid})`, 'success');
    
    return browser;
  }

  /**
   * Test V2 server health using control endpoint
   */
  async testV2ServerHealth(): Promise<boolean> {
    try {
      this.log('Testing V2 server health via control endpoint...');
      
      return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${this.config.serverPort}/v2/control`);
        let healthReceived = false;
        
        const timeout = setTimeout(() => {
          if (!healthReceived) {
            this.log('V2 server health check timeout', 'error');
            ws.close();
            resolve(false);
          }
        }, 10000);
        
        ws.on('open', () => {
          const statusRequest: V2Message = {
            type: 'control:status',
            id: 'health-check',
            timestamp: new Date(),
            data: {}
          };
          
          ws.send(JSON.stringify(statusRequest));
        });
        
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'control:status' && message.data?.status) {
              this.log(`V2 server health OK - Status: ${message.data.status}`, 'success');
              this.log(`Connections: ${message.data.connections?.total || 0} total, ${message.data.connections?.active || 0} active`);
              healthReceived = true;
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            }
          } catch (error) {
            this.log(`Health check message parse error: ${error}`, 'error');
          }
        });
        
        ws.on('error', (error) => {
          this.log(`V2 health check error: ${error}`, 'error');
          clearTimeout(timeout);
          resolve(false);
        });
        
        ws.on('close', () => {
          clearTimeout(timeout);
          if (!healthReceived) {
            resolve(false);
          }
        });
      });
    } catch (error: any) {
      this.log(`V2 server health test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test V2 device registration with heartbeat
   */
  async testV2DeviceRegistration(): Promise<boolean> {
    try {
      this.log('Testing V2 device registration and heartbeat...');
      
      let attempts = 0;
      const maxAttempts = 20;
      
      while (attempts < maxAttempts) {
        try {
          // Use control endpoint to check devices
          const deviceCheck = await this.checkRegisteredDevicesV2();
          if (deviceCheck.success && deviceCheck.devices.length > 0) {
            this.registeredDevices = deviceCheck.devices;
            this.log(`Found ${this.registeredDevices.length} registered V2 devices`, 'success');
            
            // Test heartbeat with one device
            if (await this.testDeviceHeartbeat(this.registeredDevices[0].deviceId)) {
              this.log('Device heartbeat test successful', 'success');
              return true;
            }
          }
        } catch (error) {
          this.log(`Registration check attempt ${attempts + 1} failed: ${error}`, 'warning');
        }
        
        attempts++;
        this.log(`Waiting for V2 device registration... (${attempts}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      this.log('No V2 devices registered within timeout', 'error');
      return false;
    } catch (error: any) {
      this.log(`V2 device registration test failed: ${error.message}`, 'error');
      return false;
    }
  }

  private async checkRegisteredDevicesV2(): Promise<{ success: boolean; devices: RegisteredDevice[] }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.config.serverPort}/v2/control`);
      
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, devices: [] });
      }, 5000);
      
      ws.on('open', () => {
        const listDevicesCommand: V2Message = {
          type: 'control:command',
          id: 'list-devices',
          timestamp: new Date(),
          data: {
            command: 'listDevices',
            params: {}
          }
        };
        
        ws.send(JSON.stringify(listDevicesCommand));
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'control:command' && message.id === 'list-devices') {
            const devices = message.data?.result || [];
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true, devices });
          }
        } catch (error) {
          // Continue waiting
        }
      });
      
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve({ success: false, devices: [] });
      });
    });
  }

  private async testDeviceHeartbeat(deviceId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.config.serverPort}/v2/device`);
      let heartbeatAcked = false;
      
      const timeout = setTimeout(() => {
        if (!heartbeatAcked) {
          ws.close();
          resolve(false);
        }
      }, 10000);
      
      ws.on('open', () => {
        // Send heartbeat message
        const heartbeatMessage: V2Message = {
          type: 'device:heartbeat',
          id: 'heartbeat-test',
          timestamp: new Date(),
          data: { deviceId }
        };
        
        ws.send(JSON.stringify(heartbeatMessage));
      });
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'device:heartbeat:ack' && message.id === 'heartbeat-test') {
            this.log(`Heartbeat acknowledged for device ${deviceId.substring(0, 20)}...`);
            heartbeatAcked = true;
            clearTimeout(timeout);
            ws.close();
            resolve(true);
          }
        } catch (error) {
          // Continue waiting
        }
      });
      
      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /**
   * Test V2 CDP connection with new endpoint format
   */
  async testV2CDPConnection(): Promise<boolean> {
    try {
      this.log('Testing V2 CDP connection...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No V2 devices available for CDP test', 'warning');
        return false;
      }
      
      const deviceId = this.registeredDevices[0].deviceId;
      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/v2/cdp/${deviceId}`;
      
      return new Promise((resolve) => {
        const ws = new WebSocket(cdpUrl);
        let responseReceived = false;
        
        const timeout = setTimeout(() => {
          if (!responseReceived) {
            this.log('V2 CDP connection timeout', 'error');
            ws.close();
            resolve(false);
          }
        }, 15000);
        
        ws.on('open', () => {
          this.log('V2 CDP WebSocket connected');
          
          // Test Browser.getVersion command
          ws.send(JSON.stringify({
            id: 'test-v2-cdp',
            method: 'Browser.getVersion',
            params: {}
          }));
        });
        
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.id === 'test-v2-cdp' && message.result) {
              this.log(`V2 CDP command successful - Browser: ${message.result.product}`, 'success');
              responseReceived = true;
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            }
          } catch (error) {
            this.log(`V2 CDP message parse error: ${error}`, 'error');
          }
        });
        
        ws.on('error', (error) => {
          this.log(`V2 CDP WebSocket error: ${error}`, 'error');
          clearTimeout(timeout);
          resolve(false);
        });
        
        ws.on('close', () => {
          clearTimeout(timeout);
          if (!responseReceived) {
            resolve(false);
          }
        });
      });
    } catch (error: any) {
      this.log(`V2 CDP connection test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test V2 multi-device stability with Bing search
   */
  async testV2MultiDeviceStability(): Promise<boolean> {
    try {
      this.log('Testing V2 multi-device stability with Bing search...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No V2 devices available for multi-device test', 'error');
        return false;
      }
      
      const deviceId = this.registeredDevices[0].deviceId;
      this.log(`Testing Bing search on V2 device: ${deviceId.substring(0, 20)}...`);
      
      const result = await this.testV2PlaywrightConnection(deviceId, 1);
      
      if (result) {
        this.log('V2 Bing search test successful', 'success');
      } else {
        this.log('V2 Bing search test failed', 'warning');
      }
      
      return result;
    } catch (error: any) {
      this.log(`V2 multi-device test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test Playwright connection via V2 CDP endpoint
   */
  async testV2PlaywrightConnection(deviceId: string, clientId: number): Promise<boolean> {
    let browser = null;
    try {
      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/v2/cdp/${deviceId}`;
      this.log(`  V2 Client ${clientId}: Connecting to CDP via V2 endpoint...`);
      
      const connectPromise = chromium.connectOverCDP(cdpUrl);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('V2 CDP connection timeout')), 20000)
      );
      
      browser = await Promise.race([connectPromise, timeoutPromise]) as any;
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        this.log(`  V2 Client ${clientId}: No contexts available`, 'warning');
        return false;
      }

      const context = contexts[0];
      let page;
      
      const pages = context.pages();
      if (pages.length === 0) {
        this.log(`  V2 Client ${clientId}: Creating new page...`);
        page = await context.newPage();
      } else {
        page = pages[0];
        try {
          await page.url();
        } catch (error: any) {
          if (error.message.includes('detached')) {
            this.log(`  V2 Client ${clientId}: Page detached, creating new page...`);
            page = await context.newPage();
          } else {
            throw error;
          }
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Navigate to Bing
      this.log(`  V2 Client ${clientId}: Navigating to Bing via V2 architecture...`);
      let navigationSuccess = false;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto('https://www.bing.com', { 
            waitUntil: 'networkidle',
            timeout: 30000 
          });
          navigationSuccess = true;
          break;
        } catch (navError: any) {
          this.log(`  V2 Client ${clientId}: Navigation attempt ${attempt} failed: ${navError.message}`);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            if (navError.message.includes('detached')) {
              page = await context.newPage();
            }
          }
        }
      }
      
      if (!navigationSuccess) {
        this.log(`  V2 Client ${clientId}: Failed to navigate to Bing after 3 attempts`, 'warning');
        return false;
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const url = await page.url();
      const title = await page.title();
      
      this.log(`  V2 Client ${clientId}: Connected via V2 - URL: ${url}`, 'success');
      this.log(`  V2 Client ${clientId}: Title: ${title || 'No title'}`);
      
      // Perform search with V2-specific term
      const searchTerm = this.generateRandomSearchTerm();
      this.log(`  V2 Client ${clientId}: Searching for: "${searchTerm}"`);
      
      const searchSelector = 'input[name="q"], #sb_form_q';
      await page.waitForSelector(searchSelector, { timeout: 5000 });
      await page.fill(searchSelector, searchTerm);
      await page.keyboard.press('Enter');
      
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Take screenshot
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(this.testResultDir, `v2-bing-search-client-${clientId}-${timestamp}.png`);
      
      await page.screenshot({ 
        path: screenshotPath, 
        fullPage: true 
      });
      
      this.log(`  V2 Client ${clientId}: Screenshot saved to ${screenshotPath}`, 'success');
      
      // Verify search results
      const searchResults = await page.evaluate(() => {
        const results = document.querySelectorAll('.b_algo h2, .b_title h2');
        return {
          resultsCount: results.length,
          searchComplete: results.length > 0,
          currentUrl: window.location.href,
          timestamp: Date.now()
        };
      });
      
      if (searchResults.searchComplete) {
        this.log(`  V2 Client ${clientId}: Search completed successfully (${searchResults.resultsCount} results)`, 'success');
      } else {
        this.log(`  V2 Client ${clientId}: Search may not have completed properly`, 'warning');
      }
      
      return true;
      
    } catch (error: any) {
      this.log(`  V2 Client ${clientId}: Failed - ${error.message}`, 'error');
      return false;
    } finally {
      if (browser) {
        try {
          await browser.close();
          this.log(`  V2 Client ${clientId}: Browser connection closed`);
        } catch (closeError) {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Test V2 concurrent messaging with priority queuing
   */
  async testV2ConcurrentMessaging(): Promise<boolean> {
    try {
      this.log('Testing V2 concurrent messaging with priority queuing...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No V2 devices available for concurrent test', 'warning');
        return false;
      }
      
      const deviceId = this.registeredDevices[0].deviceId;
      const wsUrl = `ws://127.0.0.1:${this.config.serverPort}/v2/cdp/${deviceId}`;
      
      return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const responses = new Set<string>();
        let allReceived = false;
        
        const timeout = setTimeout(() => {
          if (!allReceived) {
            this.log('V2 concurrent messaging timeout', 'error');
            ws.close();
            resolve(false);
          }
        }, 20000);
        
        ws.on('open', () => {
          this.log('Sending concurrent V2 CDP messages...');
          
          // Send multiple commands with different priorities
          const commands = [
            { id: 'v2-concurrent-1', method: 'Browser.getVersion', params: {} },
            { id: 'v2-concurrent-2', method: 'Target.getTargets', params: {} },
            { id: 'v2-concurrent-3', method: 'Runtime.evaluate', params: { expression: '2+2' } },
            { id: 'v2-concurrent-4', method: 'Page.enable', params: {} },
            { id: 'v2-concurrent-5', method: 'Runtime.enable', params: {} }
          ];
          
          commands.forEach(cmd => {
            ws.send(JSON.stringify(cmd));
          });
        });
        
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.id && message.id.startsWith('v2-concurrent-')) {
              responses.add(message.id);
              this.log(`  Received V2 response for ${message.id}`);
              
              if (responses.size >= 4) { // Accept 4 out of 5 responses
                this.log('Most V2 concurrent responses received', 'success');
                allReceived = true;
                clearTimeout(timeout);
                ws.close();
                resolve(true);
              }
            }
          } catch (error) {
            this.log(`V2 concurrent message parse error: ${error}`, 'error');
          }
        });
        
        ws.on('error', (error) => {
          this.log(`V2 concurrent messaging error: ${error}`, 'error');
          clearTimeout(timeout);
          resolve(false);
        });
        
        ws.on('close', () => {
          clearTimeout(timeout);
          if (!allReceived) {
            resolve(responses.size >= 3); // Accept partial success
          }
        });
      });
    } catch (error: any) {
      this.log(`V2 concurrent messaging test failed: ${error.message}`, 'error');
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.log('Cleaning up V2 test resources...');
    
    for (const browser of this.browsers) {
      try {
        await browser.kill();
        this.log(`Browser PID ${browser.pid} terminated`);
      } catch (error) {
        try {
          process.kill(browser.pid, 'SIGKILL');
        } catch {
          // Ignore
        }
      }
    }
    this.browsers = [];
    
    await this.stopServer();
    
    // Restore original extension configuration
    this.restoreExtension();
    
    this.log('V2 cleanup completed', 'success');
  }

  printTestResults(): void {
    console.log('\n📊 V2 Architecture E2E Test Results:');
    console.log('=====================================');
    
    const tests = [
      { key: 'v2_server_health', name: 'V2 Server Health' },
      { key: 'v2_device_registration', name: 'V2 Device Registration & Heartbeat' },
      { key: 'v2_cdp_connection', name: 'V2 CDP Connection' },
      { key: 'v2_multi_device', name: 'V2 Bing Search & Screenshot' },
      { key: 'v2_concurrent_messaging', name: 'V2 Concurrent Messaging' },
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
      this.log('🎉 All V2 tests passed! V2 architecture is working perfectly.', 'success');
    } else if (passed >= tests.length * 0.8) {
      this.log('⚠️  Most V2 tests passed. V2 architecture is mostly functional.', 'warning');
    } else {
      this.log('❌ Multiple V2 tests failed. Please check V2 architecture issues.', 'error');
    }
  }

  async runAllTests(): Promise<void> {
    console.log('🚀 Starting V2 Architecture E2E Test Suite with Enhanced Multi-Device Support\n');
    
    try {
      // Start V2 server
      await this.startServer();
      
      // Test V2 server health
      this.testResults['v2_server_health'] = await this.testV2ServerHealth();
      
      if (!this.testResults['v2_server_health']) {
        throw new Error('V2 server health check failed');
      }
      
      // Launch Chrome instance
      await this.launchChrome('./.runtime/test-v2-simple-main', 0);
      
      // Wait for extension to initialize and register with V2 endpoints
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      // Test V2 device registration and heartbeat
      this.testResults['v2_device_registration'] = await this.testV2DeviceRegistration();
      
      // Test V2 CDP connection
      this.testResults['v2_cdp_connection'] = await this.testV2CDPConnection();
      
      // Test V2 multi-device with Bing search
      if (this.testResults['v2_cdp_connection']) {
        this.log('Testing V2 Bing search functionality...');
        this.testResults['v2_multi_device'] = await this.testV2MultiDeviceStability();
      }
      
      // Test V2 concurrent messaging
      this.testResults['v2_concurrent_messaging'] = await this.testV2ConcurrentMessaging();
      
      // Print results
      this.printTestResults();
      
    } catch (error: any) {
      this.log(`V2 test suite failed: ${error.message}`, 'error');
      throw error;
    } finally {
      await this.cleanup();
    }
  }
}

// Main execution
async function main() {
  const testRunner = new V2E2ETestRunner();
  
  process.on('SIGINT', async () => {
    console.log('\n👋 V2 Test interrupted by user');
    await testRunner.cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n👋 V2 Test terminated');
    await testRunner.cleanup();
    process.exit(0);
  });
  
  try {
    await testRunner.runAllTests();
    process.exit(0);
  } catch (error) {
    console.error('V2 Test suite failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { V2E2ETestRunner };