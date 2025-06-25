/**
 * CDP Relay Bridge for Extension connections
 * Handles bidirectional message bridging between CDP clients and Chrome extensions
 * with device-based routing support
 */

import WebSocket from 'ws';
import { logger } from './logger.js';
import { DeviceManager } from './device-manager.js';
import { AppConfig } from './types.js';

interface CDPConnection {
  socket: WebSocket;
  deviceId?: string;
  connectedAt: Date;
}

export class CDPRelayBridge {
  private cdpConnections: Map<WebSocket, CDPConnection> = new Map();
  private deviceManager: DeviceManager;
  private config: AppConfig;

  constructor(deviceManager: DeviceManager, config: AppConfig) {
    this.deviceManager = deviceManager;
    this.config = config;
  }

  /**
   * Handle CDP client connections (e.g., Playwright MCP)
   */
  handleCDPConnection(ws: WebSocket, deviceId?: string): void {
    const connection: CDPConnection = {
      socket: ws,
      deviceId,
      connectedAt: new Date(),
    };

    this.cdpConnections.set(ws, connection);
    
    if (deviceId) {
      logger.info(`CDP client connected with device routing: ${deviceId}`);
      
      // Check if target device is connected
      if (!this.deviceManager.isDeviceConnected(deviceId)) {
        logger.warn(`Target device not connected: ${deviceId}`);
        ws.close(1002, `Target device not connected: ${deviceId}`);
        return;
      }
    } else {
      logger.info('CDP client connected without device routing');
    }

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleCDPMessage(ws, message);
      } catch (error) {
        logger.error('Error parsing CDP message:', error);
      }
    });

    ws.on('close', () => {
      this.cdpConnections.delete(ws);
      logger.info(`CDP client disconnected${deviceId ? ` (device: ${deviceId})` : ''}`);
    });

    ws.on('error', (error) => {
      logger.error('CDP WebSocket error:', error);
    });
  }

  /**
   * Handle Chrome extension connections
   */
  handleExtensionConnection(ws: WebSocket): void {
    logger.info('Extension connection attempt');

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handleExtensionMessage(ws, message);
      } catch (error) {
        logger.error('Error parsing extension message:', error);
      }
    });

    ws.on('close', () => {
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
   * Handle messages from CDP clients
   */
  private _handleCDPMessage(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) {
      logger.error('CDP message from unknown connection');
      return;
    }

    const deviceId = connection.deviceId || 'none';
    this._logCDPProtocol('←', 'CDP Client', `Bridge(${deviceId})`, message);

    // Handle Browser domain methods locally
    if (message.method?.startsWith('Browser.')) {
      this._handleBrowserDomainMethod(cdpSocket, message);
      return;
    }

    // Handle Target domain methods
    if (message.method?.startsWith('Target.')) {
      this._handleTargetDomainMethod(cdpSocket, message);
      return;
    }

    // Handle Page domain methods locally for Patchright compatibility
    if (message.method?.startsWith('Page.') && this._shouldHandlePageMethodLocally(message.method)) {
      this._handlePageDomainMethod(cdpSocket, message);
      return;
    }

    // Forward other commands to extension
    if (message.method) {
      this._forwardToExtension(cdpSocket, message);
    }
  }

  /**
   * Handle messages from Chrome extensions
   */
  private _handleExtensionMessage(extensionSocket: WebSocket, message: any): void {
    // Handle device registration
    if (message.type === 'device_register') {
      this.deviceManager.registerDevice(
        message.deviceId,
        message.deviceInfo,
        extensionSocket
      );
      return;
    }

    // Handle connection info from extension
    if (message.type === 'connection_info') {
      logger.info('← Extension connected to tab:', message);
      
      if (message.deviceId) {
        this.deviceManager.updateDeviceConnectionInfo(message.deviceId, {
          sessionId: message.sessionId,
          targetInfo: message.targetInfo
        });
      }
      return;
    }

    // Handle ping messages (heartbeat)
    if (message.type === 'ping') {
      logger.debug(`← Extension heartbeat from device: ${message.deviceId}`);
      
      // Update device last seen time
      if (message.deviceId) {
        const device = this.deviceManager.getDevice(message.deviceId);
        if (device) {
          device.lastSeen = new Date();
        }
      }
      
      // Send pong response
      extensionSocket.send(JSON.stringify({
        type: 'pong',
        deviceId: message.deviceId,
        timestamp: Date.now()
      }));
      return;
    }

    // Find the device ID for this extension
    let deviceId: string | null = null;
    const devices = this.deviceManager.getAllDevices();
    for (const device of devices) {
      if (device.extensionSocket === extensionSocket) {
        deviceId = device.deviceId;
        break;
      }
    }

    // Log the extension message using detailed protocol logging
    this._logCDPProtocol('←', `Extension(${deviceId || 'unknown'})`, 'Bridge', message);
    
    // Handle error responses specially
    if (message.error) {
      if (message.error.code === -32000) {
        logger.warn(`← Extension reported error -32000: ${message.error.message}`);
        
        // For standalone API errors, provide additional context
        if (!message.id && message.error.message.includes('debugger.sendCommand')) {
          logger.error('Chrome Extension API error: debugger.sendCommand parameter signature mismatch');
          logger.error('This usually indicates incorrect parameter types or missing debugger attachment');
        }
      } else {
        logger.warn(`← Extension reported error ${message.error.code}: ${message.error.message}`);
      }
    }
    
    // Handle message forwarding based on type
    if (message.error && !message.id) {
      // Standalone error messages are not forwarded to CDP clients
      // as they don't correspond to any specific request
      logger.info('Standalone error message not forwarded to CDP clients');
      return;
    }
    
    this._forwardToCDPClients(extensionSocket, message);
  }

  /**
   * Handle Browser domain methods locally
   */
  private _handleBrowserDomainMethod(cdpSocket: WebSocket, message: any): void {
    switch (message.method) {
      case 'Browser.getVersion':
        this._sendToCDP(cdpSocket, {
          id: message.id,
          result: {
            protocolVersion: '1.3',
            product: 'Chrome/Extension-Bridge',
            userAgent: 'Browser-Go-Extension-Bridge/1.0.0',
          }
        });
        break;

      case 'Browser.setDownloadBehavior':
        this._sendToCDP(cdpSocket, {
          id: message.id,
          result: {}
        });
        break;

      default:
        this._forwardToExtension(cdpSocket, message);
    }
  }

  /**
   * Check if Page method should be handled locally for Patchright compatibility
   */
  private _shouldHandlePageMethodLocally(method: string): boolean {
    const localPageMethods = [
      'Page.getFrameTree'  // Critical for Patchright frame management
    ];
    return localPageMethods.includes(method);
  }

  /**
   * Handle critical Page domain methods locally for Patchright compatibility
   */
  private _handlePageDomainMethod(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) return;

    switch (message.method) {
      case 'Page.getFrameTree': {
        const device = connection.deviceId ? this.deviceManager.getDevice(connection.deviceId) : null;
        const connectionInfo = device?.connectionInfo;
        
        if (connectionInfo) {
          // Provide a stable frame tree structure for Patchright
          const frameUrl = connectionInfo.targetInfo.url || 'about:blank';
          let securityOrigin = 'null';
          let domainAndRegistry = '';
          let secureContextType = 'Insecure';
          
          try {
            if (frameUrl !== 'about:blank' && frameUrl.startsWith('http')) {
              const url = new URL(frameUrl);
              securityOrigin = url.origin;
              domainAndRegistry = url.hostname;
              secureContextType = frameUrl.startsWith('https') ? 'Secure' : 'Insecure';
            }
          } catch (error) {
            // Fallback to default values for invalid URLs
            securityOrigin = 'null';
            domainAndRegistry = '';
            secureContextType = 'Insecure';
          }
          
          this._sendToCDP(cdpSocket, {
            id: message.id,
            result: {
              frameTree: {
                frame: {
                  id: connectionInfo.targetInfo.targetId,
                  loaderId: connectionInfo.targetInfo.targetId + '_loader',
                  url: frameUrl,
                  domainAndRegistry: domainAndRegistry,
                  securityOrigin: securityOrigin,
                  mimeType: 'text/html',
                  secureContextType: secureContextType,
                  crossOriginIsolatedContextType: 'NotIsolated',
                  gatedAPIFeatures: []
                },
                childFrames: []
              }
            }
          });
        } else {
          // Fallback: forward to extension
          this._forwardToExtension(cdpSocket, message);
        }
        break;
      }

      default:
        // For other Page methods, forward to extension
        this._forwardToExtension(cdpSocket, message);
    }
  }

  /**
   * Handle Target domain methods locally
   */
  private _handleTargetDomainMethod(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) return;

    switch (message.method) {
      case 'Target.setAutoAttach': {
        // Get device connection info for auto-attach simulation
        const device = connection.deviceId ? this.deviceManager.getDevice(connection.deviceId) : null;
        const connectionInfo = device?.connectionInfo;
        
        if (connectionInfo && !message.sessionId) {
          // Simulate auto-attach behavior only for main target (no sessionId)
          // This matches Microsoft's playwright-mcp implementation
          logger.info('Simulating auto-attach for main target');
          
          // First send the Target.attachedToTarget event
          this._sendToCDP(cdpSocket, {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: connectionInfo.sessionId,
              targetInfo: {
                ...connectionInfo.targetInfo,
                attached: true,
              },
              waitingForDebugger: false
            }
          });
          
          // Then send the success response
          this._sendToCDP(cdpSocket, {
            id: message.id,
            result: {}
          });
        } else {
          // For session-specific auto-attach or when no connection info, forward to extension
          this._forwardToExtension(cdpSocket, message);
        }
        break;
      }

      case 'Target.getTargets': {
        const targetInfos = [];
        const deviceInfo = connection.deviceId ? this.deviceManager.getDevice(connection.deviceId) : null;
        
        if (deviceInfo?.connectionInfo) {
          targetInfos.push({
            ...deviceInfo.connectionInfo.targetInfo,
            attached: true,
          });
        }

        this._sendToCDP(cdpSocket, {
          id: message.id,
          result: { targetInfos }
        });
        break;
      }

      default:
        this._forwardToExtension(cdpSocket, message);
    }
  }

  /**
   * Forward message to Chrome extension
   */
  private _forwardToExtension(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) return;

    const deviceSocket = connection.deviceId 
      ? this.deviceManager.getDeviceSocket(connection.deviceId)
      : null;

    if (deviceSocket) {
      this._logCDPProtocol('→', `Bridge(${connection.deviceId})`, `Extension(${connection.deviceId})`, message);
      deviceSocket.send(JSON.stringify(message));
    } else {
      logger.info(`Extension not connected for device: ${connection.deviceId || 'none'}`);
      if (message.id) {
        const errorResponse = {
          id: message.id,
          error: { message: `Extension not connected for device: ${connection.deviceId || 'none'}` }
        };
        this._sendToCDP(cdpSocket, errorResponse);
      }
    }
  }

  /**
   * Forward message to relevant CDP clients
   */
  private _forwardToCDPClients(extensionSocket: WebSocket, message: any): void {
    // Find the device ID for this extension socket
    let deviceId: string | null = null;
    const devices = this.deviceManager.getAllDevices();
    for (const device of devices) {
      if (device.extensionSocket === extensionSocket) {
        deviceId = device.deviceId;
        break;
      }
    }

    if (!deviceId) {
      logger.warn('Cannot forward message: device ID not found for extension socket');
      return;
    }

    // Forward to CDP connections for this device
    let forwarded = false;
    for (const [cdpSocket, connection] of this.cdpConnections.entries()) {
      logger.debug(`Checking message to CDP client for device: ${connection.deviceId}`);
      if (connection.deviceId === deviceId) {
        if (cdpSocket.readyState === WebSocket.OPEN) {
          try {
            this._logCDPProtocol('→', `Bridge(${deviceId})`, `CDP Client(${deviceId})`, message);
            cdpSocket.send(JSON.stringify(message));
            forwarded = true;
          } catch (error) {
            logger.error(`Failed to forward message to CDP client: ${error}`);
          }
        } else {
          logger.warn(`CDP client socket is not open for device: ${deviceId}`);
        }
      }
    }

    if (!forwarded) {
      logger.warn(`No active CDP connections found for device: ${deviceId}`);
    }
  }

  /**
   * Send message to specific CDP client
   */
  private _sendToCDP(cdpSocket: WebSocket, message: any): void {
    if (cdpSocket.readyState === WebSocket.OPEN) {
      const connection = this.cdpConnections.get(cdpSocket);
      const deviceId = connection?.deviceId || 'none';
      this._logCDPProtocol('→', `Bridge(${deviceId})`, `CDP Client(${deviceId})`, message);
      cdpSocket.send(JSON.stringify(message));
    }
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    cdpConnections: number;
    deviceConnections: number;
  } {
    return {
      cdpConnections: this.cdpConnections.size,
      deviceConnections: this.deviceManager.getDeviceStats().connectedDevices,
    };
  }
}