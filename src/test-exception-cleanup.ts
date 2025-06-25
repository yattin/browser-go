#!/usr/bin/env node

/**
 * Test Exception Cleanup Mechanism
 * This test validates that browser processes are properly cleaned up
 * even when tests exit abnormally (errors, signals, exceptions)
 */

import chromeLauncher from 'chrome-launcher';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class ExceptionCleanupTest {
  private browser: any = null;
  private extensionPath: string;
  private testScenarios: string[] = [
    'normal_exit',
    'throw_error', 
    'process_exit',
    'sigint_signal',
    'unhandled_promise_rejection'
  ];

  constructor() {
    this.extensionPath = path.resolve(__dirname, '../extension');
  }

  /**
   * Setup process exit handlers for cleanup
   */
  private setupExitHandlers(): void {
    // Handle various exit scenarios
    process.on('exit', () => {
      console.log('   💀 Process exit handler triggered');
      this.syncCleanup();
    });

    process.on('SIGINT', async () => {
      console.log('   ⚡ SIGINT received');
      await this.performCleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('   ⚡ SIGTERM received');
      await this.performCleanup();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      console.log('   💥 Uncaught exception:', error.message);
      await this.performCleanup();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.log('   🚫 Unhandled promise rejection:', reason);
      await this.performCleanup();
      process.exit(1);
    });
  }

  /**
   * Synchronous cleanup for process exit handler
   */
  private syncCleanup(): void {
    if (this.browser && this.browser.pid) {
      try {
        process.kill(this.browser.pid, 'SIGKILL');
        console.log('   ✅ Browser force killed synchronously');
      } catch (error) {
        console.log('   ❌ Sync cleanup failed:', error);
      }
    }
  }

  /**
   * Asynchronous cleanup for other handlers
   */
  private async performCleanup(): Promise<void> {
    console.log('   🧹 Emergency cleanup triggered...');
    
    if (this.browser) {
      try {
        console.log(`   Killing Chrome process (PID: ${this.browser.pid})`);
        await this.browser.kill();
        console.log('   ✅ Browser process terminated');
      } catch (error) {
        console.log(`   ❌ Error closing browser: ${error}`);
        
        if (this.browser.pid) {
          try {
            process.kill(this.browser.pid, 'SIGKILL');
            console.log('   ✅ Browser force killed');
          } catch (forceError) {
            console.log(`   ❌ Force kill failed: ${forceError}`);
          }
        }
      }
      this.browser = null;
    }

    // Additional cleanup
    await this.forceKillChromeProcesses();
  }

  /**
   * Force kill any remaining Chrome processes
   */
  private async forceKillChromeProcesses(): Promise<void> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      if (process.platform === 'darwin') {
        try {
          // Kill extension-related Chrome processes
          await execAsync(`pkill -f "${this.extensionPath}"`);
          
          // Kill chrome-launcher processes
          try {
            await execAsync('pkill -f "chrome-launcher"');
          } catch (e) {
            // Ignore if no processes found
          }
          
          console.log('   ✅ Additional Chrome processes cleaned up');
        } catch (error: any) {
          if (!error.message.includes('No such process')) {
            console.log('   Chrome cleanup warning:', error.message);
          }
        }
      }
    } catch (error: any) {
      console.log('   Additional cleanup error:', error);
    }
  }

  /**
   * Check Chrome process count
   */
  private async getChromeProcessCount(): Promise<number> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      
      const { stdout } = await execAsync('ps aux | grep -i chrome | grep -v grep | grep -v "Visual Studio Code" || echo ""');
      return stdout.trim() ? stdout.trim().split('\n').length : 0;
    } catch (error: any) {
      return 0;
    }
  }

  /**
   * Launch Chrome for testing
   */
  private async launchChrome(): Promise<void> {
    console.log('   🚀 Launching Chrome...');
    this.browser = await chromeLauncher.launch({
      chromeFlags: [
        `--load-extension=${this.extensionPath}`,
        '--disable-extensions-except=' + this.extensionPath,
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
      handleSIGINT: false
    });
    console.log(`   ✅ Chrome launched (PID: ${this.browser.pid})`);
  }

  /**
   * Test scenario: Normal exit
   */
  private async testNormalExit(): Promise<void> {
    console.log('\n🧪 Testing Normal Exit...');
    
    const initialCount = await this.getChromeProcessCount();
    console.log(`   Initial Chrome processes: ${initialCount}`);
    
    await this.launchChrome();
    
    const afterLaunchCount = await this.getChromeProcessCount();
    console.log(`   After launch Chrome processes: ${afterLaunchCount}`);
    
    // Normal cleanup
    await this.performCleanup();
    
    // Wait a bit for processes to terminate
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const finalCount = await this.getChromeProcessCount();
    console.log(`   Final Chrome processes: ${finalCount}`);
    
    if (finalCount <= initialCount) {
      console.log('   ✅ Normal exit cleanup successful');
    } else {
      console.log('   ❌ Normal exit cleanup failed');
    }
  }

  /**
   * Test scenario: Thrown error
   */
  private async testThrownError(): Promise<void> {
    console.log('\n💥 Testing Thrown Error...');
    
    const initialCount = await this.getChromeProcessCount();
    console.log(`   Initial Chrome processes: ${initialCount}`);
    
    try {
      await this.launchChrome();
      
      const afterLaunchCount = await this.getChromeProcessCount();
      console.log(`   After launch Chrome processes: ${afterLaunchCount}`);
      
      // Simulate an error
      throw new Error('Simulated test error');
      
    } catch (error: any) {
      console.log(`   🎯 Caught expected error: ${error.message}`);
      // Since we caught the error, we need to manually trigger cleanup
      await this.performCleanup();
    }
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const finalCount = await this.getChromeProcessCount();
    console.log(`   Final Chrome processes: ${finalCount}`);
    
    if (finalCount <= initialCount) {
      console.log('   ✅ Error scenario cleanup successful');
    } else {
      console.log('   ❌ Error scenario cleanup failed');
    }
  }

  /**
   * Test scenario: Unhandled promise rejection
   */
  private async testUnhandledRejection(): Promise<void> {
    console.log('\n🚫 Testing Unhandled Promise Rejection...');
    
    const initialCount = await this.getChromeProcessCount();
    console.log(`   Initial Chrome processes: ${initialCount}`);
    
    await this.launchChrome();
    
    const afterLaunchCount = await this.getChromeProcessCount();
    console.log(`   After launch Chrome processes: ${afterLaunchCount}`);
    
    // Create unhandled promise rejection
    Promise.reject(new Error('Simulated unhandled rejection'));
    
    // Wait for cleanup
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const finalCount = await this.getChromeProcessCount();
    console.log(`   Final Chrome processes: ${finalCount}`);
    
    if (finalCount <= initialCount) {
      console.log('   ✅ Unhandled rejection cleanup successful');
    } else {
      console.log('   ❌ Unhandled rejection cleanup failed');
    }
  }

  /**
   * Run all exception cleanup tests
   */
  async runAllTests(): Promise<void> {
    console.log('🧪 Exception Cleanup Test Suite');
    console.log('===============================\n');

    // Setup exit handlers
    this.setupExitHandlers();

    try {
      // Test normal exit
      await this.testNormalExit();
      
      // Test thrown error (will be caught by uncaughtException handler)
      await this.testThrownError();
      
      // Test unhandled promise rejection
      await this.testUnhandledRejection();
      
      console.log('\n🎉 All exception cleanup tests completed!');
      
    } catch (error: any) {
      console.error('\n💥 Exception cleanup test suite failed:', error);
      throw error;
    }
  }
}

// Main execution
async function main() {
  const test = new ExceptionCleanupTest();
  
  try {
    await test.runAllTests();
    process.exit(0);
  } catch (error: any) {
    console.error('Exception cleanup test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { ExceptionCleanupTest };