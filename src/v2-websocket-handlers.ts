/**
 * Browser-Go V2 WebSocket Handlers
 * Modern WebSocket endpoint handlers with clear separation of concerns
 */

import { WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import {
  DeviceConnection,
  DeviceInfo,
  DeviceCapabilities,
  ConnectionState,
  V2Message,
  MessageType,
  CDPMessage,
  CDPResponse,
  V2Error,
  ErrorType,
  V2Config,
  HealthStatus
} from './v2-types.js';
import { V2DeviceRegistry } from './v2-device-registry.js';
import { V2MessageRouter } from './v2-message-router.js';
import { logger } from './logger.js';

export class V2WebSocketHandlers {
  private connectionCounter = 0;

  constructor(
    private deviceRegistry: V2DeviceRegistry,
    private messageRouter: V2MessageRouter,
    private config: V2Config
  ) {}

  /**
   * Handle /v2/device endpoint - Device registration and heartbeat
   */
  async handleDeviceEndpoint(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const connectionId = this.generateConnectionId();
    logger.info(`New device connection: ${connectionId}`);

    let deviceConnection: DeviceConnection | undefined;

    // Set up connection handlers
    ws.on('message', async (data: Buffer) => {
      try {
        const message = this.parseMessage(data);
        await this.handleDeviceMessage(ws, connectionId, message);
      } catch (error) {
        logger.error(`Device message error (${connectionId}):`, error);
        this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message', connectionId);
      }
    });

    ws.on('close', async (code: number, reason: Buffer) => {
      logger.info(`Device connection closed: ${connectionId} (${code}: ${reason.toString()})`);
      if (deviceConnection) {
        await this.deviceRegistry.unregister(deviceConnection.deviceId);
      }
    });

    ws.on('error', (error: Error) => {
      logger.error(`Device connection error (${connectionId}):`, error);
      if (deviceConnection) {
        this.deviceRegistry.unregister(deviceConnection.deviceId).catch(err => {
          logger.error(`Failed to unregister device after error:`, err);
        });
      }
    });

    // Send welcome message
    this.sendMessage(ws, {
      type: MessageType.DEVICE_REGISTER,
      timestamp: new Date(),
      data: {
        connectionId,
        serverVersion: '2.0.0',
        config: {
          heartbeatInterval: this.config.heartbeatInterval,
          messageTimeout: this.config.messageTimeout
        }
      }
    });
  }

  /**
   * Handle /v2/cdp/{deviceId} endpoint - CDP communication
   */
  async handleCDPEndpoint(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const deviceId = url.pathname.split('/').pop();

    if (!deviceId) {
      ws.close(4000, 'Missing device ID in URL');
      return;
    }

    const device = this.deviceRegistry.get(deviceId);
    if (!device) {
      ws.close(4001, `Device not found: ${deviceId}`);
      return;
    }

    if (device.state !== ConnectionState.ACTIVE) {
      ws.close(4002, `Device not active: ${device.state}`);
      return;
    }

    logger.info(`CDP connection established for device: ${deviceId}`);

    // Check if this is a direct client connection (not from the device itself)
    const isDirectClientConnection = ws !== device.websocket;
    
    if (isDirectClientConnection) {
      logger.info(`Direct client CDP connection for device: ${deviceId}`);
      
      // For direct client connections, we route messages through the device's websocket
      ws.on('message', async (data: Buffer) => {
        try {
          const cdpMessage: CDPMessage = JSON.parse(data.toString());
          logger.info(`Direct client sending CDP message: ${cdpMessage.method} with ID: ${cdpMessage.id}`);
          
          // Forward message directly to device websocket
          if (device.websocket.readyState === device.websocket.OPEN) {
            device.websocket.send(data.toString());
            logger.info(`Forwarded message to device websocket`);
          } else {
            logger.warn(`Device websocket not open, cannot forward message`);
            this.sendCDPError(ws, cdpMessage.id || -1, 'DEVICE_UNAVAILABLE', 'Device WebSocket not available');
          }
        } catch (error) {
          logger.error(`Direct client CDP message error (${deviceId}):`, error);
          this.sendCDPError(ws, -1, 'PARSE_ERROR', 'Failed to parse CDP message');
        }
      });
      
      // Listen for responses from device websocket and forward to client
      const responseHandler = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          // Only forward actual CDP responses (not V2 control messages or heartbeats)
          if (response.id && 
              ws.readyState === ws.OPEN && 
              !response.type && // V2 messages have 'type' field, CDP responses don't
              (response.result !== undefined || response.error !== undefined)) {
            logger.info(`Forwarding CDP response for ID: ${response.id} to client`);
            ws.send(data.toString());
          } else if (response.id && !response.type) {
            logger.debug(`Ignoring non-CDP message with ID: ${response.id}`);
          }
        } catch (error) {
          logger.error(`Error forwarding device response:`, error);
        }
      };
      
      device.websocket.on('message', responseHandler);
      
      // Clean up listener when client disconnects
      ws.on('close', () => {
        device.websocket.removeListener('message', responseHandler);
        logger.info(`Direct client disconnected from device: ${deviceId}`);
      });
      
    } else {
      // This is the device's own connection, handle normally
      ws.on('message', async (data: Buffer) => {
        try {
          const cdpMessage: CDPMessage = JSON.parse(data.toString());
          await this.handleCDPMessage(ws, deviceId, cdpMessage);
        } catch (error) {
          logger.error(`CDP message error (${deviceId}):`, error);
          this.sendCDPError(ws, -1, 'PARSE_ERROR', 'Failed to parse CDP message');
        }
      });
    }

    ws.on('close', (code: number, reason: Buffer) => {
      logger.info(`CDP connection closed for device: ${deviceId} (${code}: ${reason.toString()})`);
    });

    ws.on('error', (error: Error) => {
      logger.error(`CDP connection error (${deviceId}):`, error);
    });
  }

  /**
   * Handle /v2/control endpoint - Management and monitoring
   */
  async handleControlEndpoint(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const connectionId = this.generateConnectionId();
    logger.info(`Control connection established: ${connectionId}`);

    // Set up control message handlers
    ws.on('message', async (data: Buffer) => {
      try {
        const message = this.parseMessage(data);
        await this.handleControlMessage(ws, connectionId, message);
      } catch (error) {
        logger.error(`Control message error (${connectionId}):`, error);
        this.sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message', connectionId);
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      logger.info(`Control connection closed: ${connectionId} (${code}: ${reason.toString()})`);
    });

    ws.on('error', (error: Error) => {
      logger.error(`Control connection error (${connectionId}):`, error);
    });

    // Send initial status
    this.sendMessage(ws, {
      type: MessageType.CONTROL_STATUS,
      timestamp: new Date(),
      data: await this.getHealthStatus()
    });
  }

  // Private message handlers
  private async handleDeviceMessage(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    switch (message.type) {
      case MessageType.DEVICE_REGISTER:
        await this.handleDeviceRegistration(ws, connectionId, message);
        break;
        
      case MessageType.DEVICE_HEARTBEAT:
        await this.handleDeviceHeartbeat(ws, connectionId, message);
        break;
        
      case MessageType.DEVICE_DISCONNECT:
        await this.handleDeviceDisconnect(ws, connectionId, message);
        break;
        
      default:
        this.sendError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`, connectionId);
    }
  }

  private async handleDeviceRegistration(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    const { deviceInfo } = message.data as { deviceInfo: DeviceInfo };
    
    if (!deviceInfo || !deviceInfo.deviceId) {
      this.sendError(ws, 'INVALID_DEVICE_INFO', 'Missing device information', connectionId);
      return;
    }

    try {
      // Create device connection
      const deviceConnection: DeviceConnection = {
        deviceId: deviceInfo.deviceId,
        connectionId,
        websocket: ws,
        state: ConnectionState.AUTHENTICATING,
        deviceInfo,
        registeredAt: new Date(),
        lastSeen: new Date(),
        lastHeartbeat: new Date(),
        messageQueue: [],
        retryCount: 0,
        errorCount: 0,
        metrics: {
          messagesReceived: 0,
          messagesSent: 0,
          errorsCount: 0,
          averageResponseTime: 0,
          lastResponseTime: 0,
          bytesReceived: 0,
          bytesSent: 0,
          uptime: 0,
          reconnectCount: 0
        }
      };

      // Register device
      await this.deviceRegistry.register(deviceConnection);
      
      // Move to registered state
      await this.deviceRegistry.updateState(deviceInfo.deviceId, ConnectionState.REGISTERED);
      
      // Move to active state if capabilities are valid
      if (this.validateDeviceCapabilities(deviceInfo.capabilities)) {
        await this.deviceRegistry.updateState(deviceInfo.deviceId, ConnectionState.ACTIVE);
      }

      // Send acknowledgment
      this.sendMessage(ws, {
        type: MessageType.DEVICE_REGISTER_ACK,
        id: message.id,
        timestamp: new Date(),
        data: {
          deviceId: deviceInfo.deviceId,
          state: ConnectionState.ACTIVE,
          heartbeatInterval: this.config.heartbeatInterval
        }
      });

      logger.info(`Device registered successfully: ${deviceInfo.deviceId}`);

    } catch (error) {
      logger.error(`Device registration failed:`, error);
      this.sendError(ws, 'REGISTRATION_FAILED', (error as Error).message, connectionId);
    }
  }

  private async handleDeviceHeartbeat(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    const device = this.deviceRegistry.getByConnectionId(connectionId);
    
    if (!device) {
      this.sendError(ws, 'DEVICE_NOT_FOUND', 'Device not registered', connectionId);
      return;
    }

    // Update last seen
    await this.deviceRegistry.updateLastSeen(device.deviceId);

    // Send heartbeat acknowledgment
    this.sendMessage(ws, {
      type: MessageType.DEVICE_HEARTBEAT_ACK,
      id: message.id,
      timestamp: new Date(),
      data: {
        deviceId: device.deviceId,
        serverTime: new Date(),
        status: 'ok'
      }
    });
  }

  private async handleDeviceDisconnect(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    const device = this.deviceRegistry.getByConnectionId(connectionId);
    
    if (device) {
      await this.deviceRegistry.unregister(device.deviceId);
    }

    ws.close(1000, 'Device disconnect requested');
  }

  private async handleCDPMessage(
    ws: WebSocket, 
    deviceId: string, 
    message: CDPMessage
  ): Promise<void> {
    try {
      if (message.id && message.method) {
        // This is a CDP request
        logger.info(`Processing CDP request: ${message.method} with ID: ${message.id} for device: ${deviceId}`);
        const response = await this.messageRouter.route(deviceId, message);
        logger.info(`Received response for ${message.method} with ID: ${message.id}`);
        
        const cdpResponse: CDPResponse = {
          id: message.id,
          result: response.result,
          error: response.error
        };
        
        logger.info(`Sending CDP response back to client for ID: ${message.id}`);
        ws.send(JSON.stringify(cdpResponse));
      } else if (message.method) {
        // This is a CDP event
        this.messageRouter.handleEvent(deviceId, message);
      } else if (message.id) {
        // This is a CDP response
        this.messageRouter.handleResponse(deviceId, message as CDPResponse);
      }
    } catch (error) {
      logger.error(`CDP message handling error:`, error);
      this.sendCDPError(ws, message.id || -1, 'INTERNAL_ERROR', (error as Error).message);
    }
  }

  private async handleControlMessage(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    switch (message.type) {
      case MessageType.CONTROL_STATUS:
        this.sendMessage(ws, {
          type: MessageType.CONTROL_STATUS,
          timestamp: new Date(),
          data: await this.getHealthStatus()
        });
        break;
        
      case MessageType.CONTROL_METRICS:
        this.sendMessage(ws, {
          type: MessageType.CONTROL_METRICS,
          timestamp: new Date(),
          data: {
            deviceStats: this.deviceRegistry.getStats(),
            routeMetrics: this.messageRouter.getAllMetrics()
          }
        });
        break;
        
      case MessageType.CONTROL_COMMAND:
        await this.handleControlCommand(ws, connectionId, message);
        break;
        
      default:
        this.sendError(ws, 'UNKNOWN_CONTROL_MESSAGE', `Unknown control message: ${message.type}`, connectionId);
    }
  }

  private async handleControlCommand(
    ws: WebSocket, 
    connectionId: string, 
    message: V2Message
  ): Promise<void> {
    const { command, params } = message.data;
    
    try {
      let result: any;
      
      switch (command) {
        case 'listDevices':
          result = this.deviceRegistry.getAll().map(device => ({
            deviceId: device.deviceId,
            state: device.state,
            deviceInfo: device.deviceInfo,
            lastSeen: device.lastSeen,
            metrics: device.metrics
          }));
          break;
          
        case 'disconnectDevice':
          if (params.deviceId) {
            await this.deviceRegistry.unregister(params.deviceId);
            result = { success: true, deviceId: params.deviceId };
          } else {
            throw new Error('Missing deviceId parameter');
          }
          break;
          
        case 'getDeviceMetrics':
          if (params.deviceId) {
            result = this.messageRouter.getMetrics(params.deviceId);
          } else {
            throw new Error('Missing deviceId parameter');
          }
          break;
          
        default:
          throw new Error(`Unknown command: ${command}`);
      }
      
      this.sendMessage(ws, {
        type: MessageType.CONTROL_COMMAND,
        id: message.id,
        timestamp: new Date(),
        data: { success: true, result }
      });
      
    } catch (error) {
      this.sendMessage(ws, {
        type: MessageType.ERROR,
        id: message.id,
        timestamp: new Date(),
        data: {
          error: 'COMMAND_FAILED',
          message: (error as Error).message
        }
      });
    }
  }

  // Utility methods
  private parseMessage(data: Buffer): V2Message {
    const messageStr = data.toString();
    const parsed = JSON.parse(messageStr);
    
    if (!parsed.type || !parsed.timestamp) {
      throw new Error('Invalid message format');
    }
    
    return {
      type: parsed.type,
      id: parsed.id,
      timestamp: new Date(parsed.timestamp),
      data: parsed.data,
      metadata: parsed.metadata
    };
  }

  private sendMessage(ws: WebSocket, message: V2Message): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, code: string, message: string, connectionId?: string): void {
    this.sendMessage(ws, {
      type: MessageType.ERROR,
      timestamp: new Date(),
      data: {
        error: code,
        message,
        connectionId
      }
    });
  }

  private sendCDPError(ws: WebSocket, id: string | number, code: string, message: string): void {
    const response: CDPResponse = {
      id,
      error: {
        code: -32000,
        message: `${code}: ${message}`
      }
    };
    
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(response));
    }
  }

  private validateDeviceCapabilities(capabilities: DeviceCapabilities): boolean {
    return !!(
      capabilities.browserName &&
      capabilities.browserVersion &&
      capabilities.platform &&
      capabilities.userAgent &&
      Array.isArray(capabilities.supportedDomains) &&
      typeof capabilities.maxConcurrentRequests === 'number'
    );
  }

  private generateConnectionId(): string {
    return `conn_${++this.connectionCounter}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private async getHealthStatus(): Promise<HealthStatus> {
    const deviceStats = this.deviceRegistry.getStats();
    const startTime = Date.now() - process.uptime() * 1000;
    
    return {
      status: 'healthy',
      timestamp: new Date(),
      version: '2.0.0',
      uptime: process.uptime(),
      connections: {
        total: deviceStats.totalDevices,
        active: deviceStats.devicesByState[ConnectionState.ACTIVE] || 0,
        errors: deviceStats.devicesByState[ConnectionState.ERROR] || 0
      },
      performance: {
        averageResponseTime: deviceStats.averageUptime / 1000, // Convert to seconds
        messagesPerSecond: deviceStats.totalMessages / process.uptime(),
        errorRate: (deviceStats.devicesByState[ConnectionState.ERROR] || 0) / Math.max(deviceStats.totalDevices, 1)
      },
      resources: {
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
        queueSize: this.messageRouter.getAllMetrics().reduce((sum, metrics) => sum + metrics.queueSize, 0),
        connectionPoolSize: deviceStats.totalDevices
      }
    };
  }
}