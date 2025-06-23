#!/usr/bin/env node

/**
 * Test Runner for Device Management System
 * Orchestrates all test suites and provides unified test reporting
 */

import { DeviceManagerTests } from './test-device-manager.js';
import { ExtensionDeviceIdTests } from './test-extension-device-id.js';
import { DeviceRegistrationTests } from './test-device-registration.js';
import { CDPRoutingTests } from './test-cdp-routing.js';
import { DeviceIntegrationTests } from './test-device-integration.js';
import { APIEndpointsTests } from './test-api-endpoints.js';

interface TestSuite {
  name: string;
  description: string;
  testClass: any;
  category: 'unit' | 'integration' | 'end-to-end';
}

interface TestResults {
  suiteName: string;
  passed: boolean;
  duration: number;
  error?: string;
}

class DeviceTestRunner {
  private testSuites: TestSuite[] = [
    {
      name: 'DeviceManager Unit Tests',
      description: 'Tests DeviceManager class functionality in isolation',
      testClass: DeviceManagerTests,
      category: 'unit'
    },
    {
      name: 'Extension Device ID Tests',
      description: 'Tests device ID generation and storage in Extension',
      testClass: ExtensionDeviceIdTests,
      category: 'unit'
    },
    {
      name: 'Device Registration Tests',
      description: 'Tests device registration flow between Extension and Server',
      testClass: DeviceRegistrationTests,
      category: 'integration'
    },
    {
      name: 'CDP Routing Tests',
      description: 'Tests CDP message routing to specific devices',
      testClass: CDPRoutingTests,
      category: 'integration'
    },
    {
      name: 'Device Integration Tests',
      description: 'End-to-end tests for complete device management system',
      testClass: DeviceIntegrationTests,
      category: 'end-to-end'
    },
    {
      name: 'API Endpoints Tests',
      description: 'Tests device management REST API endpoints',
      testClass: APIEndpointsTests,
      category: 'integration'
    }
  ];

  private results: TestResults[] = [];

  async runAllTests(options: {
    category?: 'unit' | 'integration' | 'end-to-end';
    verbose?: boolean;
    parallel?: boolean;
  } = {}): Promise<void> {
    console.log('🚀 Device Management Test Runner');
    console.log('=================================\n');

    const filteredSuites = this.filterTestSuites(options.category);
    
    if (filteredSuites.length === 0) {
      console.log('❌ No test suites match the specified criteria');
      return;
    }

    console.log(`Running ${filteredSuites.length} test suite(s):`);
    filteredSuites.forEach(suite => {
      console.log(`  📋 ${suite.name} (${suite.category})`);
      if (options.verbose) {
        console.log(`     ${suite.description}`);
      }
    });
    console.log('');

    if (options.parallel && filteredSuites.length > 1) {
      await this.runTestsInParallel(filteredSuites, options.verbose || false);
    } else {
      await this.runTestsSequentially(filteredSuites, options.verbose || false);
    }

    this.printSummary();
  }

  private filterTestSuites(category?: string): TestSuite[] {
    if (!category) {
      return this.testSuites;
    }
    return this.testSuites.filter(suite => suite.category === category);
  }

  private async runTestsSequentially(suites: TestSuite[], verbose: boolean): Promise<void> {
    for (const suite of suites) {
      await this.runSingleTestSuite(suite, verbose);
    }
  }

  private async runTestsInParallel(suites: TestSuite[], verbose: boolean): Promise<void> {
    console.log('🔄 Running tests in parallel...\n');
    
    const promises = suites.map(suite => this.runSingleTestSuite(suite, verbose));
    await Promise.all(promises);
  }

  private async runSingleTestSuite(suite: TestSuite, verbose: boolean): Promise<void> {
    const startTime = Date.now();
    
    try {
      console.log(`🧪 Running ${suite.name}...`);
      
      const testInstance = new suite.testClass();
      await testInstance.runAllTests();
      
      const duration = Date.now() - startTime;
      
      this.results.push({
        suiteName: suite.name,
        passed: true,
        duration
      });
      
      console.log(`✅ ${suite.name} completed in ${duration}ms\n`);
      
    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      this.results.push({
        suiteName: suite.name,
        passed: false,
        duration,
        error: error.message
      });
      
      console.log(`❌ ${suite.name} failed in ${duration}ms`);
      if (verbose) {
        console.log(`   Error: ${error.message}`);
      }
      console.log('');
    }
  }

