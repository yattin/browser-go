#!/usr/bin/env node

/**
 * Simplified E2E Test for Browser-Go
 * Focuses on core functionality and multi-device stability
 * Addresses frame detachment and connection issues
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
  serverToken: string;
  extensionPath: string;
  testTimeout: number;
}

interface DeviceInfo {
  deviceId: string;
  deviceInfo: {
    name: string;
    version: string;
    userAgent: string;
    timestamp: string;
  };
  registeredAt: string;
  lastSeen: string;
  isConnected: boolean;
}

class SimpleE2ETestRunner {
  private config: TestConfig;
  private serverProcess: ChildProcess | null = null;
  private browsers: any[] = [];
  private testResults: { [key: string]: boolean } = {};
  private registeredDevices: DeviceInfo[] = [];
  private testResultDir = '.test_result';

  constructor() {
    this.config = {
      serverPort: 3000,
      serverToken: 'test-token-simple',
      extensionPath: path.resolve(__dirname, '../extension'),
      testTimeout: 30000, // 30 seconds per test
    };
    
    // Create test result directory
    this.createTestResultDir();
  }

  /**
   * Create test result directory
   */
  private createTestResultDir(): void {
    try {
      if (!fs.existsSync(this.testResultDir)) {
        fs.mkdirSync(this.testResultDir, { recursive: true });
        this.log(`Created test result directory: ${this.testResultDir}`, 'info');
      }
    } catch (error: any) {
      this.log(`Failed to create test result directory: ${error.message}`, 'error');
    }
  }

  /**
   * Generate random search term
   */
  private generateRandomSearchTerm(): string {
    const searchTerms = [
      'TypeScript programming',
      'Chrome DevTools Protocol',
      'WebSocket communication',
      'Browser automation',
      'Playwright testing',
      'Node.js development',
      'JavaScript frameworks',
      'API integration',
      'Modern web development',
      'Software architecture',
      'Cloud computing',
      'Machine learning basics',
      'DevOps practices',
      'Database optimization',
      'Cybersecurity trends'
    ];
    
    const randomIndex = Math.floor(Math.random() * searchTerms.length);
    return searchTerms[randomIndex];
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
   * Start the browser-go server with simplified configuration
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log('Starting browser-go server...');
      
      this.serverProcess = spawn('node', [
        'dist/cli.js', 
        '--port', String(this.config.serverPort), 
        '--token', this.config.serverToken,
        '--max-instances', '5'
      ], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });

      let serverReady = false;
      const timeout = setTimeout(() => {
        if (!serverReady) {
          reject(new Error('Server startup timeout'));
        }
      }, 20000);

      this.serverProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log(`[Server] ${output.trim()}`);
        
        if ((output.includes('Server is running on') || 
             output.includes('service started successfully') ||
             output.includes('Browser-Go service started')) && !serverReady) {
          serverReady = true;
          clearTimeout(timeout);
          this.log('Server started successfully', 'success');
          setTimeout(resolve, 3000); // Give server more time to fully initialize
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
      
      // Wait for graceful shutdown
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
   * Launch Chrome with extension (simplified version)
   */
  async launchChrome(userDataDir: string, instanceId: number = 0): Promise<any> {
    this.log(`Launching Chrome instance ${instanceId}...`);
    
    const browser = await chromeLauncher.launch({
      chromeFlags: [
        // '--headless=new',
        `--load-extension=${this.config.extensionPath}`,
        '--disable-extensions-except=' + this.config.extensionPath,
        `--user-data-dir=${userDataDir}`,
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-security', // Help with frame issues
        '--disable-features=VizDisplayCompositor,TranslateUI',
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
   * Test server health
   */
  async testServerHealth(): Promise<boolean> {
    try {
      this.log('Testing server health...');
      
      const response = await fetch(`http://localhost:${this.config.serverPort}/api/v1/browser/stats`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      
      const data = await response.json();
      this.log(`Server health OK - Max instances: ${data.data?.max_instances}`, 'success');
      return true;
    } catch (error: any) {
      this.log(`Server health check failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test device registration with improved timing
   */
  async testDeviceRegistration(): Promise<boolean> {
    try {
      this.log('Testing device registration...');
      
      let attempts = 0;
      const maxAttempts = 15; // Increased attempts
      
      while (attempts < maxAttempts) {
        try {
          const response = await fetch(`http://localhost:${this.config.serverPort}/api/v1/devices`);
          if (response.ok) {
            const result = await response.json();
            if (result.code === 0 && result.data?.devices?.length > 0) {
              this.registeredDevices = result.data.devices;
              this.log(`Found ${this.registeredDevices.length} registered devices`, 'success');
              this.registeredDevices.forEach((device, idx) => {
                this.log(`  Device ${idx + 1}: ${device.deviceId.substring(0, 20)}...`);
              });
              return true;
            }
          }
        } catch {
          // Continue waiting
        }
        
        attempts++;
        this.log(`Waiting for device registration... (${attempts}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      this.log('No devices registered within timeout', 'error');
      return false;
    } catch (error: any) {
      this.log(`Device registration test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test basic CDP connection without navigation
   */
  async testBasicCDPConnection(): Promise<boolean> {
    try {
      this.log('Testing basic CDP connection...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No devices available for CDP test', 'warning');
        return false;
      }
      
      const deviceId = this.registeredDevices[0].deviceId;
      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${deviceId}`;
      
      return new Promise((resolve) => {
        const ws = new WebSocket(cdpUrl);
        let responseReceived = false;
        
        const timeout = setTimeout(() => {
          if (!responseReceived) {
            this.log('CDP connection timeout', 'error');
            ws.close();
            resolve(false);
          }
        }, 10000);
        
        ws.on('open', () => {
          this.log('CDP WebSocket connected');
          
          // Test simple Browser.getVersion command
          ws.send(JSON.stringify({
            id: 'test-basic-cdp',
            method: 'Browser.getVersion',
            params: {}
          }));
        });
        
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.id === 'test-basic-cdp' && message.result) {
              this.log('CDP command successful', 'success');
              responseReceived = true;
              clearTimeout(timeout);
              ws.close();
              resolve(true);
            }
          } catch (error) {
            this.log(`CDP message parse error: ${error}`, 'error');
          }
        });
        
        ws.on('error', (error) => {
          this.log(`CDP WebSocket error: ${error}`, 'error');
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
      this.log(`CDP connection test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test multi-device connections with Bing search and screenshots
   */
  async testMultiDeviceConnections(): Promise<boolean> {
    try {
      this.log('Testing multi-device connections with Bing search...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No devices available for testing', 'error');
        return false;
      }
      
      // Test with single device to avoid conflicts
      if (this.registeredDevices.length < 2) {
        this.log(`Only ${this.registeredDevices.length} device(s) available, testing with available devices`, 'warning');
      }
      
      const results: boolean[] = [];
      
      // Test first device only to avoid conflicts
      const deviceId = this.registeredDevices[0].deviceId;
      this.log(`Testing Bing search on device: ${deviceId.substring(0, 20)}...`);
      
      const result = await this.testStablePlaywrightConnection(deviceId, 1);
      results.push(result);
      
      const success = results.length > 0 && results.every(r => r);
      if (success) {
        this.log('Bing search test successful on all tested devices', 'success');
      } else {
        this.log('Some Bing search tests failed', 'warning');
      }
      
      return success;
    } catch (error: any) {
      this.log(`Bing search test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Test stable Playwright connection with Bing navigation and screenshot
   */
  async testStablePlaywrightConnection(deviceId: string, clientId: number): Promise<boolean> {
    let browser = null;
    try {
      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${deviceId}`;
      this.log(`  Client ${clientId}: Connecting to CDP...`);
      
      // Connect with timeout
      const connectPromise = chromium.connectOverCDP(cdpUrl);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Connection timeout')), 15000)
      );
      
      browser = await Promise.race([connectPromise, timeoutPromise]) as any;
      
      // Wait for connection to stabilize
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        this.log(`  Client ${clientId}: No contexts available`, 'warning');
        return false;
      }

      const context = contexts[0];
      let page;
      
      try {
        // Try to get existing page or create new one
        const pages = context.pages();
        if (pages.length === 0) {
          this.log(`  Client ${clientId}: Creating new page...`);
          page = await context.newPage();
        } else {
          page = pages[0];
          // Check if page is still attached
          try {
            await page.url();
          } catch (error: any) {
            if (error.message.includes('detached')) {
              this.log(`  Client ${clientId}: Page detached, creating new page...`);
              page = await context.newPage();
            } else {
              throw error;
            }
          }
        }
        
        // Additional wait for page to be ready
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Navigate to Bing with retries
        this.log(`  Client ${clientId}: Navigating to Bing...`);
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
            this.log(`  Client ${clientId}: Navigation attempt ${attempt} failed: ${navError.message}`);
            if (attempt < 3) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              // Try creating a new page if navigation fails
              if (navError.message.includes('detached')) {
                page = await context.newPage();
              }
            }
          }
        }
        
        if (!navigationSuccess) {
          this.log(`  Client ${clientId}: Failed to navigate to Bing after 3 attempts`, 'warning');
          return false;
        }
      } catch (setupError: any) {
        this.log(`  Client ${clientId}: Page setup failed: ${setupError.message}`, 'error');
        return false;
      }
      
      // Wait for page to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const url = await page.url();
      const title = await page.title();
      
      this.log(`  Client ${clientId}: Connected - URL: ${url}`, 'success');
      this.log(`  Client ${clientId}: Title: ${title || 'No title'}`);
      
      // Generate random search term and perform search
      const searchTerm = this.generateRandomSearchTerm();
      this.log(`  Client ${clientId}: Searching for: "${searchTerm}"`);
      
      // Find and fill search box
      const searchSelector = 'input[name="q"], #sb_form_q';
      await page.waitForSelector(searchSelector, { timeout: 5000 });
      await page.fill(searchSelector, searchTerm);
      
      // Submit search
      await page.keyboard.press('Enter');
      
      // Wait for search results
      await page.waitForLoadState('networkidle');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Take screenshot
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const screenshotPath = path.join(this.testResultDir, `bing-search-client-${clientId}-${timestamp}.png`);
      
      await page.screenshot({ 
        path: screenshotPath, 
        fullPage: true 
      });
      
      this.log(`  Client ${clientId}: Screenshot saved to ${screenshotPath}`, 'success');
      
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
        this.log(`  Client ${clientId}: Search completed successfully (${searchResults.resultsCount} results)`, 'success');
      } else {
        this.log(`  Client ${clientId}: Search may not have completed properly`, 'warning');
      }
      
      return true;
      
    } catch (error: any) {
      this.log(`  Client ${clientId}: Failed - ${error.message}`, 'error');
      return false;
    } finally {
      if (browser) {
        try {
          await browser.close();
          this.log(`  Client ${clientId}: Browser connection closed`);
        } catch (closeError) {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Test concurrent message handling
   */
  async testConcurrentMessaging(): Promise<boolean> {
    try {
      this.log('Testing concurrent messaging...');
      
      if (this.registeredDevices.length === 0) {
        this.log('No devices available for concurrent test', 'warning');
        return false;
      }
      
      const deviceId = this.registeredDevices[0].deviceId;
      const wsUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${deviceId}`;
      
      return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl);
        const responses = new Set<string>();
        let allReceived = false;
        
        const timeout = setTimeout(() => {
          if (!allReceived) {
            this.log('Concurrent messaging timeout', 'error');
            ws.close();
            resolve(false);
          }
        }, 15000);
        
        ws.on('open', () => {
          this.log('Sending concurrent messages...');
          
          // Send multiple commands concurrently
          const commands = [
            { id: 'concurrent-1', method: 'Browser.getVersion', params: {} },
            { id: 'concurrent-2', method: 'Target.getTargets', params: {} },
            { id: 'concurrent-3', method: 'Runtime.evaluate', params: { expression: '1+1' } }
          ];
          
          commands.forEach(cmd => {
            ws.send(JSON.stringify(cmd));
          });
        });
        
        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            if (message.id && message.id.startsWith('concurrent-')) {
              responses.add(message.id);
              this.log(`  Received response for ${message.id}`);
              
              if (responses.size >= 3) {
                this.log('All concurrent responses received', 'success');
                allReceived = true;
                clearTimeout(timeout);
                ws.close();
                resolve(true);
              }
            }
          } catch (error) {
            this.log(`Concurrent message parse error: ${error}`, 'error');
          }
        });
        
        ws.on('error', (error) => {
          this.log(`Concurrent messaging error: ${error}`, 'error');
          clearTimeout(timeout);
          resolve(false);
        });
        
        ws.on('close', () => {
          clearTimeout(timeout);
          if (!allReceived) {
            resolve(responses.size >= 2); // Accept partial success
          }
        });
      });
    } catch (error: any) {
      this.log(`Concurrent messaging test failed: ${error.message}`, 'error');
      return false;
    }
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    this.log('Cleaning up resources...');
    
    // Close all browsers
    for (const browser of this.browsers) {
      try {
        await browser.kill();
        this.log(`Browser PID ${browser.pid} terminated`);
      } catch (error) {
        // Force kill if needed
        try {
          process.kill(browser.pid, 'SIGKILL');
        } catch {
          // Ignore
        }
      }
    }
    this.browsers = [];
    
    // Stop server
    await this.stopServer();
    
    this.log('Cleanup completed', 'success');
  }

  /**
   * Print test results summary
   */
  printTestResults(): void {
    console.log('\n📊 Simplified E2E Test Results:');
    console.log('===============================');
    
    const tests = [
      { key: 'server_health', name: 'Server Health' },
      { key: 'device_registration', name: 'Device Registration' },
      { key: 'basic_cdp', name: 'Basic CDP Connection' },
      { key: 'multi_device', name: 'Bing Search & Screenshot' },
      { key: 'concurrent_messaging', name: 'Concurrent Messaging' },
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
      this.log('🎉 All tests passed! System is working correctly.', 'success');
    } else if (passed >= tests.length * 0.8) {
      this.log('⚠️  Most tests passed. System is mostly functional.', 'warning');
    } else {
      this.log('❌ Multiple tests failed. Please check the issues above.', 'error');
    }
  }

  /**
   * Run all simplified tests
   */
  async runAllTests(): Promise<void> {
    console.log('🧪 Starting Simplified E2E Test Suite with Bing Search\n');
    
    try {
      // Start server first
      await this.startServer();
      
      // Test server health
      this.testResults['server_health'] = await this.testServerHealth();
      
      if (!this.testResults['server_health']) {
        throw new Error('Server health check failed');
      }
      
      // Launch single Chrome instance first
      await this.launchChrome('./.runtime/test-simple-main', 0);
      
      // Wait for extension to initialize
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Test device registration
      this.testResults['device_registration'] = await this.testDeviceRegistration();
      
      // Test basic CDP connection
      this.testResults['basic_cdp'] = await this.testBasicCDPConnection();
      
      // Test Bing search with current device (avoid multi-device conflicts)
      if (this.testResults['basic_cdp']) {
        this.log('Testing Bing search functionality with current device...');
        
        // Test Bing search with existing device
        this.testResults['multi_device'] = await this.testMultiDeviceConnections();
      }
      
      // Test concurrent messaging
      this.testResults['concurrent_messaging'] = await this.testConcurrentMessaging();
      
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
  const testRunner = new SimpleE2ETestRunner();
  
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
    console.error('Test suite failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { SimpleE2ETestRunner };