/**
 * Browser-Go V2 Message Router
 * Intelligent CDP message routing with queuing, retry, and performance monitoring
 */

import { EventEmitter } from 'events';
import {
  CDPMessage,
  CDPResponse,
  PendingMessage,
  MessagePriority,
  RouteMetrics,
  IMessageRouter,
  IDeviceRegistry,
  ConnectionState,
  V2Error,
  ErrorType,
  V2Config,
  CDPEventHandlers
} from './v2-types.js';
import { logger } from './logger.js';

interface PendingMessageMap {
  [messageId: string]: {
    message: PendingMessage;
    timer: NodeJS.Timeout;
    resolve: (response: CDPResponse) => void;
    reject: (error: Error) => void;
  };
}

export class V2MessageRouter extends EventEmitter implements IMessageRouter {
  private pendingMessages = new Map<string, PendingMessageMap>(); // deviceId -> messages
  private routeMetrics = new Map<string, RouteMetrics>();
  private messageQueue = new Map<string, PendingMessage[]>(); // deviceId -> queue
  private processTimer: NodeJS.Timeout | null = null;

  constructor(
    private deviceRegistry: IDeviceRegistry,
    private config: V2Config,
    private handlers: CDPEventHandlers = {}
  ) {
    super();
    this.startMessageProcessor();
  }

