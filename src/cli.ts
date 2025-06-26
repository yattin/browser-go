#!/usr/bin/env node

/**
 * Browser-Go Service Main Entry Point
 * Integrates all modules and starts the HTTP/WebSocket server
 */

import express, { Application } from 'express';
import http, { Server } from 'http';
import swaggerUi from 'swagger-ui-express';

import { logger, closeLogger } from './logger.js';
import { getAppConfig } from './config.js';
import { loadOpenApiSpec } from './openapi.js';
import { DeviceManager } from './device-manager.js';
import { CDPRelayBridge } from './cdp-bridge.js';
import { ChromeManager } from './chrome-manager.js';
import { WebSocketHandlers } from './websocket-handlers.js';
import { ApiRoutes } from './api-routes.js';

// V2 Architecture Components
import { V2DeviceRegistry } from './v2-device-registry.js';
import { V2MessageRouter } from './v2-message-router.js';
import { V2WebSocketHandlers } from './v2-websocket-handlers.js';
import { V2Config } from './v2-types.js';

// Initialize configuration
const config = getAppConfig();
const app: Application = express();
const port: number = config.port || 3000;

// Load OpenAPI specification
const openApiSpec = loadOpenApiSpec();

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
app.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Initialize core components
const chromeManager = new ChromeManager(config);

// Initialize WebSocket architecture based on configuration
let webSocketHandlers: WebSocketHandlers | V2WebSocketHandlers;
let deviceManager: DeviceManager | V2DeviceRegistry;
let messageRouter: V2MessageRouter | undefined;
let cdpRelayBridge: CDPRelayBridge | undefined;

if (config.v2) {
  logger.info('Initializing V2 WebSocket architecture...');
  
  // V2 Configuration
  const v2Config: V2Config = {
    heartbeatInterval: 30000, // 30 seconds
    connectionTimeout: 60000, // 1 minute
    messageTimeout: 20000, // 20 seconds - increased for better stability
    maxQueueSize: 1000,
    maxRetries: 3,
    retryDelay: 1000,
    maxConcurrentConnections: config.maxInstances,
    maxConcurrentMessages: 50,
    metricsInterval: 5000,
    enableDetailedLogging: config.cdpLogging
  };
  
  deviceManager = new V2DeviceRegistry(v2Config);
  messageRouter = new V2MessageRouter(deviceManager, v2Config);
  webSocketHandlers = new V2WebSocketHandlers(deviceManager, messageRouter, v2Config);
  
  logger.info('V2 WebSocket architecture initialized');
} else {
  logger.info('Initializing V1 WebSocket architecture...');
  
  const v1DeviceManager = new DeviceManager();
  cdpRelayBridge = new CDPRelayBridge(v1DeviceManager, config);
  webSocketHandlers = new WebSocketHandlers(cdpRelayBridge, chromeManager, v1DeviceManager, config.token);
  deviceManager = v1DeviceManager;
  
  logger.info('V1 WebSocket architecture initialized');
}

const apiRoutes = new ApiRoutes(chromeManager, deviceManager as DeviceManager);

// Setup API routes
apiRoutes.setupRoutes(app);

// Create HTTP server
const server: Server = http.createServer(app);

// Setup WebSocket upgrade handling
server.on('upgrade', async (req, socket, head) => {
  if (config.v2) {
    // V2 architecture uses direct WebSocket server with routing
    // Handled by V2WebSocketHandlers during initialization
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ noServer: true });
    
    wss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const pathSegments = url.pathname.split('/').filter(Boolean);
        
        if (pathSegments.length >= 2 && pathSegments[0] === 'v2') {
          const endpoint = pathSegments[1];
          const v2Handlers = webSocketHandlers as V2WebSocketHandlers;
          
          switch (endpoint) {
            case 'device':
              await v2Handlers.handleDeviceEndpoint(ws, req);
              break;
            case 'cdp':
              await v2Handlers.handleCDPEndpoint(ws, req);
              break;
            case 'control':
              await v2Handlers.handleControlEndpoint(ws, req);
              break;
            default:
              ws.close(4000, `Unknown V2 endpoint: ${endpoint}`);
          }
        } else {
          ws.close(4000, 'Invalid V2 path - use /v2/{device|cdp|control}');
        }
      } catch (error) {
        logger.error('V2 WebSocket upgrade error:', error);
        ws.close(4001, 'V2 WebSocket upgrade failed');
      }
    });
  } else {
    // V1 architecture uses original upgrade handling
    const v1Handlers = webSocketHandlers as WebSocketHandlers;
    await v1Handlers.handleUpgrade(req, socket, head);
  }
});

