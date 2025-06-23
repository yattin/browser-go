#!/usr/bin/env node

/**
 * Browser-Go Service Main Entry Point
 * Integrates all modules and starts the HTTP/WebSocket server
 */

import express, { Application } from 'express';
import http, { Server } from 'http';
import swaggerUi from 'swagger-ui-express';

import { logger } from './logger.js';
import { getAppConfig } from './config.js';
import { loadOpenApiSpec } from './openapi.js';
import { CDPRelayBridge } from './cdp-bridge.js';
import { ChromeManager } from './chrome-manager.js';
import { WebSocketHandlers } from './websocket-handlers.js';
import { ApiRoutes } from './api-routes.js';

// Initialize configuration
const config = getAppConfig();
const app: Application = express();
const port: number = 3000;

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
const cdpRelayBridge = new CDPRelayBridge();
const webSocketHandlers = new WebSocketHandlers(cdpRelayBridge, chromeManager, config.token);
const apiRoutes = new ApiRoutes(chromeManager);

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
  
  try {
    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    
    // Shutdown Chrome manager
    await chromeManager.shutdown();
    
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Setup signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
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