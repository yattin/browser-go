#!/usr/bin/env node

import express, { Request, Response, Application } from 'express';
import chromeLauncher, { LaunchedChrome } from 'chrome-launcher';
import http, { IncomingMessage, Server } from 'http'; // Removed ServerResponse
import httpProxy from 'http-proxy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import swaggerUi from 'swagger-ui-express';
import { logger } from './logger.js';
import { Duplex } from 'stream';
import {
  AppConfig,
  LaunchParameters,
  BrowserInstance,
  SystemStats,
  StopBrowserResponse,
  ListBrowserResponse,
  StatsBrowserResponse,
  SystemStatsData,
} from './types.js';
import { getAsset, isSea } from 'node:sea'

// 显示帮助信息
function showHelp(): void {
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
function parseArgs(): AppConfig {
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

const config: AppConfig = parseArgs();
const app: Application = express();
const port: number = 3000;

// Load OpenAPI specification
// eslint-disable-next-line @typescript-eslint/no-explicit-any
// 加载 OpenAPI 规范，使用简单的 JSON 方式
let openApiSpec: any;
try {
  // 如果是 Sea 环境，尝试从资源中获取 openapi.yaml
  // 否则从本地文件系统读取
  const yamlContent = isSea() ? getAsset('openapi.yaml', 'utf8') : fs.readFileSync('./openapi.yaml', 'utf8');
  openApiSpec = parseSimpleYaml(yamlContent);
} catch (error) {
  // 如果加载失败，记录警告并提示只显示空白接口文档
  logger.warn('Failed to load OpenAPI specification from openapi.yaml, using default empty spec.')
  openApiSpec = {
    openapi: '3.0.0',
    info: { title: 'Browser-Go API', version: '1.0.0' },
    paths: {}
  };
}

// 简单的 YAML 解析函数
function parseSimpleYaml(content: string): any {
  // 这是一个非常简化的 YAML 解析器，仅用于基本的 OpenAPI 文件
  // 在生产环境中应该使用更完整的 YAML 解析库
  try {
    const lines = content.split('\n');
    const result: any = {};
    let currentPath: any = result;
    let indentStack: any[] = [result];
    let indentLevels: number[] = [0];

    for (const line of lines) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
      if (match) {
        const [, indent, key, value] = match;
        const indentLevel = indent.length;

        // 调整缩进栈
        while (indentLevels.length > 1 && indentLevel <= indentLevels[indentLevels.length - 1]) {
          indentLevels.pop();
          indentStack.pop();
        }

        currentPath = indentStack[indentStack.length - 1];

        if (value.trim() === '') {
          // 这是一个对象
          currentPath[key.trim()] = {};
          indentStack.push(currentPath[key.trim()]);
          indentLevels.push(indentLevel);
        } else {
          // 这是一个值
          let parsedValue: any = value.trim();
          if (parsedValue === 'true') parsedValue = true;
          else if (parsedValue === 'false') parsedValue = false;
          else if (/^\d+$/.test(parsedValue)) parsedValue = parseInt(parsedValue);
          else if (/^\d+\.\d+$/.test(parsedValue)) parsedValue = parseFloat(parsedValue);
          else if (parsedValue.startsWith('"') && parsedValue.endsWith('"')) {
            parsedValue = parsedValue.slice(1, -1);
          }

          currentPath[key.trim()] = parsedValue;
        }
      }
    }

    return result;
  } catch (error) {
    logger.error('Simple YAML parsing failed:', error);
    return {
      openapi: '3.0.0',
      info: { title: 'Browser-Go API', version: '1.0.0' },
      paths: {}
    };
  }
}

// Setup Swagger UI
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    explorer: true,
    swaggerOptions: {
      docExpansion: 'none',
      filter: true,
      showRequestHeaders: true,
    },
  }),
);

// Serve OpenAPI spec as JSON
app.get('/openapi.json', (req: Request, res: Response) => {
  res.json(openApiSpec);
});

// 配置项
const MAX_CONCURRENT_INSTANCES: number = config.maxInstances;
const INSTANCE_TIMEOUT_MS: number = config.instanceTimeout * 60 * 1000; // Convert minutes to milliseconds
const INACTIVE_CHECK_INTERVAL: number =
  config.inactiveCheckInterval * 60 * 1000; // Convert minutes to milliseconds
const TOKEN: string = config.token;

const chromeInstances: { [key: string]: LaunchedChrome } = {}; // Cache for Chrome instances
const instanceLastActivity: { [key: string]: number } = {}; // Record last activity time for each instance

// Add function to calculate current instance count
const getCurrentInstanceCount = (): number => {
  return Object.keys(chromeInstances).length;
};

// Add function to check if max instances reached
const reachedMaxInstances = (): boolean => {
  return getCurrentInstanceCount() >= MAX_CONCURRENT_INSTANCES;
};

// Add function to update instance activity time
const updateInstanceActivity = (userKey: string): void => {
  if (userKey && chromeInstances[userKey]) {
    instanceLastActivity[userKey] = Date.now();
  }
};

