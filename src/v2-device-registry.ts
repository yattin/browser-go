/**
 * Browser-Go V2 Device Registry
 * Thread-safe device connection management with state machine
 */

import { EventEmitter } from 'events';
import {
  DeviceConnection,
  DeviceInfo,
  ConnectionState,
  ConnectionMetrics,
  IDeviceRegistry,
  DeviceEventHandlers,
  V2Error,
  ErrorType,
  V2Config
} from './v2-types.js';
import { logger } from './logger.js';

export class V2DeviceRegistry extends EventEmitter implements IDeviceRegistry {
  private devices = new Map<string, DeviceConnection>();
  private connectionIndex = new Map<string, string>(); // connectionId -> deviceId
  private stateIndex = new Map<ConnectionState, Set<string>>();
  private lockSet = new Set<string>(); // Simple locking mechanism
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private config: V2Config,
    private handlers: DeviceEventHandlers = {}
  ) {
    super();
    this.initializeStateIndex();
    this.startCleanupTimer();
  }

  private initializeStateIndex(): void {
    for (const state of Object.values(ConnectionState)) {
      this.stateIndex.set(state, new Set());
    }
  }

  private startCleanupTimer(): void {
    this.cleanupInterval = setInterval(() => {
      this.performCleanup().catch(error => {
        logger.error('Cleanup error:', error);
      });
    }, this.config.heartbeatInterval * 2);
  }

  private async acquireLock(deviceId: string): Promise<void> {
    const maxWait = 5000; // 5 seconds max wait
    const start = Date.now();
    
    while (this.lockSet.has(deviceId)) {
      if (Date.now() - start > maxWait) {
        throw new Error(`Lock timeout for device ${deviceId}`);
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    
    this.lockSet.add(deviceId);
  }

  private releaseLock(deviceId: string): void {
    this.lockSet.delete(deviceId);
  }

  async register(device: DeviceConnection): Promise<void> {
    await this.acquireLock(device.deviceId);
    
    try {
      const existingDevice = this.devices.get(device.deviceId);
      
      if (existingDevice) {
        // Handle device ID conflict
        await this.handleDeviceConflict(existingDevice, device);
      }

      // Validate device state
      if (device.state !== ConnectionState.CONNECTING && 
          device.state !== ConnectionState.AUTHENTICATING) {
        throw this.createError(
          ErrorType.STATE_ERROR,
          'INVALID_REGISTRATION_STATE',
          `Invalid state for registration: ${device.state}`,
          device.deviceId
        );
      }

      // Initialize metrics if not present
      if (!device.metrics) {
        device.metrics = this.createInitialMetrics();
      }

      // Register device
      this.devices.set(device.deviceId, device);
      this.connectionIndex.set(device.connectionId, device.deviceId);
      this.updateStateIndex(device.deviceId, ConnectionState.CONNECTING, device.state);

      logger.info(`Device registered: ${device.deviceId} (${device.deviceInfo.name})`);
      
      // Trigger event handlers
      if (this.handlers.onRegister) {
        this.handlers.onRegister(device);
      }
      
      this.emit('deviceRegistered', device);

    } finally {
      this.releaseLock(device.deviceId);
    }
  }

  async unregister(deviceId: string): Promise<void> {
    await this.acquireLock(deviceId);
    
    try {
      const device = this.devices.get(deviceId);
      if (!device) {
        logger.warn(`Attempted to unregister non-existent device: ${deviceId}`);
        return;
      }

      // Update state to disconnecting
      await this.updateState(deviceId, ConnectionState.DISCONNECTING);

      // Clean up indexes
      this.devices.delete(deviceId);
      this.connectionIndex.delete(device.connectionId);
      this.removeFromStateIndex(deviceId, device.state);

      // Close WebSocket if still open
      if (device.websocket.readyState === device.websocket.OPEN) {
        device.websocket.close(1000, 'Device unregistered');
      }

      logger.info(`Device unregistered: ${deviceId}`);
      
      // Trigger event handlers
      if (this.handlers.onDisconnect) {
        this.handlers.onDisconnect(deviceId, 'unregistered');
      }
      
      this.emit('deviceUnregistered', deviceId);

    } finally {
      this.releaseLock(deviceId);
    }
  }

  get(deviceId: string): DeviceConnection | undefined {
    return this.devices.get(deviceId);
  }

  getAll(): DeviceConnection[] {
    return Array.from(this.devices.values());
  }

  getByConnectionId(connectionId: string): DeviceConnection | undefined {
    const deviceId = this.connectionIndex.get(connectionId);
    return deviceId ? this.devices.get(deviceId) : undefined;
  }

  async updateState(deviceId: string, newState: ConnectionState): Promise<void> {
    await this.acquireLock(deviceId);
    
    try {
      const device = this.devices.get(deviceId);
      if (!device) {
        throw this.createError(
          ErrorType.STATE_ERROR,
          'DEVICE_NOT_FOUND',
          `Device not found: ${deviceId}`,
          deviceId
        );
      }

      const oldState = device.state;
      
      // Validate state transition
      if (!this.isValidStateTransition(oldState, newState)) {
        throw this.createError(
          ErrorType.STATE_ERROR,
          'INVALID_STATE_TRANSITION',
          `Invalid state transition: ${oldState} -> ${newState}`,
          deviceId
        );
      }

      // Update state
      device.state = newState;
      device.lastSeen = new Date();
      
      // Update state index
      this.updateStateIndex(deviceId, oldState, newState);

      logger.debug(`Device state updated: ${deviceId} ${oldState} -> ${newState}`);
      
      // Trigger event handlers
      if (this.handlers.onStateChange) {
        this.handlers.onStateChange(deviceId, oldState, newState);
      }
      
      this.emit('stateChanged', deviceId, oldState, newState);

    } finally {
      this.releaseLock(deviceId);
    }
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = new Date();
      device.lastHeartbeat = new Date();
    }
  }

  getByState(state: ConnectionState): DeviceConnection[] {
    const deviceIds = this.stateIndex.get(state) || new Set();
    return Array.from(deviceIds)
      .map(id => this.devices.get(id))
      .filter(device => device !== undefined) as DeviceConnection[];
  }

  async cleanup(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Gracefully disconnect all devices
    const devices = Array.from(this.devices.keys());
    await Promise.all(devices.map(deviceId => this.unregister(deviceId)));
    
    this.devices.clear();
    this.connectionIndex.clear();
    this.stateIndex.clear();
    this.lockSet.clear();
  }

  // Statistics and monitoring
  getStats(): {
    totalDevices: number;
    devicesByState: Record<string, number>;
    averageUptime: number;
    totalMessages: number;
  } {
    const devices = this.getAll();
    const devicesByState: Record<string, number> = {};
    
    for (const state of Object.values(ConnectionState)) {
      devicesByState[state] = this.getByState(state).length;
    }

    const now = Date.now();
    const averageUptime = devices.length > 0 
      ? devices.reduce((sum, device) => sum + (now - device.registeredAt.getTime()), 0) / devices.length
      : 0;

    const totalMessages = devices.reduce((sum, device) => 
      sum + device.metrics.messagesReceived + device.metrics.messagesSent, 0);

    return {
      totalDevices: devices.length,
      devicesByState,
      averageUptime,
      totalMessages
    };
  }

  // Private helper methods
  private async handleDeviceConflict(
    existingDevice: DeviceConnection, 
    newDevice: DeviceConnection
  ): Promise<void> {
    logger.warn(`Device ID conflict detected: ${existingDevice.deviceId}`);
    
    // Close existing connection gracefully
    if (existingDevice.websocket.readyState === existingDevice.websocket.OPEN) {
      existingDevice.websocket.close(1001, 'Device ID conflict - new connection established');
    }
    
    // Remove existing device from indexes
    this.connectionIndex.delete(existingDevice.connectionId);
    this.removeFromStateIndex(existingDevice.deviceId, existingDevice.state);
    
    // Emit conflict event
    this.emit('deviceConflict', existingDevice, newDevice);
  }

  private isValidStateTransition(from: ConnectionState, to: ConnectionState): boolean {
    const validTransitions: Record<ConnectionState, ConnectionState[]> = {
      [ConnectionState.CONNECTING]: [
        ConnectionState.AUTHENTICATING, 
        ConnectionState.ERROR, 
        ConnectionState.CLOSED
      ],
      [ConnectionState.AUTHENTICATING]: [
        ConnectionState.REGISTERED, 
        ConnectionState.ERROR, 
        ConnectionState.CLOSED
      ],
      [ConnectionState.REGISTERED]: [
        ConnectionState.ACTIVE, 
        ConnectionState.DISCONNECTING, 
        ConnectionState.ERROR
      ],
      [ConnectionState.ACTIVE]: [
        ConnectionState.DISCONNECTING, 
        ConnectionState.ERROR, 
        ConnectionState.REGISTERED
      ],
      [ConnectionState.DISCONNECTING]: [
        ConnectionState.CLOSED
      ],
      [ConnectionState.ERROR]: [
        ConnectionState.CONNECTING, 
        ConnectionState.CLOSED, 
        ConnectionState.ACTIVE
      ],
      [ConnectionState.CLOSED]: []
    };

    return validTransitions[from]?.includes(to) || false;
  }

  private updateStateIndex(deviceId: string, oldState: ConnectionState, newState: ConnectionState): void {
    // Remove from old state
    this.stateIndex.get(oldState)?.delete(deviceId);
    
    // Add to new state
    if (!this.stateIndex.has(newState)) {
      this.stateIndex.set(newState, new Set());
    }
    this.stateIndex.get(newState)!.add(deviceId);
  }

  private removeFromStateIndex(deviceId: string, state: ConnectionState): void {
    this.stateIndex.get(state)?.delete(deviceId);
  }

  private createInitialMetrics(): ConnectionMetrics {
    return {
      messagesReceived: 0,
      messagesSent: 0,
      errorsCount: 0,
      averageResponseTime: 0,
      lastResponseTime: 0,
      bytesReceived: 0,
      bytesSent: 0,
      uptime: 0,
      reconnectCount: 0
    };
  }

  private async performCleanup(): Promise<void> {
    const now = Date.now();
    const staleThreshold = this.config.heartbeatInterval * 3; // 3x heartbeat interval
    const devicesToRemove: string[] = [];

    for (const [deviceId, device] of this.devices) {
      const timeSinceLastSeen = now - device.lastSeen.getTime();
      
      if (timeSinceLastSeen > staleThreshold) {
        logger.warn(`Removing stale device: ${deviceId} (last seen ${timeSinceLastSeen}ms ago)`);
        devicesToRemove.push(deviceId);
      }
    }

    // Remove stale devices
    for (const deviceId of devicesToRemove) {
      await this.unregister(deviceId);
    }
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