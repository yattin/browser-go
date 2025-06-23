/**
 * CDP Relay Bridge for Extension connections
 * Handles bidirectional message bridging between CDP clients and Chrome extensions
 */

import WebSocket from 'ws';
import { logger } from './logger.js';

export class CDPRelayBridge {
  private _cdpSocket: WebSocket | null = null;
  private _extensionSocket: WebSocket | null = null;
  private _connectionInfo: {
    targetInfo: any;
    sessionId: string;
  } | undefined;

  /**
   * Handle CDP client connections (e.g., Playwright MCP)
   */
  handleCDPConnection(ws: WebSocket): void {
    if (this._cdpSocket?.readyState === WebSocket.OPEN) {
      logger.info('Closing previous CDP connection');
      this._cdpSocket.close(1000, 'New connection established');
    }

    this._cdpSocket = ws;
    logger.info('CDP client connected');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleCDPMessage(message);
      } catch (error) {
        logger.error('Error parsing CDP message:', error);
      }
    });

    ws.on('close', () => {
      if (this._cdpSocket === ws) {
        this._cdpSocket = null;
      }
      logger.info('CDP client disconnected');
    });

    ws.on('error', (error) => {
      logger.error('CDP WebSocket error:', error);
    });
  }

  /**
   * Handle Chrome extension connections
   */
  handleExtensionConnection(ws: WebSocket): void {
    if (this._extensionSocket?.readyState === WebSocket.OPEN) {
      logger.info('Closing previous extension connection');
      this._extensionSocket.close(1000, 'New connection established');
    }

    this._extensionSocket = ws;
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
      if (this._extensionSocket === ws) {
        this._extensionSocket = null;
      }
      logger.info('Extension disconnected');
    });

    ws.on('error', (error) => {
      logger.error('Extension WebSocket error:', error);
    });
  }

  /**
   * Handle messages from CDP clients
   */
  private _handleCDPMessage(message: any): void {
    logger.info(`← CDP: ${message.method || `response(${message.id})`}`);

    // Handle Browser domain methods locally
    if (message.method?.startsWith('Browser.')) {
      this._handleBrowserDomainMethod(message);
      return;
    }

    // Handle Target domain methods
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
      this._connectionInfo = {
        targetInfo: message.targetInfo,
        sessionId: message.sessionId
      };
      return;
    }

    // CDP event from extension
    logger.info(`← Extension message: ${message.method ?? (message.id && `response(id=${message.id})`) ?? 'unknown'}`);
    this._sendToCDP(message);
  }

  /**
   * Handle Browser domain methods locally
   */
  private _handleBrowserDomainMethod(message: any): void {
    switch (message.method) {
      case 'Browser.getVersion':
        this._sendToCDP({
          id: message.id,
          result: {
            protocolVersion: '1.3',
            product: 'Chrome/Extension-Bridge',
            userAgent: 'Browser-Go-Extension-Bridge/1.0.0',
          }
        });
        break;

      case 'Browser.setDownloadBehavior':
        this._sendToCDP({
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
        if (this._connectionInfo && !message.sessionId) {
          logger.info('Simulating auto-attach for target:', JSON.stringify(message));
          this._sendToCDP({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: this._connectionInfo.sessionId,
              targetInfo: {
                ...this._connectionInfo.targetInfo,
                attached: true,
              },
              waitingForDebugger: false
            }
          });
          this._sendToCDP({
            id: message.id,
            result: {}
          });
        } else {
          this._forwardToExtension(message);
        }
        break;

      case 'Target.getTargets':
        const targetInfos = [];
        if (this._connectionInfo) {
          targetInfos.push({
            ...this._connectionInfo.targetInfo,
            attached: true,
          });
        }

        this._sendToCDP({
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
    if (this._extensionSocket?.readyState === WebSocket.OPEN) {
      logger.info(`→ Extension: ${message.method || `command(${message.id})`}`);
      this._extensionSocket.send(JSON.stringify(message));
    } else {
      logger.info('Extension not connected, cannot forward message');
      if (message.id) {
        this._sendToCDP({
          id: message.id,
          error: { message: 'Extension not connected' }
        });
      }
    }
  }

  /**
   * Send message to CDP client
   */
  private _sendToCDP(message: any): void {
    if (this._cdpSocket?.readyState === WebSocket.OPEN) {
      logger.info(`→ CDP: ${JSON.stringify(message)}`);
      this._cdpSocket.send(JSON.stringify(message));
    }
  }
}