// Add function to clean up inactive instances
const cleanupInactiveInstances = async (): Promise<void> => {
  const now = Date.now();
  const inactiveUserKeys: string[] = [];

  for (const [userKey, lastActivity] of Object.entries(instanceLastActivity)) {
    if (now - lastActivity > INSTANCE_TIMEOUT_MS) {
      inactiveUserKeys.push(userKey);
    }
  }

  for (const userKey of inactiveUserKeys) {
    if (chromeInstances[userKey]) {
      try {
        logger.info(`Closing inactive Chrome instance (user: ${userKey})`);
        await chromeInstances[userKey].kill();
        delete chromeInstances[userKey];
        delete instanceLastActivity[userKey];
      } catch (error) {
        logger.error(
          `Failed to close inactive instance (user: ${userKey}):`,
          error,
        );
      }
    }
  }

  logger.info(
    `Current active Chrome instances: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`,
  );
};

// Periodically clean up inactive instances
setInterval(cleanupInactiveInstances, INACTIVE_CHECK_INTERVAL);

const launchChromeInstance = async (
  chromeOptions: chromeLauncher.Options,
  userKey: string | null = null,
): Promise<LaunchedChrome> => {
  const chrome: LaunchedChrome = await chromeLauncher.launch(chromeOptions);
  const chromeProcess = chrome.process;
  if (chromeProcess) {
    chromeProcess.on('exit', () => {
      if (userKey) {
        logger.info(
          `Received Chrome process exit signal (user: ${userKey}), cleaning up instance`,
        );
        delete chromeInstances[userKey];
        delete instanceLastActivity[userKey];
      } else {
        logger.info(
          'Received Chrome process exit signal (no user), cleaning up instance',
        );
      }
    });
  }

  if (userKey) {
    instanceLastActivity[userKey] = Date.now();
  }

  logger.info(
    `Launched new Chrome instance ${userKey ? `for user: ${userKey}` : '(no user)'}`,
  );
  logger.info(
    `Current active Chrome instances: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`,
  );

  return chrome;
};

// Create an HTTP server
const server: Server = http.createServer(app);

// Parse parameters from path URL format
function parsePathParameters(pathname: string): { [key: string]: string } {
  const parts = pathname.split('/').filter(Boolean);
  const params: { [key: string]: string } = {};

  for (let i = 0; i < parts.length - 1; i += 2) {
    if (parts[i] && parts[i + 1]) {
      params[parts[i]] = decodeURIComponent(parts[i + 1]);
    }
  }

  return params;
}

// Listen for WebSocket requests
server.on(
  'upgrade',
  async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url) {
      logger.error('Request URL is undefined');
      socket.end('HTTP/1.1 400 Bad Request\r\n');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const searchParams = url.searchParams;
    const pathParams = parsePathParameters(url.pathname);

    // 尝试从查询字符串或路径中获取参数
    const reqToken: string | null =
      searchParams.get('token') || pathParams['token'];
    const startingUrl: string | null =
      searchParams.get('startingUrl') || pathParams['startingUrl'];

    if (!reqToken) {
      logger.error('Missing token parameter');
      socket.end('HTTP/1.1 400 Bad Request\r\n');
      return;
    }
    if (reqToken !== TOKEN) {
      logger.error('Invalid token');
      socket.end('HTTP/1.1 403 Forbidden\r\n');
      return;
    }

    if (!startingUrl) {
      logger.error('Missing startingUrl parameter');
      socket.end('HTTP/1.1 400 Bad Request\r\n');
      return;
    }

    try {
      const launchParam: string | null = searchParams.get('launch');
      const launchArgs: LaunchParameters = launchParam
        ? JSON.parse(launchParam)
        : {};

      const launchFlags: string[] = launchArgs.args || [];
      const defaultFlags: string[] = [
        '--start-maximized',
        '--remote-allow-origins=*',
      ];
      const finalFlags: string[] = [...defaultFlags, ...launchFlags];

      const chromeOptions: chromeLauncher.Options = {
        startingUrl: startingUrl,
        chromeFlags: finalFlags,
        logLevel: 'info',
        handleSIGINT: true,
      };

      const hasUser: boolean = !!launchArgs.user;
      let chrome: LaunchedChrome | null = null;

      if (hasUser) {
        const userKey = launchArgs.user as string;
        if (chromeInstances[userKey]) {
          chrome = chromeInstances[userKey];
          logger.info(`Reusing existing Chrome instance for user: ${userKey}`);
          updateInstanceActivity(userKey);
        } else {
          if (reachedMaxInstances()) {
            logger.error('Maximum concurrent instances limit reached');
            socket.end(
              'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nMaximum concurrent instances limit reached, please try again later',
            );
            return;
          }

          const userDataDir = path.join(
            os.homedir(),
            '.browser-go',
            'browser_data',
            userKey,
          );
          if (!fs.existsSync(userDataDir)) {
            fs.mkdirSync(userDataDir, { recursive: true });
          }
          chromeOptions.userDataDir = userDataDir;
          chrome = await launchChromeInstance(chromeOptions, userKey);
          chromeInstances[userKey] = chrome;
        }
      } else {
        if (reachedMaxInstances()) {
          logger.error('Maximum concurrent instances limit reached');
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nMaximum concurrent instances limit reached, please try again later',
          );
          return;
        }
        chrome = await launchChromeInstance(chromeOptions);
      }

      if (!chrome) {
        logger.error('Failed to launch or reuse Chrome instance.');
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const debugPort = chrome.port;
      const res = await axios.get(`http://127.0.0.1:${debugPort}/json/version`);
      logger.info('Chrome launched:', res.data);
      const { webSocketDebuggerUrl } = res.data;

      if (!webSocketDebuggerUrl) {
        logger.error('webSocketDebuggerUrl is undefined.');
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
        return;
      }

      const cdpProxy = httpProxy.createProxyServer({
        ws: true,
      });

      cdpProxy.ws(
        req,
        socket,
        head,
        { changeOrigin: true, target: webSocketDebuggerUrl },
        (err: Error | undefined) => {
          if (err) {
            logger.error('WebSocket proxy error:', err);
            // Don't try to end the socket if it's already destroyed or headers sent
            if (!socket.destroyed) {
              try {
                socket.end('HTTP/1.1 500 Internal Server Error\r\n');
              } catch (e) {
                logger.error('Error ending socket in proxy error handler:', e);
              }
            }
          }
        },
      );

      cdpProxy.on(
        'close',
        (
          _closedReq: IncomingMessage,
          _closedSocket: Duplex,
          _closedHead: Buffer,
        ) => {
          logger.info('WebSocket connection closed');
        },
      );
    } catch (error) {
      logger.error('Failed to launch Chrome:', error);
      if (!socket.destroyed) {
        try {
          socket.end('HTTP/1.1 500 Internal Server Error\r\n');
        } catch (e) {
          logger.error('Error ending socket in main catch handler:', e);
        }
      }
    }
  },
);

