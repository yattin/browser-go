#!/usr/bin/env node

/**
 * Dedicated Patchright Compatibility Test
 * This test isolates Patchright-specific issues to allow focused development
 * on CDP bridge compatibility with Patchright automation framework.
 */

import { spawn, ChildProcess } from 'child_process';
import { chromium } from 'patchright';
import chromeLauncher from 'chrome-launcher';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PatchrightTestConfig {
  serverPort: number;
  serverToken: string;
  extensionPath: string;
  testTimeout: number;
}

class PatchrightCompatibilityTest {
  private config: PatchrightTestConfig;
  private serverProcess: ChildProcess | null = null;
  private browser: any = null;
  private deviceId: string | null = null;

  constructor() {
    this.config = {
      serverPort: 3000, // Use default port to match extension configuration
      serverToken: 'patchright-test-token',
      extensionPath: path.resolve(__dirname, '../extension'),
      testTimeout: 120000, // 2 minutes
    };
  }

  /**
   * Start the browser-go server with CDP logging enabled
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('🚀 Starting browser-go server for Patchright testing...');
      
      // Build the project first
      const buildProcess = spawn('pnpm', ['run', 'build'], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'pipe'
      });

      buildProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Build failed with code ${code}`));
          return;
        }

        // Start the server with CDP logging for debugging
        this.serverProcess = spawn('node', [
          'dist/cli.js', 
          '--cdp-logging',  // Enable detailed CDP logging
          `--port=${this.config.serverPort}`, 
          `--token=${this.config.serverToken}`
        ], {
          cwd: path.resolve(__dirname, '..'),
          stdio: 'pipe'
        });

        let serverStarted = false;

        this.serverProcess.stdout?.on('data', (data) => {
          const output = data.toString();
          console.log(`[Server] ${output.trim()}`);
          
          if ((output.includes('Server is running on') || 
               output.includes('Browser-Go service started successfully')) && !serverStarted) {
            serverStarted = true;
            console.log('✅ Server started successfully');
            setTimeout(resolve, 2000);
          }
        });

        this.serverProcess.stderr?.on('data', (data) => {
          const errorOutput = data.toString().trim();
          console.error(`[Server Error] ${errorOutput}`);
          
          if (errorOutput.includes('EADDRINUSE') || errorOutput.includes('Error:')) {
            reject(new Error(`Server failed to start: ${errorOutput}`));
          }
        });

        // Timeout if server doesn't start
        setTimeout(() => {
          if (!serverStarted) {
            reject(new Error('Server failed to start within timeout'));
          }
        }, 30000);
      });
    });
  }

  /**
   * Stop the server
   */
  async stopServer(): Promise<void> {
    if (this.serverProcess) {
      console.log('🛑 Stopping server...');
      this.serverProcess.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  /**
   * Launch Chrome with extension and get device ID
   */
  async setupChromeWithExtension(): Promise<void> {
    console.log('🌐 Launching Chrome with extension...');
    
    this.browser = await chromeLauncher.launch({
      chromeFlags: [
        `--load-extension=${this.config.extensionPath}`,
        '--disable-extensions-except=' + this.config.extensionPath,
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
      ],
      handleSIGINT: false
    });
    
    console.log('✅ Chrome launched with extension loaded');
    
    // Wait for extension to initialize and register
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Get registered device ID
    await this.getDeviceId();
  }

  /**
   * Get the registered device ID from the server
   */
  async getDeviceId(): Promise<void> {
    try {
      const response = await fetch(`http://localhost:${this.config.serverPort}/api/v1/devices`);
      if (response.ok) {
        const result = await response.json();
        if (result.code === 0 && result.data?.devices?.length > 0) {
          this.deviceId = result.data.devices[0].deviceId;
          console.log(`📱 Device registered: ${this.deviceId}`);
        } else {
          throw new Error('No devices registered');
        }
      } else {
        throw new Error(`Failed to get devices: ${response.status}`);
      }
    } catch (error) {
      console.error('❌ Failed to get device ID:', error);
      throw error;
    }
  }

  /**
   * Test basic Patchright connection
   */
  async testBasicConnection(): Promise<boolean> {
    try {
      console.log('\n🔌 Testing basic Patchright connection...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${this.deviceId}`;
      console.log(`   Connecting to: ${cdpUrl}`);

      const browser = await chromium.connectOverCDP(cdpUrl);
      console.log('✅ Basic connection established');
      
      // Get basic info
      const contexts = browser.contexts();
      console.log(`   Browser contexts: ${contexts.length}`);
      
      await browser.close();
      return true;
    } catch (error: any) {
      console.log('❌ Basic connection failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    }
  }

  /**
   * Test page creation and navigation
   */
  async testPageOperations(): Promise<boolean> {
    try {
      console.log('\n📄 Testing page operations...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${this.deviceId}`;
      const browser = await chromium.connectOverCDP(cdpUrl);
      
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        console.log('❌ No browser contexts available');
        await browser.close();
        return false;
      }

      const context = contexts[0];
      const pages = context.pages();
      
      let page;
      if (pages.length === 0) {
        console.log('   Creating new page...');
        page = await context.newPage();
      } else {
        page = pages[0];
      }

      console.log('   Testing navigation...');
      await page.goto('https://example.com', { timeout: 15000 });
      
      const title = await page.title();
      const url = page.url();
      
      console.log(`✅ Navigation successful: ${title} (${url})`);
      
      await browser.close();
      return true;
    } catch (error: any) {
      console.log('❌ Page operations failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    }
  }

  /**
   * Test JavaScript evaluation
   */
  async testJavaScriptEvaluation(): Promise<boolean> {
    try {
      console.log('\n🔧 Testing JavaScript evaluation...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp?deviceId=${this.deviceId}`;
      const browser = await chromium.connectOverCDP(cdpUrl);
      
      const contexts = browser.contexts();
      const context = contexts[0];
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      await page.goto('https://example.com', { timeout: 15000 });
      
      const result = await page.evaluate(() => {
        return {
          userAgent: navigator.userAgent,
          title: document.title,
          url: window.location.href
        };
      });
      
      console.log('✅ JavaScript evaluation successful:');
      console.log(`   Title: ${result.title}`);
      console.log(`   URL: ${result.url}`);
      console.log(`   User Agent: ${result.userAgent.substring(0, 50)}...`);
      
      await browser.close();
      return true;
    } catch (error: any) {
      console.log('❌ JavaScript evaluation failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    }
  }

  /**
   * Run all Patchright compatibility tests
   */
  async runAllTests(): Promise<void> {
    console.log('🎭 Patchright Compatibility Test Suite');
    console.log('=====================================\n');
    
    const testResults: { [key: string]: boolean } = {};
    
    try {
      // Verify extension exists
      if (!fs.existsSync(this.config.extensionPath)) {
        throw new Error(`Extension not found: ${this.config.extensionPath}`);
      }
      
      // Start server
      await this.startServer();
      testResults['server_start'] = true;
      
      // Setup Chrome with extension
      await this.setupChromeWithExtension();
      testResults['chrome_setup'] = true;
      
      // Run compatibility tests
      testResults['basic_connection'] = await this.testBasicConnection();
      testResults['page_operations'] = await this.testPageOperations();
      testResults['javascript_evaluation'] = await this.testJavaScriptEvaluation();
      
      // Print results
      this.printResults(testResults);
      
    } catch (error) {
      console.error('\n💥 Test suite failed:', error);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Print test results
   */
  printResults(results: { [key: string]: boolean }): void {
    console.log('\n📊 Patchright Compatibility Results:');
    console.log('====================================');
    
    const tests = [
      { key: 'server_start', name: 'Server Startup' },
      { key: 'chrome_setup', name: 'Chrome + Extension Setup' },
      { key: 'basic_connection', name: 'Basic Patchright Connection' },
      { key: 'page_operations', name: 'Page Operations' },
      { key: 'javascript_evaluation', name: 'JavaScript Evaluation' },
    ];
    
    let passed = 0;
    const total = tests.length;
    
    tests.forEach(test => {
      const result = results[test.key];
      const status = result ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${test.name}`);
      if (result) passed++;
    });
    
    console.log(`\nOverall: ${passed}/${total} tests passed`);
    
    if (passed === total) {
      console.log('🎉 All Patchright compatibility tests passed!');
    } else {
      console.log('⚠️  Some Patchright tests failed. Check logs for details.');
      console.log('\n💡 Tips for debugging:');
      console.log('   - Check server logs for CDP protocol issues');
      console.log('   - Verify extension is properly loaded');
      console.log('   - Test with direct CDP connection for comparison');
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    console.log('\n🧹 Cleaning up...');
    
    if (this.browser) {
      try {
        await this.browser.kill();
        console.log('✅ Browser closed');
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
    
    await this.stopServer();
    console.log('✅ Cleanup completed');
  }
}

// Main execution
async function main() {
  const testRunner = new PatchrightCompatibilityTest();
  
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
    console.error('Patchright compatibility test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { PatchrightCompatibilityTest };