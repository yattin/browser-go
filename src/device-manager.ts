/**
 * Device Manager for Chrome Extension Device Registration and Routing
 * Manages device registration, connection routing, and device lifecycle
 */

import WebSocket from 'ws';
import { logger } from './logger.js';

interface DeviceInfo {
  name: string;
  version: string;
  userAgent: string;
  timestamp: string;
}

interface RegisteredDevice {
  deviceId: string;
  deviceInfo: DeviceInfo;
  extensionSocket: WebSocket;
  connectionInfo?: {
    sessionId: string;
    targetInfo: any;
  };
  registeredAt: Date;
  lastSeen: Date;
}

export class DeviceManager {
  private devices: Map<string, RegisteredDevice> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up disconnected devices every 30 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanupDisconnectedDevices();
    }, 30000);
  }

  /**
   * Register a new device or update existing device
   */
  registerDevice(
    deviceId: string,
    deviceInfo: DeviceInfo,
    extensionSocket: WebSocket
  ): void {
    logger.info(`Device registering: ${deviceId}`);

    const now = new Date();
    const device: RegisteredDevice = {
      deviceId,
      deviceInfo,
      extensionSocket,
      registeredAt: this.devices.get(deviceId)?.registeredAt || now,
      lastSeen: now,
    };

    // If device was already registered, close old connection
    const existingDevice = this.devices.get(deviceId);
    if (existingDevice && existingDevice.extensionSocket !== extensionSocket) {
      logger.info(`Closing previous connection for device ${deviceId}`);
      if (existingDevice.extensionSocket.readyState === WebSocket.OPEN) {
        existingDevice.extensionSocket.close(1000, 'New connection established');
      }
      // Remove all listeners from old socket to prevent race conditions
      existingDevice.extensionSocket.removeAllListeners();
    }

    this.devices.set(deviceId, device);

    // Set up socket cleanup on close with socket matching to prevent race conditions
    extensionSocket.on('close', () => {
      this.unregisterDevice(deviceId, extensionSocket);
    });

    logger.info(`Device registered successfully: ${deviceId} (${deviceInfo.name})`);
  }

  /**
   * Update device connection info (target info, session ID)
   */
  updateDeviceConnectionInfo(
    deviceId: string,
    connectionInfo: { sessionId: string; targetInfo: any }
  ): void {
    const device = this.devices.get(deviceId);
    if (device) {
      device.connectionInfo = connectionInfo;
      device.lastSeen = new Date();
      logger.info(`Updated connection info for device ${deviceId}`);
    } else {
      logger.warn(`Attempted to update connection info for unknown device: ${deviceId}`);
    }
  }

  /**
   * Get device by ID
   */
  getDevice(deviceId: string): RegisteredDevice | undefined {
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastSeen = new Date();
    }
    return device;
  }

  /**
   * Get extension socket for a device
   */
  getDeviceSocket(deviceId: string): WebSocket | null {
    const device = this.getDevice(deviceId);
    if (device && device.extensionSocket.readyState === WebSocket.OPEN) {
      return device.extensionSocket;
    } else if (device && device.extensionSocket.readyState !== WebSocket.OPEN) {
      // Connection is broken, clean up the device
      logger.info(`Device ${deviceId} connection is broken (state: ${device.extensionSocket.readyState}), cleaning up`);
      this.unregisterDevice(deviceId, device.extensionSocket);
    }
    return null;
  }

  /**
   * Unregister a device
   */
  unregisterDevice(deviceId: string, socketToMatch?: WebSocket): void {
    const device = this.devices.get(deviceId);
    if (device) {
      // If socketToMatch is provided, only unregister if it matches
      // This prevents race conditions where old sockets unregister new devices
      if (socketToMatch && device.extensionSocket !== socketToMatch) {
        logger.debug(`Ignoring unregister for device ${deviceId} - socket mismatch`);
        return;
      }
      
      logger.info(`Device unregistered: ${deviceId}`);
      this.devices.delete(deviceId);
    }
  }

  /**
   * Get all registered devices
   */
  getAllDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * Get device statistics
   */
  getDeviceStats(): {
    totalDevices: number;
    connectedDevices: number;
    devicesWithTargets: number;
  } {
    const total = this.devices.size;
    let connected = 0;
    let withTargets = 0;

    for (const device of this.devices.values()) {
      if (device.extensionSocket.readyState === WebSocket.OPEN) {
        connected++;
        if (device.connectionInfo) {
          withTargets++;
        }
      }
    }

    return {
      totalDevices: total,
      connectedDevices: connected,
      devicesWithTargets: withTargets,
    };
  }

  /**
   * Clean up disconnected devices
   */
  private cleanupDisconnectedDevices(): void {
    const now = new Date();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [deviceId, device] of this.devices.entries()) {
      const isSocketClosed = device.extensionSocket.readyState !== WebSocket.OPEN;
      const isStale = now.getTime() - device.lastSeen.getTime() > staleThreshold;

      if (isSocketClosed || isStale) {
        logger.info(`Cleaning up stale device: ${deviceId} (closed: ${isSocketClosed}, stale: ${isStale})`);
        this.devices.delete(deviceId);
      }
    }
  }

  /**
   * Check if device exists and is connected
   */
  isDeviceConnected(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    return device ? device.extensionSocket.readyState === WebSocket.OPEN : false;
  }

  /**
   * Shutdown device manager
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Close all device connections
    for (const device of this.devices.values()) {
      if (device.extensionSocket.readyState === WebSocket.OPEN) {
        device.extensionSocket.close(1000, 'Server shutdown');
      }
    }

    this.devices.clear();
    logger.info('DeviceManager shutdown completed');
  }
}