// Define GET /api/v1/browser/stop endpoint
app.get(
  '/api/v1/browser/stop',
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.query.user_id as string;

    if (!userId) {
      const response: StopBrowserResponse = {
        code: -1,
        msg: 'Missing user_id parameter',
      };
      res.status(400).json(response);
      return;
    }

    if (chromeInstances[userId]) {
      try {
        await chromeInstances[userId].kill();
        delete chromeInstances[userId];
        delete instanceLastActivity[userId];
        const response: StopBrowserResponse = { code: 0, msg: 'success' };
        res.json(response);
        return;
      } catch (error) {
        logger.error('Failed to close browser instance:', error);
        const response: StopBrowserResponse = {
          code: -1,
          msg: 'Failed to close browser instance',
        };
        res.status(500).json(response);
        return;
      }
    } else {
      const response: StopBrowserResponse = {
        code: -1,
        msg: 'Browser instance not found for this user_id',
      };
      res.status(404).json(response);
      return;
    }
  },
);

// Define GET /api/v1/browser/list endpoint
app.get('/api/v1/browser/list', (req: Request, res: Response) => {
  const userIds = Object.keys(chromeInstances);
  const now = Date.now();

  const browserListData: BrowserInstance[] = userIds.map((userId) => {
    const lastActivityTime = instanceLastActivity[userId] || 0;
    const idleTimeMs = now - lastActivityTime;

    return {
      user_id: userId,
      last_activity: new Date(lastActivityTime).toISOString(),
      idle_time_seconds: Math.floor(idleTimeMs / 1000),
    };
  });

  const systemStats: SystemStats = {
    current_instances: getCurrentInstanceCount(),
    max_instances: MAX_CONCURRENT_INSTANCES,
    instance_timeout_ms: INSTANCE_TIMEOUT_MS,
  };

  const response: ListBrowserResponse = {
    code: 0,
    msg: 'success',
    data: browserListData,
    stats: systemStats,
  };
  res.json(response);
});

// Add GET /api/v1/browser/stats endpoint to view system status
app.get('/api/v1/browser/stats', (req: Request, res: Response) => {
  const statsData: SystemStatsData = {
    current_instances: getCurrentInstanceCount(),
    max_instances: MAX_CONCURRENT_INSTANCES,
    available_slots: MAX_CONCURRENT_INSTANCES - getCurrentInstanceCount(),
    instance_timeout_ms: INSTANCE_TIMEOUT_MS,
    inactive_check_interval: INACTIVE_CHECK_INTERVAL,
  };
  const response: StatsBrowserResponse = {
    code: 0,
    msg: 'success',
    data: statsData,
  };
  res.json(response);
});

// Listen on port
server.listen(port, '0.0.0.0', () => {
  logger.info(`Server is running on http://0.0.0.0:${port}`);
  logger.info(`API Documentation available at http://127.0.0.1:${port}/api-docs`);
  logger.info(`OpenAPI spec available at http://127.0.0.1:${port}/openapi.json`);
  logger.info(`Maximum concurrent instances: ${MAX_CONCURRENT_INSTANCES}`);
  logger.info(`Instance timeout: ${INSTANCE_TIMEOUT_MS / 60000} minutes`);
  logger.info(
    `Inactive check interval: ${INACTIVE_CHECK_INTERVAL / 60000} minutes`,
  );
});
