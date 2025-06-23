/**
 * CDP Relay Bridge for Extension connections
 * Handles bidirectional message bridging between CDP clients and Chrome extensions
 * with device-based routing support
 */

import WebSocket from 'ws';
import { logger } from './logger.js';
import { DeviceManager } from './device-manager.js';

interface CDPConnection {
  socket: WebSocket;
  deviceId?: string;
  connectedAt: Date;
}

export class CDPRelayBridge {
  private cdpConnections: Map<WebSocket, CDPConnection> = new Map();
  private deviceManager: DeviceManager;

  constructor(deviceManager: DeviceManager) {
    this.deviceManager = deviceManager;
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
   * Handle messages from CDP clients
   */
  private _handleCDPMessage(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) {
      logger.error('CDP message from unknown connection');
      return;
    }

    logger.info(`← CDP: ${message.method || `response(${message.id})`}`);

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

    // CDP event from extension - forward to all relevant CDP connections
    logger.info(`← Extension message: ${message.method ?? (message.id && `response(id=${message.id})`) ?? 'unknown'}`);
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
   * Handle Target domain methods locally
   */
  private _handleTargetDomainMethod(cdpSocket: WebSocket, message: any): void {
    const connection = this.cdpConnections.get(cdpSocket);
    if (!connection) return;

    switch (message.method) {
      case 'Target.setAutoAttach':
        // Get device connection info for auto-attach simulation
        const device = connection.deviceId ? this.deviceManager.getDevice(connection.deviceId) : null;
        const connectionInfo = device?.connectionInfo;
        
        if (connectionInfo && !message.sessionId) {
          logger.info('Simulating auto-attach for target:', JSON.stringify(message));
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
          this._sendToCDP(cdpSocket, {
            id: message.id,
            result: {}
          });
        } else {
          this._forwardToExtension(cdpSocket, message);
        }
        break;

      case 'Target.getTargets':
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
      logger.info(`→ Extension (${connection.deviceId}): ${message.method || `command(${message.id})`}`);
      deviceSocket.send(JSON.stringify(message));
    } else {
      logger.info(`Extension not connected for device: ${connection.deviceId || 'none'}`);
      if (message.id) {
        this._sendToCDP(cdpSocket, {
          id: message.id,
          error: { message: `Extension not connected for device: ${connection.deviceId || 'none'}` }
        });
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

    // Forward to CDP connections for this device
    for (const [cdpSocket, connection] of this.cdpConnections.entries()) {
      if (connection.deviceId === deviceId || (!connection.deviceId && !deviceId)) {
        if (cdpSocket.readyState === WebSocket.OPEN) {
          logger.info(`→ CDP (${connection.deviceId || 'unrouted'}): ${JSON.stringify(message)}`);
          cdpSocket.send(JSON.stringify(message));
        }
      }
    }
  }

  /**
   * Send message to specific CDP client
   */
  private _sendToCDP(cdpSocket: WebSocket, message: any): void {
    if (cdpSocket.readyState === WebSocket.OPEN) {
      logger.info(`→ CDP: ${JSON.stringify(message)}`);
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