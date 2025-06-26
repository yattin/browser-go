/**
 * CDP Relay Bridge for Extension connections
 * Simplified implementation based on Microsoft's playwright-mcp architecture
 * Handles bidirectional message bridging between CDP clients and Chrome extensions
 */

import WebSocket from 'ws';
import { logger } from './logger.js';
import { DeviceManager } from './device-manager.js';
import { AppConfig } from './types.js';

interface ConnectionInfo {
  targetInfo: any;
  sessionId: string;
}

export class CDPRelayBridge {
  private playwrightSocket: WebSocket | null = null;
  private extensionSocket: WebSocket | null = null;
  private connectionInfo: ConnectionInfo | undefined;
  private deviceManager: DeviceManager;
  private config: AppConfig;

  constructor(deviceManager: DeviceManager, config: AppConfig) {
    this.deviceManager = deviceManager;
    this.config = config;
  }

  /**
   * Handle CDP client connections (Playwright)
   */
  handleCDPConnection(ws: WebSocket, deviceId?: string): void {
    // Close previous connection if exists
    if (this.playwrightSocket?.readyState === WebSocket.OPEN) {
      logger.info('Closing previous Playwright connection');
      this.playwrightSocket.close(1000, 'New connection established');
    }

    this.playwrightSocket = ws;
    logger.info('Playwright connected');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handlePlaywrightMessage(message);
      } catch (error) {
        logger.error('Error parsing Playwright message:', error);
      }
    });

    ws.on('close', () => {
      if (this.playwrightSocket === ws) {
        this.playwrightSocket = null;
      }
      logger.info('Playwright disconnected');
    });

    ws.on('error', (error) => {
      logger.error('Playwright WebSocket error:', error);
    });
  }

  /**
   * Handle Chrome extension connections
   */
  handleExtensionConnection(ws: WebSocket): void {
    // Close previous connection if exists
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      logger.info('Closing previous extension connection');
      this.extensionSocket.close(1000, 'New connection established');
    }

    this.extensionSocket = ws;
    logger.info('Extension connected');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleExtensionMessage(message);
      } catch (error) {
        logger.error('Error parsing extension message:', error);
      }
    });

    ws.on('close', () => {
      if (this.extensionSocket === ws) {
        this.extensionSocket = null;
      }
      logger.info('Extension disconnected');
    });

    ws.on('error', (error) => {
      logger.error('Extension WebSocket error:', error);
    });
  }

  /**
   * Log CDP protocol data with detailed information when enabled
   */
  private _logCDPProtocol(direction: '→' | '←', source: string, target: string, message: any): void {
    const methodOrType = message.method || 
      (message.error ? `error_response(id=${message.id}, code=${message.error.code})` : 
       `response(id=${message.id})`);
    
    // Always log basic message info
    logger.info(`${direction} ${source} → ${target}: ${methodOrType}`);
    
    // Log detailed protocol data when enabled
    if (this.config.cdpLogging) {
      const timestamp = new Date().toISOString();
      const messageSize = JSON.stringify(message).length;
      
      logger.info(`[CDP-PROTOCOL] ${timestamp} ${direction} ${source} → ${target}:`);
      logger.info(`[CDP-PROTOCOL] Message Size: ${messageSize} bytes`);
      logger.info(`[CDP-PROTOCOL] Full Message: ${JSON.stringify(message, null, 2)}`);
      
      // Additional analysis for method calls
      if (message.method) {
        const domain = message.method.split('.')[0];
        logger.info(`[CDP-PROTOCOL] Domain: ${domain}, Method: ${message.method}`);
        if (message.params && Object.keys(message.params).length > 0) {
          logger.info(`[CDP-PROTOCOL] Parameters: ${JSON.stringify(message.params, null, 2)}`);
        }
      }
      
      // Additional analysis for responses
      if (message.result || message.error) {
        if (message.error) {
          logger.info(`[CDP-PROTOCOL] Error Code: ${message.error.code}`);
          logger.info(`[CDP-PROTOCOL] Error Message: ${message.error.message}`);
          if (message.error.data) {
            logger.info(`[CDP-PROTOCOL] Error Data: ${JSON.stringify(message.error.data, null, 2)}`);
          }
        } else if (message.result) {
          logger.info(`[CDP-PROTOCOL] Result Keys: ${Object.keys(message.result).join(', ')}`);
        }
      }
      
      logger.info('[CDP-PROTOCOL] ----------------------------------------');
    }
  }

  /**
   * Handle messages from Playwright
   */
  private _handlePlaywrightMessage(message: any): void {
    this._logCDPProtocol('←', 'Playwright', 'Bridge', message);

    // Handle Browser domain methods locally
    if (message.method?.startsWith('Browser.')) {
      this._handleBrowserDomainMethod(message);
      return;
    }

    // Handle Target domain methods locally
    if (message.method?.startsWith('Target.')) {
      this._handleTargetDomainMethod(message);
      return;
    }

    // Forward other commands to extension
    if (message.method) {
      this._forwardToExtension(message);
    }
  }

  /**
   * Handle messages from Chrome extensions
   */
  private _handleExtensionMessage(message: any): void {
    // Handle connection info from extension
    if (message.type === 'connection_info') {
      logger.info('← Extension connected to tab:', message);
      this.connectionInfo = {
        targetInfo: message.targetInfo,
        sessionId: message.sessionId
      };
      return;
    }

    // Handle ping messages separately - only log heartbeat info
    if (message.type === 'ping') {
      logger.info(`← Heartbeat ping from device: ${message.deviceId}`);
      // Send pong response
      if (this.extensionSocket?.readyState === WebSocket.OPEN) {
        const pongMessage = {
          type: 'pong',
          deviceId: message.deviceId,
          timestamp: Date.now()
        };
        this.extensionSocket.send(JSON.stringify(pongMessage));
        logger.info(`→ Heartbeat pong to device: ${message.deviceId}`);
      }
      return;
    }

    // CDP event from extension
    this._logCDPProtocol('←', 'Extension', 'Bridge', message);
    this._sendToPlaywright(message);
  }

  /**
   * Handle Browser domain methods locally
   */
  private _handleBrowserDomainMethod(message: any): void {
    switch (message.method) {
      case 'Browser.getVersion':
        this._sendToPlaywright({
          id: message.id,
          result: {
            protocolVersion: '1.3',
            product: 'Chrome/Extension-Bridge',
            userAgent: 'Browser-Go-Extension-Bridge/1.0.0',
          }
        });
        break;

      case 'Browser.setDownloadBehavior':
        this._sendToPlaywright({
          id: message.id,
          result: {}
        });
        break;

      default:
        this._forwardToExtension(message);
    }
  }


  /**
   * Handle Target domain methods locally
   */
  private _handleTargetDomainMethod(message: any): void {
    switch (message.method) {
      case 'Target.setAutoAttach':
        // Simulate auto-attach behavior with real target info
        if (this.connectionInfo && !message.sessionId) {
          logger.info('Simulating auto-attach for target:', JSON.stringify(message));
          this._sendToPlaywright({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: this.connectionInfo.sessionId,
              targetInfo: {
                ...this.connectionInfo.targetInfo,
                attached: true,
              },
              waitingForDebugger: false
            }
          });
          this._sendToPlaywright({
            id: message.id,
            result: {}
          });
        } else {
          this._forwardToExtension(message);
        }
        break;

      case 'Target.getTargets':
        const targetInfos = [];
        if (this.connectionInfo) {
          targetInfos.push({
            ...this.connectionInfo.targetInfo,
            attached: true,
          });
        }
        this._sendToPlaywright({
          id: message.id,
          result: { targetInfos }
        });
        break;

      default:
        this._forwardToExtension(message);
    }
  }

  /**
   * Forward message to Chrome extension
   */
  private _forwardToExtension(message: any): void {
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      this._logCDPProtocol('→', 'Bridge', 'Extension', message);
      this.extensionSocket.send(JSON.stringify(message));
    } else {
      logger.info('Extension not connected, cannot forward message');
      if (message.id) {
        this._sendToPlaywright({
          id: message.id,
          error: { message: 'Extension not connected' }
        });
      }
    }
  }

  /**
   * Forward message to Playwright
   */
  private _sendToPlaywright(message: any): void {
    if (this.playwrightSocket?.readyState === WebSocket.OPEN) {
      this._logCDPProtocol('→', 'Bridge', 'Playwright', message);
      this.playwrightSocket.send(JSON.stringify(message));
    }
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    playwrightConnected: boolean;
    extensionConnected: boolean;
  } {
    return {
      playwrightConnected: this.playwrightSocket?.readyState === WebSocket.OPEN,
      extensionConnected: this.extensionSocket?.readyState === WebSocket.OPEN,
    };
  }

  /**
   * Shutdown the CDP bridge and close all connections
   */
  shutdown(): void {
    logger.info('Shutting down CDP bridge...');
    
    // Close Playwright socket
    if (this.playwrightSocket?.readyState === WebSocket.OPEN) {
      this.playwrightSocket.close(1000, 'Server shutdown');
      this.playwrightSocket = null;
    }
    
    // Close Extension socket
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      this.extensionSocket.close(1000, 'Server shutdown');
      this.extensionSocket = null;
    }
    
    logger.info('CDP bridge shutdown completed');
  }
}