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

interface MessageMapping {
  connectionId: string;
  timestamp: number;
}

export class CDPRelayBridge {
  private playwrightSocket: WebSocket | null = null; // 保留用于向后兼容
  private extensionSocket: WebSocket | null = null;
  private deviceManager: DeviceManager;
  private config: AppConfig;
  private currentDeviceId: string | undefined; // 保留用于向后兼容
  private cdpConnections: Map<string, CDPConnection> = new Map(); // 多设备连接
  private messageToConnection: Map<string, MessageMapping> = new Map(); // 消息ID到连接ID的映射，key格式：connectionId:messageId
  private messageCleanupInterval: NodeJS.Timeout | null = null;
  private MESSAGE_TTL_MS = 60000; // 消息映射超时时间：60秒

  constructor(deviceManager: DeviceManager, config: AppConfig) {
    this.deviceManager = deviceManager;
    this.config = config;
    
    // 启动定期清理消息映射
    this.startMessageCleanup();
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
      for (const [key, mapping] of this.messageToConnection.entries()) {
        if (mapping.connectionId === connectionId) {
          this.messageToConnection.delete(key);
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
   * Start periodic cleanup of expired message mappings
   */
  private startMessageCleanup(): void {
    this.messageCleanupInterval = setInterval(() => {
      const now = Date.now();
      let cleanedCount = 0;
      
      for (const [key, mapping] of this.messageToConnection.entries()) {
        if (now - mapping.timestamp > this.MESSAGE_TTL_MS) {
          this.messageToConnection.delete(key);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.debug(`Cleaned up ${cleanedCount} expired message mappings`);
      }
    }, 30000); // 每30秒检查一次
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
      
      // 移除所有事件监听器
      ws.removeAllListeners();
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
      
      // 优化：缓存序列化结果，避免重复序列化
      const messageStr = JSON.stringify(message);
      const messageSize = messageStr.length;
      const MAX_LOG_SIZE = 5000; // 5KB 限制
      
      logger.info(`[CDP-PROTOCOL] ${timestamp} ${direction} ${source} → ${target}:`);
      logger.info(`[CDP-PROTOCOL] Message Size: ${messageSize} bytes`);
      
      // 对于大消息，只记录摘要
      if (messageSize > MAX_LOG_SIZE) {
        logger.info(`[CDP-PROTOCOL] Large message detected (${messageSize} bytes), showing summary only`);
        
        // 记录基本信息
        if (message.method) {
          logger.info(`[CDP-PROTOCOL] Method: ${message.method}`);
          if (message.params) {
            const paramKeys = Object.keys(message.params);
            logger.info(`[CDP-PROTOCOL] Parameter keys: ${paramKeys.join(', ')}`);
          }
        }
        
        if (message.result) {
          const resultKeys = Object.keys(message.result);
          logger.info(`[CDP-PROTOCOL] Result keys: ${resultKeys.join(', ')}`);
          // 对于大的结果，显示截断的预览
          const preview = messageStr.substring(0, 200) + '... (truncated)';
          logger.info(`[CDP-PROTOCOL] Preview: ${preview}`);
        }
        
        if (message.error) {
          logger.info(`[CDP-PROTOCOL] Error: ${message.error.code} - ${message.error.message}`);
        }
      } else {
        // 小消息完整记录
        logger.info(`[CDP-PROTOCOL] Full Message: ${JSON.stringify(message, null, 2)}`);
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
      
      // 将 connectionInfo 存储到对应设备的所有连接中
      if (message.deviceId) {
        const connectionInfo: ConnectionInfo = {
          targetInfo: message.targetInfo,
          sessionId: message.sessionId
        };
        
        // 更新所有该设备的连接
        for (const connection of this.cdpConnections.values()) {
          if (connection.deviceId === message.deviceId) {
            connection.connectionInfo = connectionInfo;
          }
        }
      }
      
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
        } else {
          // 更新设备心跳时间
          this.deviceManager.updateDeviceHeartbeat(message.deviceId);
        }
      }
      
      // Send pong response
      if (this.extensionSocket?.readyState === WebSocket.OPEN) {
        const pongMessage = {
          type: 'pong',
          deviceId: message.deviceId,
          timestamp: Date.now()
        };
        try {
          this.extensionSocket.send(JSON.stringify(pongMessage));
          logger.info(`→ Heartbeat pong to device: ${message.deviceId}`);
        } catch (error) {
          logger.error(`Failed to send pong to device ${message.deviceId}:`, error);
        }
      }
      return;
    }

    // CDP event from extension - 发送给对应的连接
    this._logCDPProtocol('←', 'Extension', 'Bridge', message);
    
    // 如果是响应消息(有id)，找到对应的连接
    if (message.id) {
      // 尝试查找所有可能的连接映射
      let targetConnectionId: string | undefined;
      
      // 遍历所有映射，找到匹配的messageId
      for (const [key, mapping] of this.messageToConnection.entries()) {
        const [, msgId] = key.split(':');
        if (msgId === String(message.id)) {
          targetConnectionId = mapping.connectionId;
          this.messageToConnection.delete(key);
          break;
        }
      }
      
      if (targetConnectionId) {
        // 发送给发起请求的连接
        this._sendToPlaywright(message, targetConnectionId);
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
        // Playwright v1.38+ 可能需要更详细的响应
        logger.debug('Handling Browser.setDownloadBehavior locally');
        this._sendToPlaywright({
          id: message.id,
          result: {
            // 返回一个空对象，但确保它是一个有效的 result
          }
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
    // 获取连接的connectionInfo
    let connectionInfo: ConnectionInfo | undefined;
    if (connectionId) {
      const connection = this.cdpConnections.get(connectionId);
      if (connection?.connectionInfo) {
        connectionInfo = connection.connectionInfo;
      }
    }

    switch (message.method) {
      case 'Target.setAutoAttach':
        // Simulate auto-attach behavior with real target info
        // 检查 sessionId 不存在或为空字符串
        const shouldSimulate = connectionInfo && (!message.sessionId || message.sessionId === '');
        
        if (shouldSimulate && connectionInfo) {
          logger.info('Simulating auto-attach for target:', JSON.stringify(message));
          // 先发送 attachedToTarget 事件
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
          // 然后发送响应
          this._sendToPlaywright({
            id: message.id,
            result: {}
          }, connectionId);
        } else {
          // 如果不满足模拟条件，转发到扩展
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
      const key = `${connectionId}:${message.id}`;
      this.messageToConnection.set(key, {
        connectionId,
        timestamp: Date.now()
      });
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
        try {
          deviceSocket.send(JSON.stringify(message));
        } catch (error) {
          logger.error(`Failed to send message to device ${targetDeviceId}:`, error);
          if (message.id) {
            this._sendToPlaywright({
              id: message.id,
              error: { message: `Failed to send to device ${targetDeviceId}: ${error}` }
            }, connectionId);
            // 清理映射
            if (connectionId) {
              const key = `${connectionId}:${message.id}`;
              this.messageToConnection.delete(key);
            }
          }
        }
        return;
      } else {
        logger.info(`Device ${targetDeviceId} not connected, cannot forward message`);
        if (message.id) {
          this._sendToPlaywright({
            id: message.id,
            error: { message: `Device ${targetDeviceId} not connected` }
          }, connectionId);
          // 清理映射
          if (connectionId) {
            const key = `${connectionId}:${message.id}`;
            this.messageToConnection.delete(key);
          }
        }
        return;
      }
    }

    // Fallback to direct extension socket for backward compatibility (single-device mode)
    if (!targetDeviceId && this.extensionSocket?.readyState === WebSocket.OPEN) {
      logger.warn('No deviceId specified, using last connected extension socket (backward compatibility mode)');
      this._logCDPProtocol('→', 'Bridge', 'Extension(fallback)', message);
      try {
        this.extensionSocket.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send message via fallback extension socket:', error);
        if (message.id) {
          this._sendToPlaywright({
            id: message.id,
            error: { message: `Failed to send message: ${error}` }
          }, connectionId);
          // 清理映射
          if (connectionId) {
            const key = `${connectionId}:${message.id}`;
            this.messageToConnection.delete(key);
          }
        }
      }
    } else {
      const errorMsg = targetDeviceId 
        ? `Device ${targetDeviceId} not found in fallback mode` 
        : 'No extension connected and no deviceId specified';
      
      logger.info(errorMsg);
      if (message.id) {
        this._sendToPlaywright({
          id: message.id,
          error: { message: errorMsg }
        }, connectionId);
        // 清理映射
        if (connectionId) {
          const key = `${connectionId}:${message.id}`;
          this.messageToConnection.delete(key);
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
        try {
          connection.socket.send(JSON.stringify(message));
        } catch (error) {
          logger.error(`Failed to send message to Playwright connection ${connectionId}:`, error);
        }
        return;
      }
    }

    // 向后兼容：发送给主连接
    if (this.playwrightSocket?.readyState === WebSocket.OPEN) {
      this._logCDPProtocol('→', 'Bridge', 'Playwright', message);
      try {
        this.playwrightSocket.send(JSON.stringify(message));
      } catch (error) {
        logger.error('Failed to send message to Playwright (fallback):', error);
      }
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
    
    // 停止消息清理定时器
    if (this.messageCleanupInterval) {
      clearInterval(this.messageCleanupInterval);
      this.messageCleanupInterval = null;
    }
    
    // Close all CDP connections
    for (const [connectionId, connection] of this.cdpConnections.entries()) {
      if (connection.socket.readyState === WebSocket.OPEN) {
        logger.info(`Closing CDP connection: ${connectionId}`);
        connection.socket.removeAllListeners();
        connection.socket.close(1000, 'Server shutdown');
      }
    }
    this.cdpConnections.clear();
    
    // Clear message mappings
    this.messageToConnection.clear();
    
    // Close Playwright socket (backward compatibility)
    if (this.playwrightSocket?.readyState === WebSocket.OPEN) {
      this.playwrightSocket.removeAllListeners();
      this.playwrightSocket.close(1000, 'Server shutdown');
      this.playwrightSocket = null;
    }
    
    // Close Extension socket
    if (this.extensionSocket?.readyState === WebSocket.OPEN) {
      this.extensionSocket.removeAllListeners();
      this.extensionSocket.close(1000, 'Server shutdown');
      this.extensionSocket = null;
    }
    
    logger.info('CDP bridge shutdown completed');
  }
}