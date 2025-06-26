# Browser-Go V2 WebSocket Architecture Design

## Current Problems Analysis

1. **Connection Instability**: Multiple devices disconnect each other during registration
2. **Message Routing Timeout**: Concurrent CDP messages fail to route properly  
3. **State Management Chaos**: Unclear connection states and transitions
4. **Conflict Resolution**: Poor handling of device ID conflicts
5. **Error Recovery**: Inadequate error handling and recovery mechanisms

## New Architecture Design

### 1. Separated Endpoints

#### `/v2/device` - Device Registration & Heartbeat
- **Purpose**: Exclusive for device registration, authentication, and heartbeat
- **Protocol**: Custom JSON-based protocol
- **Features**: 
  - Connection pooling for device management
  - Automatic heartbeat with configurable intervals
  - Graceful conflict resolution
  - Connection state tracking

#### `/v2/cdp/{deviceId}` - CDP Communication
- **Purpose**: Dedicated CDP message routing
- **Protocol**: Standard CDP over WebSocket
- **Features**:
  - Message queuing and retry
  - Request/response correlation
  - Automatic failover
  - Performance monitoring

#### `/v2/control` - Management & Monitoring
- **Purpose**: Administrative operations and real-time monitoring
- **Protocol**: JSON-based control commands
- **Features**:
  - Real-time device status
  - Connection diagnostics
  - Performance metrics
  - Remote control commands

### 2. Connection State Machine

```
CONNECTING ──→ AUTHENTICATING ──→ REGISTERED ──→ ACTIVE ──→ DISCONNECTING
     │              │                │            │            │
     └──ERROR───────ERROR────────────ERROR───────ERROR───────CLOSED
```

**States:**
- `CONNECTING`: Initial WebSocket connection established
- `AUTHENTICATING`: Verifying device credentials and capabilities
- `REGISTERED`: Device successfully registered in system
- `ACTIVE`: Ready for CDP message routing
- `DISCONNECTING`: Graceful shutdown in progress
- `ERROR`: Error state with recovery options
- `CLOSED`: Connection terminated

### 3. Message Routing Architecture

#### Device Registry
```typescript
interface DeviceRegistry {
  deviceId: string;
  connectionId: string;
  state: ConnectionState;
  capabilities: DeviceCapabilities;
  lastSeen: Date;
  messageQueue: PendingMessage[];
  retryCount: number;
}
```

#### Message Router
```typescript
interface MessageRouter {
  routeMessage(deviceId: string, message: CDPMessage): Promise<CDPResponse>;
  queueMessage(deviceId: string, message: CDPMessage): void;
  retryFailedMessages(deviceId: string): void;
  getRouteMetrics(deviceId: string): RouteMetrics;
}
```

### 4. Error Handling Strategy

#### Error Categories
1. **Network Errors**: Connection drops, timeouts
2. **Protocol Errors**: Invalid messages, format issues  
3. **State Errors**: Invalid state transitions
4. **Resource Errors**: Queue full, memory limits
5. **Business Logic Errors**: Device conflicts, authentication failures

#### Recovery Mechanisms
1. **Automatic Retry**: Exponential backoff for transient errors
2. **Circuit Breaker**: Prevent cascade failures
3. **Graceful Degradation**: Continue with reduced functionality
4. **Health Monitoring**: Proactive issue detection

### 5. Performance Optimizations

#### Connection Pooling
- Reuse connections for efficiency
- Load balancing across multiple connections
- Connection health monitoring

#### Message Batching
- Batch non-critical messages
- Priority queuing for critical messages
- Compression for large messages

#### Caching Strategy
- Device capability caching
- Response caching for repetitive queries
- Intelligent cache invalidation

## Implementation Plan

### Phase 1: Core Infrastructure
1. Create new connection state machine
2. Implement device registry with proper locking
3. Build message router with queuing

### Phase 2: Endpoint Implementation  
1. Implement `/v2/device` endpoint
2. Implement `/v2/cdp/{deviceId}` endpoint
3. Implement `/v2/control` endpoint

### Phase 3: Advanced Features
1. Add error recovery mechanisms
2. Implement performance monitoring
3. Add administrative tools

### Phase 4: Migration & Testing
1. Create migration path from v1
2. Comprehensive testing suite
3. Performance benchmarking
4. Production deployment

## Benefits of New Architecture

1. **Stability**: Clear separation of concerns reduces conflicts
2. **Scalability**: Connection pooling and message queuing support high load
3. **Maintainability**: Modular design with clear interfaces
4. **Observability**: Built-in monitoring and diagnostics
5. **Reliability**: Robust error handling and recovery
6. **Performance**: Optimized message routing and caching