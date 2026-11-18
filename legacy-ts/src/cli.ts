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
const deviceManager = new DeviceManager();
const cdpRelayBridge = new CDPRelayBridge(deviceManager, config);
const webSocketHandlers = new WebSocketHandlers(cdpRelayBridge, chromeManager, deviceManager, config.token);
const apiRoutes = new ApiRoutes(chromeManager, deviceManager);

// Setup API routes
apiRoutes.setupRoutes(app);

// Create HTTP server
const server: Server = http.createServer(app);

// Setup WebSocket upgrade handling
server.on('upgrade', async (req, socket, head) => {
  await webSocketHandlers.handleUpgrade(req, socket, head);
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
    
    // Shutdown Device manager
    logger.info('Shutting down Device manager...');
    deviceManager.shutdown();
    logger.info('Device manager shutdown completed');
    
    // Shutdown CDP bridge
    logger.info('Shutting down CDP bridge...');
    cdpRelayBridge.shutdown();
    logger.info('CDP bridge shutdown completed');
    
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
  logger.info('Browser-Go service started successfully');
});