  async route(deviceId: string, message: CDPMessage): Promise<CDPResponse> {
    const device = this.deviceRegistry.get(deviceId);
    
    if (!device) {
      throw this.createError(
        ErrorType.BUSINESS_ERROR,
        'DEVICE_NOT_FOUND',
        `Device not found: ${deviceId}`,
        deviceId
      );
    }

    if (device.state !== ConnectionState.ACTIVE) {
      throw this.createError(
        ErrorType.STATE_ERROR,
        'DEVICE_NOT_ACTIVE',
        `Device not in active state: ${device.state}`,
        deviceId
      );
    }

    // Create pending message
    const messageId = this.generateMessageId();
    const pendingMessage: PendingMessage = {
      id: messageId,
      deviceId,
      method: message.method,
      params: message.params,
      timestamp: new Date(),
      retryCount: 0,
      maxRetries: this.config.maxRetries,
      priority: this.getMessagePriority(message.method),
      timeout: this.config.messageTimeout
    };

    // Update message with generated ID
    const routeMessage: CDPMessage = {
      ...message,
      id: messageId
    };

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Create timeout timer
      const timer = setTimeout(() => {
        this.handleTimeout(deviceId, messageId);
        reject(this.createError(
          ErrorType.TIMEOUT_ERROR,
          'MESSAGE_TIMEOUT',
          `Message timeout after ${this.config.messageTimeout}ms`,
          deviceId
        ));
      }, this.config.messageTimeout);

      // Store pending message
      if (!this.pendingMessages.has(deviceId)) {
        this.pendingMessages.set(deviceId, {});
      }
      
      this.pendingMessages.get(deviceId)![messageId] = {
        message: pendingMessage,
        timer,
        resolve: (response: CDPResponse) => {
          const responseTime = Date.now() - startTime;
          this.updateMetrics(deviceId, true, responseTime);
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error: Error) => {
          this.updateMetrics(deviceId, false, Date.now() - startTime);
          clearTimeout(timer);
          reject(error);
        }
      };

      // Send message immediately or queue it
      this.sendMessageToDevice(deviceId, routeMessage).catch(error => {
        logger.error(`Failed to send message to device ${deviceId}:`, error);
        
        // Queue message for retry
        pendingMessage.callback = (err, response) => {
          if (err) {
            this.pendingMessages.get(deviceId)?.[messageId]?.reject(err);
          } else if (response) {
            this.pendingMessages.get(deviceId)?.[messageId]?.resolve(response);
          }
        };
        
        this.queue(pendingMessage);
      });

      // Trigger event handler
      if (this.handlers.onRequest) {
        this.handlers.onRequest(deviceId, routeMessage);
      }
    });
  }

  async queue(message: PendingMessage): Promise<void> {
    if (!this.messageQueue.has(message.deviceId)) {
      this.messageQueue.set(message.deviceId, []);
    }

    const queue = this.messageQueue.get(message.deviceId)!;
    
    // Check queue size limit
    if (queue.length >= this.config.maxQueueSize) {
      throw this.createError(
        ErrorType.RESOURCE_ERROR,
        'QUEUE_FULL',
        `Message queue full for device ${message.deviceId}`,
        message.deviceId
      );
    }

    // Insert message based on priority
    this.insertByPriority(queue, message);
    
    logger.debug(`Message queued for device ${message.deviceId}: ${message.method}`);
    this.emit('messageQueued', message);
  }

  dequeue(deviceId: string): PendingMessage | undefined {
    const queue = this.messageQueue.get(deviceId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    const message = queue.shift();
    if (message) {
      logger.debug(`Message dequeued for device ${deviceId}: ${message.method}`);
      this.emit('messageDequeued', message);
    }
    
    return message;
  }

  async retry(deviceId: string, messageId: string): Promise<void> {
    const pendingMessage = this.pendingMessages.get(deviceId)?.[messageId];
    if (!pendingMessage) {
      logger.warn(`Cannot retry - message not found: ${deviceId}/${messageId}`);
      return;
    }

    const message = pendingMessage.message;
    
    if (message.retryCount >= message.maxRetries) {
      pendingMessage.reject(this.createError(
        ErrorType.TIMEOUT_ERROR,
        'MAX_RETRIES_EXCEEDED',
        `Max retries exceeded for message ${messageId}`,
        deviceId
      ));
      return;
    }

    message.retryCount++;
    message.timestamp = new Date();
    
    // Calculate exponential backoff delay
    const delay = Math.min(
      this.config.retryDelay * Math.pow(2, message.retryCount - 1),
      30000 // Max 30 seconds
    );

    setTimeout(async () => {
      try {
        await this.sendMessageToDevice(deviceId, {
          id: messageId,
          method: message.method,
          params: message.params
        });
        logger.debug(`Message retried (${message.retryCount}/${message.maxRetries}): ${deviceId}/${messageId}`);
      } catch (error) {
        logger.error(`Retry failed for message ${deviceId}/${messageId}:`, error);
        this.retry(deviceId, messageId); // Retry again
      }
    }, delay);
  }

  handleResponse(deviceId: string, response: CDPResponse): void {
    const messageId = String(response.id);
    logger.info(`Handling response for device: ${deviceId}, messageId: ${messageId}`);
    const pendingMessage = this.pendingMessages.get(deviceId)?.[messageId];
    
    if (!pendingMessage) {
      logger.warn(`Received response for unknown message: ${deviceId}/${messageId}`);
      logger.info(`Available pending messages for device ${deviceId}:`, Object.keys(this.pendingMessages.get(deviceId) || {}));
      return;
    }

    // Clear pending message
    delete this.pendingMessages.get(deviceId)![messageId];
    
    // Resolve the promise
    if (response.error) {
      pendingMessage.reject(new Error(`CDP Error: ${response.error.message}`));
    } else {
      pendingMessage.resolve(response);
    }

    // Trigger event handler
    if (this.handlers.onResponse) {
      this.handlers.onResponse(deviceId, response);
    }

    logger.debug(`Response handled for ${deviceId}/${messageId}`);
  }

  handleEvent(deviceId: string, event: CDPMessage): void {
    // CDP events don't have responses, just emit them
    if (this.handlers.onEvent) {
      this.handlers.onEvent(deviceId, event);
    }
    
    this.emit('cdpEvent', deviceId, event);
    logger.debug(`CDP event received from ${deviceId}: ${event.method}`);
  }

  getMetrics(deviceId: string): RouteMetrics {
    let metrics = this.routeMetrics.get(deviceId);
    
    if (!metrics) {
      metrics = {
        deviceId,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: 0,
        queueSize: this.getQueueSize(deviceId),
        lastRequestTime: new Date(0)
      };
      this.routeMetrics.set(deviceId, metrics);
    }
    
    // Update queue size
    metrics.queueSize = this.getQueueSize(deviceId);
    
    return metrics;
  }

  getQueueSize(deviceId: string): number {
    return this.messageQueue.get(deviceId)?.length || 0;
  }

  getAllMetrics(): RouteMetrics[] {
    return Array.from(this.routeMetrics.values());
  }

  cleanup(): void {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }

    // Clear all pending messages with timeout errors
    for (const [deviceId, messages] of this.pendingMessages) {
      for (const [messageId, pending] of Object.entries(messages)) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Router cleanup - message cancelled'));
      }
    }

    this.pendingMessages.clear();
    this.routeMetrics.clear();
    this.messageQueue.clear();
  }

  // Private helper methods
  private startMessageProcessor(): void {
    this.processTimer = setInterval(() => {
      this.processMessageQueues();
    }, 100); // Process every 100ms
  }

  private async processMessageQueues(): Promise<void> {
    for (const [deviceId] of this.messageQueue) {
      const device = this.deviceRegistry.get(deviceId);
      
      if (!device || device.state !== ConnectionState.ACTIVE) {
        continue;
      }

      const message = this.dequeue(deviceId);
      if (!message) {
        continue;
      }

      try {
        await this.sendMessageToDevice(deviceId, {
          id: message.id,
          method: message.method,
          params: message.params
        });

        // Call callback if present
        if (message.callback) {
          // Wait for response or timeout
          // This is handled by the pending message system
        }
      } catch (error) {
        logger.error(`Failed to process queued message for ${deviceId}:`, error);
        
        // Re-queue message for retry
        if (message.retryCount < message.maxRetries) {
          message.retryCount++;
          await this.queue(message);
        } else if (message.callback) {
          message.callback(error as Error);
        }
      }
    }
  }

  private async sendMessageToDevice(deviceId: string, message: CDPMessage): Promise<void> {
    const device = this.deviceRegistry.get(deviceId);
    
    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    if (device.websocket.readyState !== device.websocket.OPEN) {
      throw new Error(`Device WebSocket not open: ${deviceId}`);
    }

    const messageString = JSON.stringify(message);
    device.websocket.send(messageString);
    
    // Update metrics
    device.metrics.messagesSent++;
    device.metrics.bytesSent += messageString.length;
    
    await this.deviceRegistry.updateLastSeen(deviceId);
  }

  private handleTimeout(deviceId: string, messageId: string): void {
    const pendingMessage = this.pendingMessages.get(deviceId)?.[messageId];
    if (pendingMessage) {
      delete this.pendingMessages.get(deviceId)![messageId];
      
      // Trigger timeout handler
      if (this.handlers.onTimeout) {
        this.handlers.onTimeout(deviceId, messageId);
      }
      
      logger.warn(`Message timeout: ${deviceId}/${messageId}`);
    }
  }

  private updateMetrics(deviceId: string, success: boolean, responseTime: number): void {
    let metrics = this.routeMetrics.get(deviceId);
    
    if (!metrics) {
      metrics = {
        deviceId,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: 0,
        queueSize: 0,
        lastRequestTime: new Date()
      };
      this.routeMetrics.set(deviceId, metrics);
    }

    metrics.totalRequests++;
    metrics.lastRequestTime = new Date();
    
    if (success) {
      metrics.successfulRequests++;
    } else {
      metrics.failedRequests++;
    }

    // Update average latency (exponential moving average)
    const alpha = 0.1; // Smoothing factor
    metrics.averageLatency = metrics.averageLatency * (1 - alpha) + responseTime * alpha;
  }

  private getMessagePriority(method: string): MessagePriority {
    // Define priority based on CDP method
    const highPriorityMethods = [
      'Runtime.evaluate',
      'Page.navigate',
      'Target.activateTarget'
    ];
    
    const lowPriorityMethods = [
      'Log.enable',
      'Runtime.enable',
      'Page.enable'
    ];

    if (highPriorityMethods.includes(method)) {
      return MessagePriority.HIGH;
    } else if (lowPriorityMethods.includes(method)) {
      return MessagePriority.LOW;
    } else {
      return MessagePriority.NORMAL;
    }
  }

  private insertByPriority(queue: PendingMessage[], message: PendingMessage): void {
    // Insert message in priority order (highest priority first)
    let insertIndex = queue.length;
    
    for (let i = 0; i < queue.length; i++) {
      if (message.priority > queue[i].priority) {
        insertIndex = i;
        break;
      }
    }
    
    queue.splice(insertIndex, 0, message);
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  private createError(
    type: ErrorType,
    code: string,
    message: string,
    deviceId?: string,
    recoverable: boolean = false
  ): V2Error {
    const error = new Error(message) as V2Error;
    error.type = type;
    error.code = code;
    error.deviceId = deviceId;
    error.recoverable = recoverable;
    return error;
  }
}