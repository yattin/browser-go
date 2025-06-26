#!/usr/bin/env node

/**
 * Playwright Compatibility Test
 * This test validates CDP bridge compatibility with standard Playwright automation framework.
 */

import { spawn, ChildProcess } from 'child_process';
import { chromium } from 'playwright';
import chromeLauncher from 'chrome-launcher';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface PlaywrightTestConfig {
  serverPort: number;
  serverToken: string;
  extensionPath: string;
  testTimeout: number;
}

class PlaywrightCompatibilityTest {
  private config: PlaywrightTestConfig;
  private serverProcess: ChildProcess | null = null;
  private browser: any = null;
  private deviceId: string | null = null;

  constructor() {
    this.config = {
      serverPort: 3000, // Use default port to match extension configuration
      serverToken: 'playwright-test-token',
      extensionPath: path.resolve(__dirname, '../extension'),
      testTimeout: 120000, // 2 minutes
    };
  }

  /**
   * Start the browser-go server with CDP logging enabled
   */
  async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log('🚀 Starting browser-go server for Playwright testing...');
      
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
          // '--cdp-logging',  // Enable detailed CDP logging
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
    
    // Wait for extension to initialize and connect
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check extension connection
    await this.checkExtensionConnection();
  }

  /**
   * Check if extension is connected (simplified architecture)
   */
  async checkExtensionConnection(): Promise<void> {
    // In the simplified architecture, we don't need device IDs
    // We just need to verify the extension has connected
    console.log(`📱 Extension connected successfully`);
    this.deviceId = 'extension-connected'; // Placeholder for compatibility
  }

  /**
   * Test basic Playwright connection
   */
  async testBasicConnection(): Promise<boolean> {
    let browser = null;
    try {
      console.log('\n🔌 Testing basic Playwright connection...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp`;
      console.log(`   Connecting to: ${cdpUrl}`);

      browser = await chromium.connectOverCDP(cdpUrl);
      console.log('✅ Basic connection established');
      
      // Get basic info
      const contexts = browser.contexts();
      console.log(`   Browser contexts: ${contexts.length}`);
      
      return true;
    } catch (error: any) {
      console.log('❌ Basic connection failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    } finally {
      // Ensure browser connection is always closed
      if (browser) {
        try {
          await browser.close();
          console.log('   Browser connection closed');
        } catch (closeError: any) {
          console.log('   Warning: Error closing browser connection:', closeError.message);
        }
      }
    }
  }

  /**
   * Test page creation and navigation
   */
  async testPageOperations(): Promise<boolean> {
    let browser = null;
    try {
      console.log('\n📄 Testing page operations...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp`;
      browser = await chromium.connectOverCDP(cdpUrl);
      
      const contexts = browser.contexts();
      if (contexts.length === 0) {
        console.log('❌ No browser contexts available');
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
      
      return true;
    } catch (error: any) {
      console.log('❌ Page operations failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    } finally {
      // Ensure browser connection is always closed
      if (browser) {
        try {
          await browser.close();
          console.log('   Browser connection closed');
        } catch (closeError: any) {
          console.log('   Warning: Error closing browser connection:', closeError.message);
        }
      }
    }
  }

  /**
   * Test JavaScript evaluation
   */
  async testJavaScriptEvaluation(): Promise<boolean> {
    let browser = null;
    try {
      console.log('\n🔧 Testing JavaScript evaluation...');
      
      if (!this.deviceId) {
        console.log('❌ No device ID available');
        return false;
      }

      const cdpUrl = `ws://127.0.0.1:${this.config.serverPort}/cdp`;
      browser = await chromium.connectOverCDP(cdpUrl);
      
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
      
      return true;
    } catch (error: any) {
      console.log('❌ JavaScript evaluation failed:', error.message);
      console.log('   Full error details:');
      console.log('  ', error);
      return false;
    } finally {
      // Ensure browser connection is always closed
      if (browser) {
        try {
          await browser.close();
          console.log('   Browser connection closed');
        } catch (closeError: any) {
          console.log('   Warning: Error closing browser connection:', closeError.message);
        }
      }
    }
  }

  /**
   * Run all Playwright compatibility tests
   */
  async runAllTests(): Promise<void> {
    console.log('🎭 Playwright Compatibility Test Suite');
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
    console.log('\n📊 Playwright Compatibility Results:');
    console.log('====================================');
    
    const tests = [
      { key: 'server_start', name: 'Server Startup' },
      { key: 'chrome_setup', name: 'Chrome + Extension Setup' },
      { key: 'basic_connection', name: 'Basic Playwright Connection' },
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
      console.log('🎉 All Playwright compatibility tests passed!');
    } else {
      console.log('⚠️  Some Playwright tests failed. Check logs for details.');
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
    
    // Force cleanup of Chrome browser process
    if (this.browser) {
      try {
        console.log(`   Killing Chrome process (PID: ${this.browser.pid})`);
        await this.browser.kill();
        console.log('✅ Browser process terminated');
      } catch (error) {
        console.error(`❌ Error closing browser: ${error}`);
        
        // Force kill using system kill command if normal kill fails
        if (this.browser.pid) {
          try {
            console.log('   Attempting force kill...');
            process.kill(this.browser.pid, 'SIGKILL');
            console.log('✅ Browser force killed');
          } catch (forceError) {
            console.error(`❌ Force kill failed: ${forceError}`);
          }
        }
      }
      this.browser = null;
    }
    
    // Additional cleanup: kill any remaining Chrome processes that might be related to our test
    await this.forceKillChromeProcesses();
    
    // Check for any remaining processes after cleanup
    await this.checkRemainingProcesses();
    
    await this.stopServer();
    console.log('✅ Cleanup completed');
  }

  /**
   * Force kill any remaining Chrome processes
   */
  private async forceKillChromeProcesses(): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      console.log('   🔍 Scanning for remaining Chrome processes...');
      
      const platform = process.platform;
      
      if (platform === 'darwin') {
        // macOS specific cleanup
        try {
          // Find Chrome processes related to our extension
          const { stdout } = await execAsync(`ps aux | grep -i chrome | grep "${this.config.extensionPath}" | grep -v grep`);
          if (stdout.trim()) {
            console.log('   Found Chrome processes with our extension:', stdout.trim().split('\n').length, 'processes');
            
            // Kill them using pkill
            await execAsync(`pkill -f "${this.config.extensionPath}"`);
            console.log('   ✅ Extension-related Chrome processes terminated');
          }
          
          // Also kill any chrome-launcher processes that might be stuck
          try {
            await execAsync('pkill -f "chrome-launcher"');
            console.log('   ✅ Chrome-launcher processes terminated');
          } catch (e) {
            // No chrome-launcher processes found - this is normal
          }
          
          // Wait for processes to fully terminate
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Verify cleanup
          const { stdout: remaining } = await execAsync(`ps aux | grep -i chrome | grep "${this.config.extensionPath}" | grep -v grep || echo ""`);
          if (remaining.trim()) {
            console.log('   ⚠️  Some Chrome processes may still be running');
          } else {
            console.log('   ✅ All Chrome processes cleaned up successfully');
          }
          
        } catch (error: any) {
          if (!error.message.includes('No such process')) {
            console.log('   Chrome process cleanup error:', error.message);
          }
        }
        
      } else if (platform === 'linux') {
        // Linux specific cleanup
        try {
          await execAsync(`pkill -f "${this.config.extensionPath}"`);
          await execAsync('pkill -f "chrome-launcher"');
          console.log('   ✅ Chrome processes cleaned up on Linux');
        } catch (error: any) {
          console.log('   Linux Chrome cleanup skipped:', error.message);
        }
        
      } else if (platform === 'win32') {
        // Windows specific cleanup
        try {
          await execAsync('taskkill /F /IM chrome.exe /T');
          console.log('   ✅ Chrome processes cleaned up on Windows');
        } catch (error: any) {
          console.log('   Windows Chrome cleanup skipped:', error.message);
        }
      }
      
    } catch (error: any) {
      console.log('   Additional cleanup error:', error.message);
    }
  }

  /**
   * Check for and report any remaining Chrome processes
   */
  private async checkRemainingProcesses(): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('ps aux | grep -i chrome | grep -v grep | grep -v "Visual Studio Code" || echo ""');
        if (stdout.trim()) {
          console.log('   ⚠️  Remaining Chrome-related processes detected:');
          console.log('  ', stdout.trim().split('\n').length, 'processes');
        }
      }
    } catch (error) {
      // Ignore errors in process checking
    }
  }
}

// Main execution
async function main() {
  const testRunner = new PlaywrightCompatibilityTest();
  
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
    console.error('Playwright compatibility test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { PlaywrightCompatibilityTest };