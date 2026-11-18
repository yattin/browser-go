/**
 * WebSocket connection handlers
 * Handles different types of WebSocket connections and upgrades
 */

import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import httpProxy from 'http-proxy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import chromeLauncher from 'chrome-launcher';

import { logger } from './logger.js';
import { CDPRelayBridge } from './cdp-bridge.js';
import { ChromeManager } from './chrome-manager.js';
import { DeviceManager } from './device-manager.js';
import { LaunchParameters } from './types.js';

export class WebSocketHandlers {
  private cdpRelayBridge: CDPRelayBridge;
  private chromeManager: ChromeManager;
  private deviceManager: DeviceManager;
  private token: string;

  constructor(cdpRelayBridge: CDPRelayBridge, chromeManager: ChromeManager, deviceManager: DeviceManager, token: string) {
    this.cdpRelayBridge = cdpRelayBridge;
    this.chromeManager = chromeManager;
    this.deviceManager = deviceManager;
    this.token = token;
  }

  /**
   * Parse parameters from path URL format
   */
  parsePathParameters(pathname: string): { [key: string]: string } {
    const parts = pathname.split('/').filter(Boolean);
    const params: { [key: string]: string } = {};

    for (let i = 0; i < parts.length - 1; i += 2) {
      if (parts[i] && parts[i + 1]) {
        params[parts[i]] = decodeURIComponent(parts[i + 1]);
      }
    }

    return params;
  }

  /**
   * Handle CDP client connections (e.g., Playwright MCP)
   */
  async handleCDPConnection(
    req: IncomingMessage, 
    socket: Duplex, 
    head: Buffer,
    deviceId?: string | null
  ): Promise<void> {
    try {
      if (deviceId) {
        logger.info(`CDP connection attempt for device: ${deviceId}`);
      } else {
        logger.info('CDP connection attempt (no device routing)');
      }

      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.cdpRelayBridge.handleCDPConnection(ws, deviceId || undefined);
      });

    } catch (error) {
      logger.error('Failed to handle CDP connection:', error);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
      }
    }
  }

  /**
   * Handle extension WebSocket connections
   */
  async handleExtensionConnection(
    req: IncomingMessage, 
    socket: Duplex, 
    head: Buffer
  ): Promise<void> {
    try {
      logger.info('Extension connection attempt');

      const wss = new WebSocketServer({ noServer: true });
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.cdpRelayBridge.handleExtensionConnection(ws);
      });

    } catch (error) {
      logger.error('Failed to handle extension connection:', error);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
      }
    }
  }

  /**
   * Handle legacy browser launch WebSocket connections
   */
  async handleBrowserLaunchConnection(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    searchParams: URLSearchParams,
    pathParams: { [key: string]: string }
  ): Promise<void> {
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
    if (reqToken !== this.token) {
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
      let chrome: chromeLauncher.LaunchedChrome | null = null;

      if (hasUser) {
        const userKey = launchArgs.user as string;
        chrome = this.chromeManager.getChromeInstance(userKey);
        
        if (chrome) {
          logger.info(`Reusing existing Chrome instance for user: ${userKey}`);
          this.chromeManager.updateInstanceActivity(userKey);
        } else {
          if (this.chromeManager.reachedMaxInstances()) {
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
          chrome = await this.chromeManager.launchChromeInstance(chromeOptions, userKey);
          this.chromeManager.setChromeInstance(userKey, chrome);
        }
      } else {
        if (this.chromeManager.reachedMaxInstances()) {
          logger.error('Maximum concurrent instances limit reached');
          socket.end(
            'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nMaximum concurrent instances limit reached, please try again later',
          );
          return;
        }
        chrome = await this.chromeManager.launchChromeInstance(chromeOptions);
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
  }

  /**
   * Main WebSocket upgrade handler
   */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (!req.url) {
      logger.error('Request URL is undefined');
      socket.end('HTTP/1.1 400 Bad Request\r\n');
      return;
    }
    
    const url = new URL(req.url, `http://${req.headers.host}`);
    const searchParams = url.searchParams;
    const pathParams = this.parsePathParameters(url.pathname);

    console.log(`WebSocket upgrade request: ${url.pathname}`);

    // Check if this is a CDP relay connection
    if (url.pathname === '/cdp') {
      const deviceId = searchParams.get('deviceId');
      await this.handleCDPConnection(req, socket, head, deviceId);
      return;
    }

    // Check if this is an extension connection
    if (url.pathname === '/extension') {
      await this.handleExtensionConnection(req, socket, head);
      return;
    }

    // Handle legacy browser launch connections
    await this.handleBrowserLaunchConnection(req, socket, head, searchParams, pathParams);
  }
}