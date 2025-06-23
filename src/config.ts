/**
 * Configuration management and command line argument parsing
 */

import { AppConfig } from './types.js';

// 显示帮助信息
export function showHelp(): void {
  console.log(`
Browser-Go Service Launcher

Usage: node cli.js [options]

Options:
  --max-instances=<number>      Maximum concurrent instances (default: 10)
  --instance-timeout=<minutes>  Instance timeout in minutes (default: 60 minutes)
  --inactive-check-interval=<minutes>  Inactive instance check interval in minutes (default: 5 minutes)
  --token=<string>             Access token (default: 'browser-go-token')
  --help                       Show help information

Examples:
  node cli.js --max-instances=5 --instance-timeout=30
  node cli.js --token=my-secret-token
`);
  process.exit(0);
}

// 解析命令行参数
export function parseArgs(): AppConfig {
  const args: string[] = process.argv.slice(2);
  const config: AppConfig = {
    maxInstances: 10,
    instanceTimeout: 60, // 默认60分钟
    inactiveCheckInterval: 5, // 默认5分钟
    token: 'browser-go-token',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      showHelp();
    }
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      switch (key) {
        case 'max-instances':
          config.maxInstances = parseInt(value, 10) || 10;
          break;
        case 'instance-timeout':
          config.instanceTimeout = parseInt(value, 10) || 60;
          break;
        case 'inactive-check-interval':
          config.inactiveCheckInterval = parseInt(value, 10) || 5;
          break;
        case 'token':
          config.token = value || 'browser-go-token';
          break;
      }
    }
  }
  return config;
}

// 获取应用配置
export function getAppConfig(): AppConfig {
  return parseArgs();
}