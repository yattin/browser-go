// playwright-extra is a drop-in replacement for playwright,
// it augments the installed playwright with plugin functionality

import { chromium } from 'patchright'; // Assuming 'patchright' is similar to 'playwright'
import * as dotenv from 'dotenv';
dotenv.config();

// Define a more specific type for launch arguments if known, otherwise use a generic one
interface LaunchArgs {
  user: string;
  args: string[];
}

const launchArgsObject: LaunchArgs = {
  user: 'test',
  args: ['--window-size=1440,900'],
};
const launchArgs: string = JSON.stringify(launchArgsObject);

const startingUrl: string = 'https://www.baidu.com';

// 从环境变量读取 token
const token: string | undefined = process.env.TOKEN;

if (!token) {
  console.error(
    'TOKEN environment variable is not set. Please set it in your .env file or environment.',
  );
  process.exit(1);
}

const cdpUrl: string = `ws://127.0.0.1:3000/?startingUrl=${encodeURIComponent(startingUrl)}&token=${token}&launch=${encodeURIComponent(launchArgs)}`;

console.log(cdpUrl);

// Using 'any' for browser, context, page as patchright types might not be standard Playwright
// or readily available. If 'patchright' is a direct Playwright wrapper,
// you could potentially use Playwright's own types (e.g., Browser, BrowserContext, Page from 'playwright').
async function runTest() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const browser: any = await chromium.connectOverCDP(cdpUrl);
    console.log('浏览器初始化完成....');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contexts: any[] = await browser.contexts();
    if (!contexts || contexts.length === 0) {
      console.error('No browser contexts found.');
      await browser.close();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const context: any = contexts[0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pages: any[] = context.pages();
    if (!pages || pages.length === 0) {
      console.error('No pages found in context.');
      await browser.close();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = pages[0];

    await page.goto(
      'https://www.baidu.com/s?wd=%E9%A9%AC%E4%BA%91%E5%9B%9E%E5%BA%94%E5%9B%9E%E5%BD%92%E9%98%BF%E9%87%8C%E4%BC%A0%E9%97%BB',
      { waitUntil: 'networkidle' },
    );
    console.log('浏览器执行完成....');

    // Consider adding a browser.close() here in a finally block or after completion
    // await browser.close();
  } catch (error) {
    console.error('Test execution failed:', error);
  }
}

runTest().catch((error) => {
  console.error('Unhandled error in runTest:', error);
});
