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

interface CDPConnection {
  socket: WebSocket;
  deviceId: string | undefined;
  connectionId: string;
  connectionInfo?: ConnectionInfo;
}

export class CDPRelayBridge {
  private playwrightSocket: WebSocket | null = null; // 保留用于向后兼容
  private extensionSocket: WebSocket | null = null;
  private connectionInfo: ConnectionInfo | undefined; // 保留用于向后兼容
  private deviceManager: DeviceManager;
  private config: AppConfig;
  private currentDeviceId: string | undefined; // 保留用于向后兼容
  private cdpConnections: Map<string, CDPConnection> = new Map(); // 多设备连接
  private messageToConnection: Map<string, string> = new Map(); // 消息ID到连接ID的映射

  constructor(deviceManager: DeviceManager, config: AppConfig) {
    this.deviceManager = deviceManager;
    this.config = config;
  }

  /**
   * Handle CDP client connections (Playwright)
   */
  handleCDPConnection(ws: WebSocket, deviceId?: string): void {
    // 生成唯一的连接ID
    const connectionId = `cdp-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    
    // 创建连接对象
    const connection: CDPConnection = {
      socket: ws,
      deviceId,
      connectionId
    };

    // 存储连接
    this.cdpConnections.set(connectionId, connection);
    logger.info(`Playwright connected (${connectionId})${deviceId ? ` for device: ${deviceId}` : ''}`);

    // 向后兼容：如果没有其他连接，设置为主连接
    if (!this.playwrightSocket) {
      this.playwrightSocket = ws;
      this.currentDeviceId = deviceId;
    }

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this._handlePlaywrightMessage(message, connectionId);
      } catch (error) {
        logger.error('Error parsing Playwright message:', error);
      }
    });

    ws.on('close', () => {
      // 清理连接
      this.cdpConnections.delete(connectionId);
      logger.info(`Playwright disconnected (${connectionId})`);
      
      // 清理该连接相关的消息映射
      for (const [messageId, connId] of this.messageToConnection.entries()) {
        if (connId === connectionId) {
          this.messageToConnection.delete(messageId);
        }
      }
      
      // 向后兼容：如果是主连接，清理状态
      if (this.playwrightSocket === ws) {
        this.playwrightSocket = null;
        this.currentDeviceId = undefined;
        
        // 尝试选择新的主连接
        const remaining = Array.from(this.cdpConnections.values());
        if (remaining.length > 0) {
          const newMain = remaining[0];
          this.playwrightSocket = newMain.socket;
          this.currentDeviceId = newMain.deviceId;
        }
      }
    });

    ws.on('error', (error) => {
      logger.error('Playwright WebSocket error:', error);
    });
  }

  /**
   * Handle Chrome extension connections
   */
  handleExtensionConnection(ws: WebSocket): void {
    // In multi-device mode, avoid closing active device connections
    // Check if the current extensionSocket is actively used by registered devices
    let shouldCloseOldConnection = false;
    
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      const registeredDevices = this.deviceManager.getAllDevices();
      const activeDeviceUsingOldSocket = registeredDevices.find(
        device => device.extensionSocket === this.extensionSocket
      );
      
      if (!activeDeviceUsingOldSocket) {
        logger.info('Closing unused extension connection');
        shouldCloseOldConnection = true;
      } else {
        logger.info(`Keeping existing connection - used by device: ${activeDeviceUsingOldSocket.deviceId}`);
      }
    }
    
    if (shouldCloseOldConnection && this.extensionSocket) {
      this.extensionSocket.close(1000, 'New connection established');
      // Remove all listeners from old socket to prevent event conflicts
      this.extensionSocket.removeAllListeners();
    }

    // Keep the last extension socket for backward compatibility
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
  private _handlePlaywrightMessage(message: any, connectionId?: string): void {
    this._logCDPProtocol('←', 'Playwright', 'Bridge', message);

    // Handle Browser domain methods locally
    if (message.method?.startsWith('Browser.')) {
      this._handleBrowserDomainMethod(message, connectionId);
      return;
    }

    // Handle Target domain methods locally
    if (message.method?.startsWith('Target.')) {
      this._handleTargetDomainMethod(message, connectionId);
      return;
    }

    // Forward other commands to extension
    if (message.method) {
      this._forwardToExtension(message, connectionId);
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
      
      // 维护设备连接池：只有在设备不存在或连接不匹配时才重新注册
      if (message.deviceId && this.extensionSocket) {
        const existingDevice = this.deviceManager.getDevice(message.deviceId);
        if (!existingDevice || existingDevice.extensionSocket !== this.extensionSocket) {
          this.deviceManager.registerDevice(message.deviceId, {
            name: 'Chrome Extension',
            version: '1.0.0',
            userAgent: 'Browser-Go-Extension',
            timestamp: new Date().toISOString()
          }, this.extensionSocket);
        }
      }
      
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

    // CDP event from extension - 发送给对应的连接
    this._logCDPProtocol('←', 'Extension', 'Bridge', message);
    
    // 如果是响应消息(有id)，找到对应的连接
    if (message.id) {
      const targetConnectionId = this.messageToConnection.get(message.id);
      if (targetConnectionId) {
        // 发送给发起请求的连接
        this._sendToPlaywright(message, targetConnectionId);
        // 清理映射
        this.messageToConnection.delete(message.id);
        return;
      }
    }
    
    // 如果是事件消息(没有id)或找不到对应连接，广播给所有连接
    let sent = false;
    for (const connection of this.cdpConnections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        this._sendToPlaywright(message, connection.connectionId);
        sent = true;
      }
    }
    
    // 如果没有多设备连接，使用向后兼容模式
    if (!sent) {
      this._sendToPlaywright(message);
    }
  }

  /**
   * Handle Browser domain methods locally
   */
  private _handleBrowserDomainMethod(message: any, connectionId?: string): void {
    switch (message.method) {
      case 'Browser.getVersion':
        this._sendToPlaywright({
          id: message.id,
          result: {
            protocolVersion: '1.3',
            product: 'Chrome/Extension-Bridge',
            userAgent: 'Browser-Go-Extension-Bridge/1.0.0',
          }
        }, connectionId);
        break;

      case 'Browser.setDownloadBehavior':
        this._sendToPlaywright({
          id: message.id,
          result: {}
        }, connectionId);
        break;

      default:
        this._forwardToExtension(message, connectionId);
    }
  }


  /**
   * Handle Target domain methods locally
   */
  private _handleTargetDomainMethod(message: any, connectionId?: string): void {
    // 获取连接的connectionInfo，如果有多设备连接则使用对应连接的信息
    let connectionInfo = this.connectionInfo;
    if (connectionId) {
      const connection = this.cdpConnections.get(connectionId);
      if (connection?.connectionInfo) {
        connectionInfo = connection.connectionInfo;
      }
    }

    switch (message.method) {
      case 'Target.setAutoAttach':
        // Simulate auto-attach behavior with real target info
        if (connectionInfo && !message.sessionId) {
          logger.info('Simulating auto-attach for target:', JSON.stringify(message));
          this._sendToPlaywright({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: connectionInfo.sessionId,
              targetInfo: {
                ...connectionInfo.targetInfo,
                attached: true,
              },
              waitingForDebugger: false
            }
          }, connectionId);
          this._sendToPlaywright({
            id: message.id,
            result: {}
          }, connectionId);
        } else {
          this._forwardToExtension(message, connectionId);
        }
        break;

      case 'Target.getTargets':
        const targetInfos = [];
        if (connectionInfo) {
          targetInfos.push({
            ...connectionInfo.targetInfo,
            attached: true,
          });
        }
        this._sendToPlaywright({
          id: message.id,
          result: { targetInfos }
        }, connectionId);
        break;

      default:
        this._forwardToExtension(message, connectionId);
    }
  }

  /**
   * Forward message to Chrome extension
   */
  private _forwardToExtension(message: any, connectionId?: string): void {
    // 记录消息ID到连接ID的映射，用于响应时路由
    if (message.id && connectionId) {
      this.messageToConnection.set(message.id, connectionId);
    }

    // 获取当前连接的设备ID
    let targetDeviceId = this.currentDeviceId;
    if (connectionId) {
      const connection = this.cdpConnections.get(connectionId);
      if (connection) {
        targetDeviceId = connection.deviceId;
      }
    }

    // Use device routing if deviceId is specified
    if (targetDeviceId) {
      const deviceSocket = this.deviceManager.getDeviceSocket(targetDeviceId);
      if (deviceSocket) {
        this._logCDPProtocol('→', 'Bridge', `Extension(${targetDeviceId})`, message);
        deviceSocket.send(JSON.stringify(message));
        return;
      } else {
        logger.info(`Device ${targetDeviceId} not connected, cannot forward message`);
        if (message.id) {
          this._sendToPlaywright({
            id: message.id,
            error: { message: `Device ${targetDeviceId} not connected` }
          }, connectionId);
          // 清理映射
          this.messageToConnection.delete(message.id);
        }
        return;
      }
    }

    // Fallback to direct extension socket for backward compatibility
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      this._logCDPProtocol('→', 'Bridge', 'Extension', message);
      this.extensionSocket.send(JSON.stringify(message));
    } else {
      logger.info('Extension not connected, cannot forward message');
      if (message.id) {
        this._sendToPlaywright({
          id: message.id,
          error: { message: 'Extension not connected' }
        }, connectionId);
        // 清理映射
        if (connectionId) {
          this.messageToConnection.delete(message.id);
        }
      }
    }
  }

  /**
   * Forward message to Playwright
   */
  private _sendToPlaywright(message: any, connectionId?: string): void {
    // 如果指定了connectionId，发送给特定连接
    if (connectionId) {
      const connection = this.cdpConnections.get(connectionId);
      if (connection?.socket.readyState === WebSocket.OPEN) {
        this._logCDPProtocol('→', 'Bridge', `Playwright(${connectionId})`, message);
        connection.socket.send(JSON.stringify(message));
        return;
      }
    }

    // 向后兼容：发送给主连接
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
    cdpConnections: number;
    activeDevices: string[];
  } {
    const activeConnections = Array.from(this.cdpConnections.values())
      .filter(conn => conn.socket.readyState === WebSocket.OPEN);
    
    const activeDevices = activeConnections
      .map(conn => conn.deviceId)
      .filter(id => id) as string[];

    return {
      playwrightConnected: this.playwrightSocket?.readyState === WebSocket.OPEN,
      extensionConnected: this.extensionSocket?.readyState === WebSocket.OPEN,
      cdpConnections: activeConnections.length,
      activeDevices: [...new Set(activeDevices)], // 去重
    };
  }

  /**
   * Shutdown the CDP bridge and close all connections
   */
  shutdown(): void {
    logger.info('Shutting down CDP bridge...');
    
    // Close all CDP connections
    for (const [connectionId, connection] of this.cdpConnections.entries()) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        logger.info(`Closing CDP connection: ${connectionId}`);
        connection.socket.close(1000, 'Server shutdown');
      }
    }
    this.cdpConnections.clear();
    
    // Clear message mappings
    this.messageToConnection.clear();
    
    // Close Playwright socket (backward compatibility)
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