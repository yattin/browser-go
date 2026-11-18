#!/usr/bin/env node

/**
 * Test script for CDP Bridge functionality using Playwright
 * Connects to the /cdp endpoint to control the browser through the extension bridge
 */

import { chromium } from 'patchright';
import * as dotenv from 'dotenv';
dotenv.config();

const cdpUrl: string = `ws://127.0.0.1:3000/cdp?deviceId=device-0d6dbdce-49bd-4161-b542-c9bc91ee9e10`;

// const cdpUrl: string = `ws://127.0.0.1:3000/cdp`;

console.log(`🔗 Connecting to CDP endpoint: ${cdpUrl}`);
console.log('📝 Make sure you have a browser extension connected to /extension endpoint');

async function runBridgeTest() {
  try {
    console.log('\n🚀 Starting Playwright CDP Bridge Test...');
    
    // Connect to our CDP bridge endpoint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browser: any = await chromium.connectOverCDP(cdpUrl);
    console.log('✅ 浏览器通过 CDP 桥接连接成功');

    // Get browser contexts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contexts: any[] = await browser.contexts();
    if (!contexts || contexts.length === 0) {
      console.error('❌ No browser contexts found.');
      await browser.close();
      return;
    }
    console.log(`📄 Found ${contexts.length} browser context(s)`);
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = contexts[0];

    // Get pages
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pages: any[] = context.pages();
    if (!pages || pages.length === 0) {
      console.log('📝 No existing pages found, creating a new page...');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newPage: any = await context.newPage();
      pages.push(newPage);
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = pages[0];
    console.log(`📑 Using page: ${await page.url() || 'about:blank'}`);

    // Test basic navigation
    console.log('\n🌐 Testing navigation...');
    await page.goto('https://www.example.com', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    const title = await page.title();
    const url = await page.url();
    console.log(`✅ Navigation successful!`);
    console.log(`   Title: ${title}`);
    console.log(`   URL: ${url}`);

    // Test JavaScript execution
    console.log('\n🔧 Testing JavaScript execution...');
    const result = await page.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString()
      };
    });
    
    console.log('✅ JavaScript execution successful!');
    console.log(`   User Agent: ${result.userAgent}`);
    console.log(`   Timestamp: ${result.timestamp}`);

    // Test element interaction
    console.log('\n🎯 Testing element interaction...');
    try {
      // Try to find and interact with an element
      const heading = await page.$('h1');
      if (heading) {
        const headingText = await heading.textContent();
        console.log(`✅ Found heading: "${headingText}"`);
      } else {
        console.log('ℹ️  No h1 element found on the page');
      }
    } catch (error: any) {
      console.log(`ℹ️  Element interaction test skipped: ${error.message}`);
    }

    // Test screenshot capability
    console.log('\n📸 Testing screenshot capability...');
    try {
      await page.screenshot({ 
        path: 'test-bridge-screenshot.png',
        fullPage: false 
      });
      console.log('✅ Screenshot saved as test-bridge-screenshot.png');
    } catch (error: any) {
      console.log(`ℹ️  Screenshot test skipped: ${error.message}`);
    }

    console.log('\n🎉 All bridge tests completed successfully!');
    
    // Keep the browser open for manual inspection
    console.log('\n⏸️  Browser will remain open for manual inspection...');
    console.log('   Press Ctrl+C to close the test');
    
    // Wait for user input with a proper cleanup mechanism
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        console.log('\n🔄 Closing browser connection...');
        browser.close().then(() => resolve()).catch(() => resolve());
      });
      process.once('SIGTERM', () => {
        console.log('\n🔄 Closing browser connection...');
        browser.close().then(() => resolve()).catch(() => resolve());
      });
    });
    
  } catch (error: any) {
    console.error('\n❌ Test execution failed:', error);
    if (error.message.includes('ECONNREFUSED')) {
      console.error('💡 Make sure the browser-go server is running on port 3000');
    } else if (error.message.includes('WebSocket')) {
      console.error('💡 Make sure the /cdp endpoint is available and extension is connected');
    }
    process.exit(1);
  }
}

// Handle graceful shutdown is now handled inside the test function
// to ensure proper cleanup

runBridgeTest().catch((error) => {
  console.error('Unhandled error in runBridgeTest:', error);
  process.exit(1);
});
