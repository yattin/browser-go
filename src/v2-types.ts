/**
 * Browser-Go V2 WebSocket Architecture Types
 * Modern, robust WebSocket implementation for CDP bridge
 */

import { WebSocket } from 'ws';

// Connection State Machine
export enum ConnectionState {
  CONNECTING = 'CONNECTING',
  AUTHENTICATING = 'AUTHENTICATING', 
  REGISTERED = 'REGISTERED',
  ACTIVE = 'ACTIVE',
  DISCONNECTING = 'DISCONNECTING',
  ERROR = 'ERROR',
  CLOSED = 'CLOSED'
}

// Device Capabilities
export interface DeviceCapabilities {
  browserName: string;
  browserVersion: string;
  platform: string;
  userAgent: string;
  supportedDomains: string[];
  maxConcurrentRequests: number;
  features: string[];
}

// Device Information
export interface DeviceInfo {
  deviceId: string;
  name: string;
  version: string;
  type: 'extension' | 'standalone' | 'mobile';
  capabilities: DeviceCapabilities;
  metadata: Record<string, any>;
}

// Connection Registry Entry
export interface DeviceConnection {
  deviceId: string;
  connectionId: string;
  websocket: WebSocket;
  state: ConnectionState;
  deviceInfo: DeviceInfo;
  registeredAt: Date;
  lastSeen: Date;
  lastHeartbeat: Date;
  messageQueue: PendingMessage[];
  retryCount: number;
  errorCount: number;
  metrics: ConnectionMetrics;
}

// Pending Message
export interface PendingMessage {
  id: string;
  deviceId: string;
  method: string;
  params: any;
  timestamp: Date;
  retryCount: number;
  maxRetries: number;
  priority: MessagePriority;
  timeout: number;
  callback?: (error: Error | null, response?: any) => void;
}

// Message Priority
export enum MessagePriority {
  LOW = 1,
  NORMAL = 2, 
  HIGH = 3,
  CRITICAL = 4
}

// CDP Message Types
export interface CDPMessage {
  id?: string | number;
  method: string;
  params?: any;
  sessionId?: string;
}

export interface CDPResponse {
  id?: string | number;
  result?: any;
  error?: CDPError;
  method?: string;
  params?: any;
}

export interface CDPError {
  code: number;
  message: string;
  data?: any;
}

// Connection Metrics
export interface ConnectionMetrics {
  messagesReceived: number;
  messagesSent: number;
  errorsCount: number;
  averageResponseTime: number;
  lastResponseTime: number;
  bytesReceived: number;
  bytesSent: number;
  uptime: number;
  reconnectCount: number;
}

// Route Metrics
export interface RouteMetrics {
  deviceId: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatency: number;
  queueSize: number;
  lastRequestTime: Date;
}

// Error Types
export enum ErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  PROTOCOL_ERROR = 'PROTOCOL_ERROR',
  STATE_ERROR = 'STATE_ERROR',
  RESOURCE_ERROR = 'RESOURCE_ERROR',
  BUSINESS_ERROR = 'BUSINESS_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR'
}

export interface V2Error extends Error {
  type: ErrorType;
  code: string;
  deviceId?: string;
  connectionId?: string;
  recoverable: boolean;
  retryAfter?: number;
  context?: Record<string, any>;
}

// WebSocket Message Types
export enum MessageType {
  // Device Registration Messages
  DEVICE_REGISTER = 'device:register',
  DEVICE_REGISTER_ACK = 'device:register:ack',
  DEVICE_HEARTBEAT = 'device:heartbeat',
  DEVICE_HEARTBEAT_ACK = 'device:heartbeat:ack',
  DEVICE_DISCONNECT = 'device:disconnect',
  
  // CDP Messages
  CDP_REQUEST = 'cdp:request',
  CDP_RESPONSE = 'cdp:response',
  CDP_EVENT = 'cdp:event',
  
  // Control Messages
  CONTROL_STATUS = 'control:status',
  CONTROL_METRICS = 'control:metrics',
  CONTROL_COMMAND = 'control:command',
  
  // Error Messages
  ERROR = 'error'
}

export interface V2Message {
  type: MessageType;
  id?: string;
  timestamp: Date;
  data: any;
  metadata?: Record<string, any>;
}

// Configuration
export interface V2Config {
  // Connection settings
  heartbeatInterval: number;
  connectionTimeout: number;
  messageTimeout: number;
  
  // Queue settings
  maxQueueSize: number;
  maxRetries: number;
  retryDelay: number;
  
  // Performance settings
  maxConcurrentConnections: number;
  maxConcurrentMessages: number;
  
  // Monitoring settings
  metricsInterval: number;
  enableDetailedLogging: boolean;
}

// Event Handlers
export interface DeviceEventHandlers {
  onRegister?: (device: DeviceConnection) => void;
  onDisconnect?: (deviceId: string, reason: string) => void;
  onError?: (deviceId: string, error: V2Error) => void;
  onStateChange?: (deviceId: string, oldState: ConnectionState, newState: ConnectionState) => void;
  onMessage?: (deviceId: string, message: V2Message) => void;
}

export interface CDPEventHandlers {
  onRequest?: (deviceId: string, request: CDPMessage) => void;
  onResponse?: (deviceId: string, response: CDPResponse) => void;
  onEvent?: (deviceId: string, event: CDPMessage) => void;
  onTimeout?: (deviceId: string, messageId: string) => void;
}

// Registry Interfaces
export interface IDeviceRegistry {
  register(device: DeviceConnection): Promise<void>;
  unregister(deviceId: string): Promise<void>;
  get(deviceId: string): DeviceConnection | undefined;
  getAll(): DeviceConnection[];
  updateState(deviceId: string, state: ConnectionState): Promise<void>;
  updateLastSeen(deviceId: string): Promise<void>;
  getByState(state: ConnectionState): DeviceConnection[];
  cleanup(): Promise<void>;
}

export interface IMessageRouter {
  route(deviceId: string, message: CDPMessage): Promise<CDPResponse>;
  queue(message: PendingMessage): Promise<void>;
  dequeue(deviceId: string): PendingMessage | undefined;
  retry(deviceId: string, messageId: string): Promise<void>;
  getMetrics(deviceId: string): RouteMetrics;
  getQueueSize(deviceId: string): number;
}

export interface IConnectionManager {
  createConnection(ws: WebSocket, endpoint: string): Promise<string>;
  destroyConnection(connectionId: string): Promise<void>;
  getConnection(connectionId: string): DeviceConnection | undefined;
  getConnectionByDevice(deviceId: string): DeviceConnection | undefined;
  handleMessage(connectionId: string, message: V2Message): Promise<void>;
  sendMessage(connectionId: string, message: V2Message): Promise<void>;
  broadcast(message: V2Message, filter?: (conn: DeviceConnection) => boolean): Promise<void>;
}

// Health Check
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: Date;
  version: string;
  uptime: number;
  connections: {
    total: number;
    active: number;
    errors: number;
  };
  performance: {
    averageResponseTime: number;
    messagesPerSecond: number;
    errorRate: number;
  };
  resources: {
    memoryUsage: number;
    queueSize: number;
    connectionPoolSize: number;
  };
}