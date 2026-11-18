#!/usr/bin/env node

/**
 * Test Browser Cleanup Mechanism
 * This test specifically validates the browser process cleanup functionality
 */

import chromeLauncher from 'chrome-launcher';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class BrowserCleanupTest {
  private browser: any = null;
  private extensionPath: string;

  constructor() {
    this.extensionPath = path.resolve(__dirname, '../extension');
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
          const { stdout } = await execAsync(`ps aux | grep -i chrome | grep "${this.extensionPath}" | grep -v grep`);
          if (stdout.trim()) {
            console.log('   Found Chrome processes with our extension:', stdout.trim().split('\n').length, 'processes');
            
            // Kill them using pkill
            await execAsync(`pkill -f "${this.extensionPath}"`);
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
          const { stdout: remaining } = await execAsync(`ps aux | grep -i chrome | grep "${this.extensionPath}" | grep -v grep || echo ""`);
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
          await execAsync(`pkill -f "${this.extensionPath}"`);
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
          // Show first few processes for debugging
          const processes = stdout.trim().split('\n').slice(0, 3);
          processes.forEach(proc => {
            const parts = proc.split(/\s+/);
            const pid = parts[1];
            const command = parts.slice(10).join(' ').substring(0, 100);
            console.log(`     PID ${pid}: ${command}...`);
          });
        } else {
          console.log('   ✅ No remaining Chrome processes found');
        }
      }
    } catch (error) {
      // Ignore errors in process checking
      console.log('   Process check error:', error);
    }
  }

  /**
   * Test browser launch and cleanup
   */
  async testBrowserLifecycle(): Promise<void> {
    console.log('🧪 Testing Browser Lifecycle Management');
    console.log('=======================================\n');

    try {
      // Check initial process count
      console.log('📊 Initial process count check...');
      await this.checkRemainingProcesses();

      // Launch Chrome with extension
      console.log('\n🚀 Launching Chrome with extension...');
      this.browser = await chromeLauncher.launch({
        chromeFlags: [
          `--load-extension=${this.extensionPath}`,
          '--disable-extensions-except=' + this.extensionPath,
          '--user-data-dir=./.runtime/test-cleanup', // 用户数据目录位于 .runtime 内
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

      console.log(`✅ Chrome launched successfully (PID: ${this.browser.pid})`);

      // Wait a bit
      console.log('⏳ Waiting 3 seconds...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check process count during execution
      console.log('\n📊 Process count during execution...');
      await this.checkRemainingProcesses();

      // Test normal cleanup
      console.log('\n🧹 Testing normal cleanup...');
      if (this.browser) {
        try {
          console.log(`   Killing Chrome process (PID: ${this.browser.pid})`);
          await this.browser.kill();
          console.log('✅ Browser process terminated normally');
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

      // Additional cleanup
      console.log('\n🔧 Testing additional cleanup mechanisms...');
      await this.forceKillChromeProcesses();

      // Final check
      console.log('\n📊 Final process count check...');
      await this.checkRemainingProcesses();

    } catch (error) {
      console.error('💥 Test failed:', error);
      throw error;
    }
  }

  /**
   * Run cleanup test
   */
  async runTest(): Promise<void> {
    try {
      await this.testBrowserLifecycle();
      console.log('\n🎉 Cleanup test completed successfully!');
    } catch (error) {
      console.error('\n💥 Cleanup test failed:', error);
      // Ensure cleanup runs even on failure
      try {
        if (this.browser) {
          await this.browser.kill();
        }
        await this.forceKillChromeProcesses();
      } catch (cleanupError) {
        console.error('Cleanup on failure also failed:', cleanupError);
      }
      throw error;
    }
  }
}

// Main execution
async function main() {
  const test = new BrowserCleanupTest();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Test interrupted by user');
    process.exit(0);
  });
  
  try {
    await test.runTest();
    process.exit(0);
  } catch (error) {
    console.error('Cleanup test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { BrowserCleanupTest };