  private printSummary(): void {
    console.log('📊 Test Summary');
    console.log('===============');
    
    const totalSuites = this.results.length;
    const passedSuites = this.results.filter(r => r.passed).length;
    const failedSuites = totalSuites - passedSuites;
    const totalDuration = this.results.reduce((sum, r) => sum + r.duration, 0);
    
    console.log(`Total Test Suites: ${totalSuites}`);
    console.log(`Passed: ${passedSuites}`);
    console.log(`Failed: ${failedSuites}`);
    console.log(`Success Rate: ${((passedSuites / totalSuites) * 100).toFixed(1)}%`);
    console.log(`Total Duration: ${(totalDuration / 1000).toFixed(2)}s`);
    
    if (failedSuites > 0) {
      console.log('\n❌ Failed Test Suites:');
      this.results.filter(r => !r.passed).forEach(result => {
        console.log(`  - ${result.suiteName}: ${result.error}`);
      });
    }
    
    console.log('\n📋 Detailed Results:');
    this.results.forEach(result => {
      const status = result.passed ? '✅' : '❌';
      const duration = (result.duration / 1000).toFixed(2);
      console.log(`  ${status} ${result.suiteName} (${duration}s)`);
    });
    
    if (passedSuites === totalSuites) {
      console.log('\n🎉 All tests passed!');
    } else {
      console.log(`\n⚠️  ${failedSuites} test suite(s) failed.`);
      process.exit(1);
    }
  }

  async runSpecificTest(testName: string): Promise<void> {
    const suite = this.testSuites.find(s => 
      s.name.toLowerCase().includes(testName.toLowerCase())
    );
    
    if (!suite) {
      console.log(`❌ Test suite not found: ${testName}`);
      console.log('Available test suites:');
      this.testSuites.forEach(s => console.log(`  - ${s.name}`));
      return;
    }
    
    console.log(`🧪 Running specific test: ${suite.name}\n`);
    await this.runSingleTestSuite(suite, true);
    this.printSummary();
  }

  listTests(): void {
    console.log('📋 Available Test Suites:');
    console.log('========================\n');
    
    const categories = ['unit', 'integration', 'end-to-end'] as const;
    
    categories.forEach(category => {
      const categoryTests = this.testSuites.filter(s => s.category === category);
      if (categoryTests.length > 0) {
        console.log(`${category.toUpperCase()} TESTS:`);
        categoryTests.forEach(test => {
          console.log(`  📋 ${test.name}`);
          console.log(`     ${test.description}`);
        });
        console.log('');
      }
    });
  }
}

// CLI interface
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runner = new DeviceTestRunner();
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Device Management Test Runner');
    console.log('Usage: node test-runner.js [options]');
    console.log('');
    console.log('Options:');
    console.log('  --unit           Run only unit tests');
    console.log('  --integration    Run only integration tests');
    console.log('  --end-to-end     Run only end-to-end tests');
    console.log('  --parallel       Run tests in parallel');
    console.log('  --verbose        Show detailed output');
    console.log('  --list           List all available tests');
    console.log('  --test <name>    Run specific test suite');
    console.log('  --help, -h       Show this help message');
    return;
  }
  
  if (args.includes('--list')) {
    runner.listTests();
    return;
  }
  
  const testIndex = args.indexOf('--test');
  if (testIndex !== -1 && args[testIndex + 1]) {
    const testName = args[testIndex + 1];
    await runner.runSpecificTest(testName);
    return;
  }
  
  const options: {
    category?: 'unit' | 'integration' | 'end-to-end';
    verbose?: boolean;
    parallel?: boolean;
  } = {};
  
  if (args.includes('--unit')) {
    options.category = 'unit';
  } else if (args.includes('--integration')) {
    options.category = 'integration';
  } else if (args.includes('--end-to-end')) {
    options.category = 'end-to-end';
  }
  
  if (args.includes('--verbose')) {
    options.verbose = true;
  }
  
  if (args.includes('--parallel')) {
    options.parallel = true;
  }
  
  await runner.runAllTests(options);
}

// Run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { DeviceTestRunner };