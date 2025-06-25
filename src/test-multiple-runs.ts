#!/usr/bin/env node

/**
 * Test Multiple Runs Stability
 * This test validates that multiple consecutive test runs do not accumulate
 * Chrome processes or other resources, ensuring our cleanup mechanism is stable
 */

import chromeLauncher from 'chrome-launcher';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface RunResult {
  runNumber: number;
  initialCount: number;
  afterLaunchCount: number;
  afterCleanupCount: number;
  cleanupSuccess: boolean;
  duration: number;
}

class MultipleRunsStabilityTest {
  private extensionPath: string;
  private results: RunResult[] = [];

  constructor() {
    this.extensionPath = path.resolve(__dirname, '../extension');
  }

  /**
   * Get Chrome process count
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
        } catch (error: any) {
          if (!error.message.includes('No such process')) {
            console.log('     Chrome cleanup warning:', error.message);
          }
        }
      }
    } catch (error: any) {
      console.log('     Additional cleanup error:', error);
    }
  }

  /**
   * Run a single test iteration
   */
  private async runSingleIteration(runNumber: number): Promise<RunResult> {
    const startTime = Date.now();
    console.log(`\n🧪 Run ${runNumber}:`);
    
    const initialCount = await this.getChromeProcessCount();
    console.log(`   Initial Chrome processes: ${initialCount}`);
    
    let browser: any = null;
    let afterLaunchCount = 0;
    let afterCleanupCount = 0;
    let cleanupSuccess = false;
    
    try {
      // Launch Chrome
      console.log('   🚀 Launching Chrome...');
      browser = await chromeLauncher.launch({
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
      
      afterLaunchCount = await this.getChromeProcessCount();
      console.log(`   After launch Chrome processes: ${afterLaunchCount}`);
      
      // Wait a bit to simulate some work
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Cleanup
      console.log('   🧹 Cleaning up...');
      if (browser) {
        try {
          await browser.kill();
          console.log('   ✅ Browser process terminated');
        } catch (error) {
          console.log(`   ❌ Error closing browser: ${error}`);
          
          if (browser.pid) {
            try {
              process.kill(browser.pid, 'SIGKILL');
              console.log('   ✅ Browser force killed');
            } catch (forceError) {
              console.log(`   ❌ Force kill failed: ${forceError}`);
            }
          }
        }
        browser = null;
      }
      
      // Additional cleanup
      await this.forceKillChromeProcesses();
      
      // Wait for processes to terminate
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      afterCleanupCount = await this.getChromeProcessCount();
      console.log(`   Final Chrome processes: ${afterCleanupCount}`);
      
      cleanupSuccess = afterCleanupCount <= initialCount;
      if (cleanupSuccess) {
        console.log('   ✅ Cleanup successful');
      } else {
        console.log('   ❌ Cleanup failed - process leak detected');
      }
      
    } catch (error) {
      console.log(`   💥 Run ${runNumber} failed:`, error);
      
      // Emergency cleanup
      if (browser) {
        try {
          await browser.kill();
        } catch (e) {
          // Ignore cleanup errors in error scenario
        }
      }
      await this.forceKillChromeProcesses();
      afterCleanupCount = await this.getChromeProcessCount();
    }
    
    const duration = Date.now() - startTime;
    console.log(`   ⏱️  Duration: ${duration}ms`);
    
    return {
      runNumber,
      initialCount,
      afterLaunchCount,
      afterCleanupCount,
      cleanupSuccess,
      duration
    };
  }

  /**
   * Run multiple test iterations
   */
  async runMultipleIterations(iterations: number = 5): Promise<void> {
    console.log('🧪 Multiple Runs Stability Test');
    console.log('==============================\n');
    console.log(`Running ${iterations} test iterations to check for resource leaks...\n`);
    
    for (let i = 1; i <= iterations; i++) {
      const result = await this.runSingleIteration(i);
      this.results.push(result);
      
      // Small delay between runs
      if (i < iterations) {
        console.log('   ⏳ Waiting before next run...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    this.analyzeResults();
  }

  /**
   * Analyze test results for stability patterns
   */
  private analyzeResults(): void {
    console.log('\n📊 Stability Analysis:');
    console.log('======================\n');
    
    // Summary table
    console.log('Run | Initial | Launch | Final | Success | Duration');
    console.log('----|---------|--------|-------|---------|----------');
    
    this.results.forEach(result => {
      const status = result.cleanupSuccess ? '✅' : '❌';
      console.log(
        `${result.runNumber.toString().padStart(3)} | ` +
        `${result.initialCount.toString().padStart(7)} | ` +
        `${result.afterLaunchCount.toString().padStart(6)} | ` +
        `${result.afterCleanupCount.toString().padStart(5)} | ` +
        `${status.padStart(7)} | ` +
        `${result.duration.toString().padStart(7)}ms`
      );
    });
    
    // Analysis
    const successfulRuns = this.results.filter(r => r.cleanupSuccess).length;
    const totalRuns = this.results.length;
    const successRate = (successfulRuns / totalRuns) * 100;
    
    console.log('\n🔍 Analysis Results:');
    console.log(`   Success Rate: ${successfulRuns}/${totalRuns} (${successRate.toFixed(1)}%)`);
    
    // Check for process accumulation
    const initialCounts = this.results.map(r => r.initialCount);
    const finalCounts = this.results.map(r => r.afterCleanupCount);
    
    const avgInitial = initialCounts.reduce((a, b) => a + b, 0) / initialCounts.length;
    const avgFinal = finalCounts.reduce((a, b) => a + b, 0) / finalCounts.length;
    
    console.log(`   Average Initial Processes: ${avgInitial.toFixed(1)}`);
    console.log(`   Average Final Processes: ${avgFinal.toFixed(1)}`);
    
    const processAccumulation = avgFinal - avgInitial;
    if (Math.abs(processAccumulation) < 0.5) {
      console.log('   ✅ No significant process accumulation detected');
    } else {
      console.log(`   ⚠️  Process accumulation detected: ${processAccumulation.toFixed(1)} processes/run`);
    }
    
    // Check performance consistency
    const durations = this.results.map(r => r.duration);
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    const minDuration = Math.min(...durations);
    
    console.log(`   Average Duration: ${avgDuration.toFixed(0)}ms`);
    console.log(`   Duration Range: ${minDuration}ms - ${maxDuration}ms`);
    
    const variability = ((maxDuration - minDuration) / avgDuration) * 100;
    if (variability < 50) {
      console.log('   ✅ Performance is consistent across runs');
    } else {
      console.log(`   ⚠️  High performance variability: ${variability.toFixed(1)}%`);
    }
    
    // Overall assessment
    console.log('\n🎯 Overall Assessment:');
    if (successRate === 100 && Math.abs(processAccumulation) < 0.5 && variability < 50) {
      console.log('   🎉 EXCELLENT: All tests passed with stable resource management');
    } else if (successRate >= 80 && Math.abs(processAccumulation) < 1) {
      console.log('   ✅ GOOD: Tests mostly stable with minor issues');
    } else {
      console.log('   ⚠️  NEEDS IMPROVEMENT: Stability issues detected');
    }
  }

  /**
   * Run the complete stability test
   */
  async runTest(iterations: number = 5): Promise<void> {
    try {
      await this.runMultipleIterations(iterations);
      console.log('\n🎉 Multiple runs stability test completed!');
    } catch (error) {
      console.error('\n💥 Multiple runs stability test failed:', error);
      throw error;
    }
  }
}

// Main execution
async function main() {
  const test = new MultipleRunsStabilityTest();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n👋 Test interrupted by user');
    process.exit(0);
  });
  
  try {
    // Get number of iterations from command line args (default: 5)
    const iterations = parseInt(process.argv[2]) || 5;
    console.log(`Starting stability test with ${iterations} iterations...\n`);
    
    await test.runTest(iterations);
    process.exit(0);
  } catch (error: any) {
    console.error('Multiple runs stability test failed:', error);
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { MultipleRunsStabilityTest };