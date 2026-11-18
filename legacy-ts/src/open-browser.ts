#!/usr/bin/env node

/**
 * Open Browser Script for Manual Testing
 * 启动带有桥接扩展的 Chrome 浏览器用于人工测试
 * 
 * 功能:
 * - 加载项目扩展
 * - 使用独立用户目录 (.runtime/)
 * - 支持 Ctrl+C 优雅关闭
 */

import chromeLauncher from 'chrome-launcher';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface BrowserConfig {
  extensionPath: string;
  userDataDir: string;
  startingUrl?: string;
}

class BrowserLauncher {
  private config: BrowserConfig;
  private browser: any = null;

  constructor() {
    this.config = {
      extensionPath: path.resolve(__dirname, '../extension'),
      userDataDir: path.resolve(__dirname, '../.runtime'),
      startingUrl: 'chrome://extensions/'
    };
  }

  /**
   * 验证扩展文件
   */
  private verifyExtension(): void {
    const manifestPath = path.join(this.config.extensionPath, 'manifest.json');
    const backgroundPath = path.join(this.config.extensionPath, 'background.js');
    
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`扩展 manifest.json 未找到: ${manifestPath}`);
    }
    
    if (!fs.existsSync(backgroundPath)) {
      throw new Error(`扩展 background.js 未找到: ${backgroundPath}`);
    }
    
    console.log('✅ 扩展文件验证通过');
    console.log(`   扩展路径: ${this.config.extensionPath}`);
  }

  /**
   * 创建用户数据目录
   */
  private ensureUserDataDir(): void {
    if (!fs.existsSync(this.config.userDataDir)) {
      fs.mkdirSync(this.config.userDataDir, { recursive: true });
      console.log('✅ 创建用户数据目录:', this.config.userDataDir);
    } else {
      console.log('✅ 使用现有用户数据目录:', this.config.userDataDir);
    }
  }

  /**
   * 启动 Chrome 浏览器
   */
  async launchBrowser(): Promise<void> {
    console.log('🚀 正在启动 Chrome 浏览器...');
    
    this.browser = await chromeLauncher.launch({
      chromeFlags: [
        `--load-extension=${this.config.extensionPath}`,
        `--disable-extensions-except=${this.config.extensionPath}`,
        `--user-data-dir=${this.config.userDataDir}`,
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-translate',
        '--disable-ipc-flooding-protection',
        '--force-fieldtrials=SiteIsolationExtensions/Control'
      ],
      startingUrl: this.config.startingUrl,
      handleSIGINT: false,
      logLevel: 'silent'
    });
    
    console.log('✅ Chrome 浏览器启动成功');
    console.log(`   进程 PID: ${this.browser.pid}`);
    console.log(`   调试端口: ${this.browser.port}`);
    console.log(`   用户数据目录: ${this.config.userDataDir}`);
    console.log('');
    console.log('🔧 测试环境信息:');
    console.log('   - 扩展已自动加载并激活');
    console.log('   - 访问 chrome://extensions/ 查看扩展状态');
    console.log('   - 按 Ctrl+C 优雅关闭浏览器');
    console.log('');
  }

  /**
   * 关闭浏览器
   */
  async closeBrowser(): Promise<void> {
    if (this.browser) {
      console.log('🛑 正在关闭浏览器...');
      try {
        await this.browser.kill();
        console.log('✅ 浏览器已关闭');
      } catch (error) {
        console.error('❌ 关闭浏览器时出错:', error);
      }
      this.browser = null;
    }
  }

  /**
   * 启动测试环境
   */
  async start(): Promise<void> {
    try {
      console.log('🧪 Browser-Go 人工测试环境');
      console.log('===============================');
      
      // 验证扩展
      this.verifyExtension();
      
      // 确保用户数据目录存在
      this.ensureUserDataDir();
      
      // 启动浏览器
      await this.launchBrowser();
      
      // 保持进程运行
      console.log('💡 测试提示:');
      console.log('   1. 浏览器已加载桥接扩展');
      console.log('   2. 如需连接服务器，请先启动 browser-go 服务');
      console.log('   3. 可以手动访问任何网站进行测试');
      console.log('   4. 扩展将自动连接到 localhost:3000 (如果服务器运行)');
      console.log('');
      console.log('⌨️  按 Ctrl+C 退出测试环境');
      
      // 等待用户退出
      await this.waitForExit();
      
    } catch (error) {
      console.error('❌ 启动测试环境失败:', error);
      throw error;
    }
  }

  /**
   * 等待用户退出
   */
  private async waitForExit(): Promise<void> {
    return new Promise((resolve) => {
      // 监听进程信号
      process.on('SIGINT', async () => {
        console.log('\n👋 收到退出信号，正在清理...');
        await this.closeBrowser();
        resolve();
      });

      process.on('SIGTERM', async () => {
        console.log('\n👋 收到终止信号，正在清理...');
        await this.closeBrowser();
        resolve();
      });

      // 保持进程运行
      const keepAlive = () => {
        setTimeout(keepAlive, 1000);
      };
      keepAlive();
    });
  }
}

// 主执行函数
async function main(): Promise<void> {
  const launcher = new BrowserLauncher();
  
  try {
    await launcher.start();
    console.log('✅ 测试环境已退出');
    process.exit(0);
  } catch (error) {
    console.error('💥 测试环境启动失败:', error);
    await launcher.closeBrowser();
    process.exit(1);
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { BrowserLauncher };