// Graceful shutdown handling
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  
  // 设置强制退出的超时
  const forceExitTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timeout, forcing exit...');
    process.exit(1);
  }, 10000); // 10 秒超时
  
  try {
    // Close HTTP server
    logger.info('Closing HTTP server...');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          logger.info('HTTP server closed');
          resolve();
        }
      });
    });
    
    // Shutdown Chrome manager
    logger.info('Shutting down Chrome manager...');
    await chromeManager.shutdown();
    logger.info('Chrome manager shutdown completed');
    
    // Shutdown WebSocket components
    if (config.v2) {
      logger.info('Shutting down V2 WebSocket components...');
      
      if (messageRouter) {
        messageRouter.cleanup();
      }
      
      if (deviceManager && 'cleanup' in deviceManager) {
        await (deviceManager as V2DeviceRegistry).cleanup();
      }
      
      logger.info('V2 WebSocket components shutdown completed');
    } else {
      logger.info('Shutting down V1 WebSocket components...');
      
      // Shutdown Device manager (V1)
      if (deviceManager && 'shutdown' in deviceManager) {
        (deviceManager as DeviceManager).shutdown();
      }
      
      // Shutdown CDP bridge (V1)  
      if (cdpRelayBridge) {
        cdpRelayBridge.shutdown();
      }
      
      logger.info('V1 WebSocket components shutdown completed');
    }
    
    // 清除所有定时器
    clearTimeout(forceExitTimeout);
    
    logger.info('Graceful shutdown completed');
    
    // Close logger to ensure all logs are written
    await closeLogger();
    
    // 强制退出，不等待其他可能的异步操作
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    clearTimeout(forceExitTimeout);
    process.exit(1);
  }
}

// 防止多次调用 gracefulShutdown
let isShuttingDown = false;

// Setup signal handlers
process.on('SIGTERM', () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    gracefulShutdown('SIGTERM');
  }
});

process.on('SIGINT', () => {
  if (!isShuttingDown) {
    isShuttingDown = true;
    gracefulShutdown('SIGINT');
  }
});

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  if (!isShuttingDown) {
    isShuttingDown = true;
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (!isShuttingDown) {
    isShuttingDown = true;
    gracefulShutdown('unhandledRejection');
  }
});

// Start the server
server.listen(port, '0.0.0.0', () => {
  const chromeConfig = chromeManager.getConfig();
  
  logger.info(`Server is running on http://0.0.0.0:${port}`);
  logger.info(`API Documentation available at http://127.0.0.1:${port}/api-docs`);
  logger.info(`OpenAPI spec available at http://127.0.0.1:${port}/openapi.json`);
  logger.info(`Maximum concurrent instances: ${chromeConfig.maxConcurrentInstances}`);
  logger.info(`Instance timeout: ${chromeConfig.instanceTimeoutMs / 60000} minutes`);
  logger.info(`Inactive check interval: ${chromeConfig.inactiveCheckInterval / 60000} minutes`);
  
  // WebSocket architecture info
  if (config.v2) {
    logger.info('🚀 WebSocket Architecture: V2 (Enhanced Multi-Device Support)');
    logger.info('📡 V2 Endpoints:');
    logger.info(`   - Device Registration: ws://127.0.0.1:${port}/v2/device`);
    logger.info(`   - CDP Communication: ws://127.0.0.1:${port}/v2/cdp/{deviceId}`);
    logger.info(`   - Control Interface: ws://127.0.0.1:${port}/v2/control`);
    logger.info('✨ Features: Thread-safe device registry, intelligent message routing, connection state machine');
  } else {
    logger.info('🔄 WebSocket Architecture: V1 (Legacy Compatibility Mode)');
    logger.info(`📡 WebSocket Endpoint: ws://127.0.0.1:${port}/?token=${config.token}`);
    logger.info('ℹ️  Use --v2 to enable enhanced multi-device architecture');
  }
  
  logger.info('Browser-Go service started successfully');
});