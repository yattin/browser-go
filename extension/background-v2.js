/**
 * V2 Enhanced Chrome Extension for Browser-Go
 * Supports both V1 and V2 WebSocket architectures
 * Auto-detects server capabilities and uses appropriate endpoints
 */

function debugLog(...args) {
  const enabled = true;
  if (enabled) {
    console.log('[Extension V2]', ...args);
  }
}

class TabShareExtensionV2 {
  constructor() {
    this.currentConnection = null;
    this.currentTabId = null;
    this.autoConnectEnabled = true;
    this.defaultBridgeUrl = 'ws://localhost:3000'; // Base URL, endpoints will be added
    this.deviceId = null;
    this.isAttached = false;
    this.reconnectAttempts = 0;
    this.connectionState = 'disconnected';
    
    // V2 specific properties
    this.isV2Server = false; // Auto-detected
    this.deviceConnection = null; // Separate connection for device registration/heartbeat
    this.cdpConnection = null; // Connection for CDP communication
    this.heartbeatInterval = null;
    this.serverVersion = null;
    
    // Guardian timer for connection health monitoring
    this.guardianTimer = null;
    this.guardianInterval = 10000;
    this.lastHeartbeat = null;

    // Event listeners
    chrome.tabs.onActivated.addListener(this.onTabActivated.bind(this));
    chrome.tabs.onUpdated.addListener(this.onTabUpdated.bind(this));
    chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));
    chrome.runtime.onStartup.addListener(this.onExtensionStartup.bind(this));
    chrome.runtime.onInstalled.addListener(this.onExtensionInstalled.bind(this));
    chrome.runtime.onMessage.addListener(this.onMessage.bind(this));

    // Initialize
    this.initDevice().then(() => {
      this.startGuardianTimer();
      if (this.autoConnectEnabled) {
        this.initAutoConnect();
      }
    });
  }

  async initDevice() {
    try {
      debugLog('Initializing device ID...');
      const result = await chrome.storage.local.get(['deviceId']);
      
      if (result.deviceId) {
        this.deviceId = result.deviceId;
        debugLog('Loaded existing device ID:', this.deviceId);
      } else {
        const uuid = this.generateUUID();
        const processUnique = Math.random().toString(36).substring(2, 6);
        this.deviceId = `device-v2-${uuid}-${processUnique}`;
        await chrome.storage.local.set({ deviceId: this.deviceId });
        debugLog('Generated new V2 device ID:', this.deviceId);
      }
    } catch (error) {
      debugLog('Error initializing device ID:', error.message);
      const randomPart = Math.random().toString(36).substring(2, 8);
      const timePart = Date.now().toString(36);
      const procPart = (Math.floor(Math.random() * 10000)).toString(36);
      this.deviceId = `device-v2-session-${timePart}-${randomPart}-${procPart}`;
      debugLog('Using fallback V2 device ID:', this.deviceId);
    }
  }

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Detect if server supports V2 architecture
   */
  async detectServerVersion(baseUrl) {
    try {
      debugLog('Detecting server architecture version...');
      
      // Try V2 control endpoint first
      return new Promise((resolve) => {
        const testUrl = baseUrl.replace('ws://', 'ws://').replace('wss://', 'wss://') + '/v2/control';
        const testWs = new WebSocket(testUrl);
        
        const timeout = setTimeout(() => {
          testWs.close();
          debugLog('V2 detection timeout - falling back to V1');
          resolve({ isV2: false, version: 'V1' });
        }, 3000);
        
        testWs.onopen = () => {
          debugLog('V2 control endpoint accessible - server supports V2');
          clearTimeout(timeout);
          testWs.close();
          resolve({ isV2: true, version: 'V2' });
        };
        
        testWs.onerror = () => {
          debugLog('V2 control endpoint not accessible - using V1');
          clearTimeout(timeout);
          resolve({ isV2: false, version: 'V1' });
        };
      });
    } catch (error) {
      debugLog('Server detection failed, defaulting to V1:', error.message);
      return { isV2: false, version: 'V1' };
    }
  }

  /**
   * Connect using V2 architecture
   */
  async connectV2(tabId, baseUrl) {
    debugLog(`Connecting to V2 architecture for tab ${tabId}...`);
    
    try {
      // Step 1: Register device
      await this.registerDeviceV2(baseUrl);
      
      // Step 2: Setup CDP message handling on the device connection  
      await this.setupCDPHandlingOnDeviceConnection(tabId, baseUrl);
      
      // Step 3: Start heartbeat
      this.startHeartbeatV2();
      
      debugLog(`V2 connection established for tab ${tabId}`);
      this.setConnectionState('connected');
      
    } catch (error) {
      debugLog(`V2 connection failed for tab ${tabId}:`, error.message);
      await this.cleanupV2Connection();
      throw error;
    }
  }

  /**
   * Register device with V2 device endpoint
   */
  async registerDeviceV2(baseUrl) {
    return new Promise((resolve, reject) => {
      const deviceUrl = baseUrl + '/v2/device';
      debugLog('Connecting to V2 device endpoint:', deviceUrl);
      
      const deviceWs = new WebSocket(deviceUrl);
      
      const timeout = setTimeout(() => {
        deviceWs.close();
        reject(new Error('Device registration timeout'));
      }, 10000);
      
      deviceWs.onopen = () => {
        debugLog('V2 device connection opened, sending registration...');
        
        const deviceInfo = {
          deviceId: this.deviceId,
          name: `Chrome Extension ${this.deviceId.substring(0, 8)}`,
          version: '2.0.0',
          type: 'extension',
          capabilities: {
            browserName: 'Chrome',
            browserVersion: navigator.userAgent.match(/Chrome\/([0-9.]+)/)?.[1] || 'Unknown',
            platform: navigator.platform,
            userAgent: navigator.userAgent,
            supportedDomains: ['Runtime', 'Page', 'Target', 'DOM', 'Network', 'Console'],
            maxConcurrentRequests: 10,
            features: ['screenshots', 'navigation', 'evaluation', 'debugging']
          },
          metadata: { 
            extension: true,
            timestamp: new Date().toISOString()
          }
        };
        
        const registrationMessage = {
          type: 'device:register',
          id: 'reg-' + Date.now(),
          timestamp: new Date(),
          data: { deviceInfo }
        };
        
        deviceWs.send(JSON.stringify(registrationMessage));
      };
      
      // Set up unified message handler for device connection
      deviceWs.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          // Handle V2 control messages (registration, heartbeat, etc.)
          if (message.type) {
            debugLog('Device control message:', message.type);
            
            if (message.type === 'device:register:ack') {
              debugLog('Device registration successful');
              clearTimeout(timeout);
              this.deviceConnection = deviceWs;
              resolve();
            } else if (message.type === 'error') {
              clearTimeout(timeout);
              deviceWs.close();
              reject(new Error(`Registration failed: ${message.data?.message || 'Unknown error'}`));
            } else if (message.type === 'device:heartbeat:ack') {
              debugLog('Heartbeat acknowledged');
            }
          } 
          // Handle CDP messages (no 'type' field, has 'method' or 'id')
          else if (message.method || message.id) {
            debugLog('Received CDP message on device connection:', message);
            // Forward to CDP handler if it's set up
            if (this.currentConnection && this.currentConnection.socket === deviceWs) {
              this.handleCDPMessage(message);
            }
          }
        } catch (error) {
          debugLog('Error parsing device message:', error);
        }
      };
      
      deviceWs.onerror = (error) => {
        debugLog('Device registration error:', error);
        clearTimeout(timeout);
        reject(new Error('Device registration WebSocket error'));
      };
    });
  }

  /**
   * Setup CDP message handling on the existing device connection
   */
  async setupCDPHandlingOnDeviceConnection(tabId, baseUrl) {
    debugLog(`Setting up CDP handling on device connection for tab ${tabId}...`);
    
    // Attach chrome debugger
    const debuggee = { tabId };
    await chrome.debugger.attach(debuggee, '1.3');
    
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    
    this.isAttached = true;
    
    // Get target info
    const targetInfo = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
    debugLog('Target info:', targetInfo);
    
    // Create connection object using the existing device connection
    const connection = {
      debuggee,
      socket: this.deviceConnection, // Use existing device WebSocket
      tabId,
      sessionId: `pw-tab-${tabId}`,
      bridgeUrl: baseUrl,
      isManualDisconnect: false,
      isV2: true
    };
    
    this.currentConnection = connection;
    this.currentTabId = tabId;
    
    debugLog('CDP handling setup completed on device connection');
  }

  /**
   * Handle CDP messages received on device connection
   */
  async handleCDPMessage(message) {
    if (!this.currentConnection) {
      debugLog('No current connection for CDP message handling');
      return;
    }

    const { debuggee, socket } = this.currentConnection;
    debugLog('Processing CDP message:', message.method, 'ID:', message.id);

    try {
      const debuggerSession = { ...debuggee };
      const sessionId = message.sessionId;
      
      if (sessionId && typeof sessionId === 'string') {
        debuggerSession.sessionId = sessionId;
      }
      
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      
      // Forward CDP command to chrome.debugger
      let result, error = null;
      try {
        result = await chrome.debugger.sendCommand(
          debuggerSession,
          message.method,
          params || {}
        );
        
        if (chrome.runtime.lastError) {
          error = {
            code: -32000,
            message: chrome.runtime.lastError.message,
          };
        }
      } catch (cmdError) {
        error = {
          code: -32000,
          message: cmdError.message || 'Unknown error in debugger command',
        };
      }
      
      // Send response back through device connection
      const response = {
        id: message.id,
        sessionId,
        result
      };
      
      if (error) {
        response.error = error;
      }
      
      debugLog('Sending CDP response:', response.id, error ? 'ERROR' : 'SUCCESS');
      socket.send(JSON.stringify(response));
      
    } catch (error) {
      debugLog('Error processing CDP message:', error);
      const response = {
        id: message.id,
        sessionId: message.sessionId,
        error: {
          code: -32000,
          message: error.message,
        },
      };
      socket.send(JSON.stringify(response));
    }
  }

  /**
   * Setup CDP connection using V2 endpoint (DEPRECATED - now use device connection)
   */
  async setupCDPConnectionV2(tabId, baseUrl) {
    debugLog(`Setting up V2 CDP connection for tab ${tabId}...`);
    
    // Attach chrome debugger
    const debuggee = { tabId };
    await chrome.debugger.attach(debuggee, '1.3');
    
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    
    this.isAttached = true;
    
    // Get target info
    const targetInfo = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
    debugLog('Target info:', targetInfo);
    
    return new Promise((resolve, reject) => {
      const cdpUrl = `${baseUrl}/v2/cdp/${this.deviceId}`;
      debugLog('Connecting to V2 CDP endpoint:', cdpUrl);
      
      const cdpWs = new WebSocket(cdpUrl);
      
      const timeout = setTimeout(() => {
        cdpWs.close();
        reject(new Error('CDP connection timeout'));
      }, 10000);
      
      cdpWs.onopen = () => {
        debugLog('V2 CDP connection opened');
        clearTimeout(timeout);
        
        // Create connection object
        const connection = {
          debuggee,
          socket: cdpWs,
          tabId,
          sessionId: `pw-tab-${tabId}`,
          bridgeUrl: baseUrl,
          isManualDisconnect: false,
          isV2: true
        };
        
        this.currentConnection = connection;
        this.cdpConnection = cdpWs;
        this.currentTabId = tabId;
        
        // Setup message handling
        this.setupV2MessageHandling(connection);
        
        resolve();
      };
      
      cdpWs.onerror = (error) => {
        debugLog('V2 CDP connection error:', error);
        clearTimeout(timeout);
        reject(error);
      };
    });
  }

  /**
   * Setup V2 message handling for CDP
   */
  setupV2MessageHandling(connection) {
    const { debuggee, socket, tabId, sessionId: rootSessionId } = connection;
    
    debugLog('Setting up V2 message handling for tab:', tabId);
    
    // WebSocket -> chrome.debugger
    socket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        debugLog('Error parsing V2 CDP message:', error);
        return;
      }
      
      this.lastHeartbeat = Date.now();
      
      try {
        const debuggerSession = { ...debuggee };
        const sessionId = message.sessionId;
        
        if (sessionId && sessionId !== rootSessionId && typeof sessionId === 'string') {
          debuggerSession.sessionId = sessionId;
        }
        
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        
        // Forward CDP command to chrome.debugger
        let result, error = null;
        try {
          result = await chrome.debugger.sendCommand(
            debuggerSession,
            message.method,
            params || {}
          );
          
          if (chrome.runtime.lastError) {
            error = {
              code: -32000,
              message: chrome.runtime.lastError.message,
            };
          }
        } catch (cmdError) {
          error = {
            code: -32000,
            message: cmdError.message || 'Unknown error in debugger command',
          };
        }
        
        // Send response back
        const response = {
          id: message.id,
          sessionId,
          result
        };
        
        if (error) {
          response.error = error;
        }
        
        socket.send(JSON.stringify(response));
      } catch (error) {
        debugLog('Error processing V2 CDP message:', error);
        const response = {
          id: message.id,
          sessionId: message.sessionId,
          error: {
            code: -32000,
            message: error.message,
          },
        };
        socket.send(JSON.stringify(response));
      }
    };
    
    // chrome.debugger events -> WebSocket
    const eventListener = (source, method, params) => {
      if (source.tabId === tabId && socket.readyState === WebSocket.OPEN) {
        const event = {
          sessionId: source.sessionId || rootSessionId,
          method,
          params,
        };
        socket.send(JSON.stringify(event));
      }
    };
    
    const detachListener = (source, reason) => {
      if (source.tabId === tabId) {
        debugLog(`V2 Debugger detached from tab ${tabId}, reason: ${reason}`);
        this.disconnectTab();
      }
    };
    
    connection.eventListener = eventListener;
    connection.detachListener = detachListener;
    
    chrome.debugger.onEvent.addListener(eventListener);
    chrome.debugger.onDetach.addListener(detachListener);
    
    // Handle WebSocket close
    socket.onclose = (event) => {
      debugLog(`V2 CDP WebSocket closed for tab ${tabId}, code: ${event.code}`);
      
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };
    
    socket.onerror = (error) => {
      debugLog(`V2 CDP WebSocket error for tab ${tabId}:`, error);
      
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };
  }

  /**
   * Start V2 heartbeat mechanism
   */
  startHeartbeatV2() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.deviceConnection && this.deviceConnection.readyState === WebSocket.OPEN) {
        const heartbeatMessage = {
          type: 'device:heartbeat',
          id: 'hb-' + Date.now(),
          timestamp: new Date(),
          data: { deviceId: this.deviceId }
        };
        
        try {
          this.deviceConnection.send(JSON.stringify(heartbeatMessage));
          debugLog('V2 heartbeat sent');
        } catch (error) {
          debugLog('V2 heartbeat send failed:', error);
        }
      }
    }, 30000); // Send heartbeat every 30 seconds
    
    debugLog('V2 heartbeat started');
  }

  /**
   * Connect using V1 architecture (fallback)
   */
  async connectV1(tabId, bridgeUrl) {
    debugLog(`Connecting to V1 architecture for tab ${tabId}...`);
    
    this.setConnectionState('connecting');
    
    // Attach chrome debugger
    const debuggee = { tabId };
    await chrome.debugger.attach(debuggee, '1.3');
    
    if (chrome.runtime.lastError) {
      throw new Error(chrome.runtime.lastError.message);
    }
    
    this.isAttached = true;
    
    // Get target info
    const targetInfo = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
    debugLog('V1 Target info:', targetInfo);
    
    // Connect to bridge server (V1 style)
    const fullUrl = bridgeUrl + '/extension'; // V1 endpoint
    const socket = new WebSocket(fullUrl);
    const connection = {
      debuggee,
      socket,
      tabId,
      sessionId: `pw-tab-${tabId}`,
      bridgeUrl,
      isManualDisconnect: false,
      isV2: false
    };
    
    this.currentConnection = connection;
    this.currentTabId = tabId;
    
    // Setup V1 message handling (original logic)
    this.setupV1MessageHandling(connection);
    
    await new Promise((resolve, reject) => {
      socket.onopen = () => {
        debugLog(`V1 WebSocket connected for tab ${tabId}`);
        
        // Send connection info to bridge
        const connectionInfo = {
          type: 'connection_info',
          sessionId: connection.sessionId,
          targetInfo: targetInfo?.targetInfo
        };
        socket.send(JSON.stringify(connectionInfo));
        resolve();
      };
      
      socket.onerror = (error) => {
        debugLog(`V1 WebSocket connection error for tab ${tabId}:`, error);
        reject(error);
      };
      
      setTimeout(() => {
        reject(new Error('V1 Connection timeout'));
      }, 5000);
    });
    
    this.setConnectionState('connected');
    debugLog(`V1 connection established for tab ${tabId}`);
  }

  /**
   * Setup V1 message handling (original implementation)
   */
  setupV1MessageHandling(connection) {
    const { debuggee, socket, tabId, sessionId: rootSessionId } = connection;
    
    // WebSocket -> chrome.debugger (V1 logic)
    socket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        debugLog('Error parsing V1 message:', error);
        socket.send(JSON.stringify({
          error: {
            code: -32700,
            message: `Error parsing message: ${error.message}`
          }
        }));
        return;
      }
      
      this.lastHeartbeat = Date.now();
      
      // Handle pong responses from server
      if (message.type === 'pong') {
        debugLog('Received V1 pong from server');
        return;
      }
      
      try {
        const debuggerSession = { ...debuggee };
        const sessionId = message.sessionId;
        
        if (sessionId && sessionId !== rootSessionId && typeof sessionId === 'string') {
          debuggerSession.sessionId = sessionId;
        }
        
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        
        let result, error = null;
        try {
          result = await chrome.debugger.sendCommand(
            debuggerSession,
            message.method,
            params || {}
          );
          
          if (chrome.runtime.lastError) {
            error = {
              code: -32000,
              message: chrome.runtime.lastError.message,
            };
          }
        } catch (cmdError) {
          error = {
            code: -32000,
            message: cmdError.message || 'Unknown error in debugger command',
          };
        }
        
        const response = {
          id: message.id,
          sessionId,
          result
        };
        
        if (chrome.runtime.lastError) {
          response.error = {
            code: -32000,
            message: chrome.runtime.lastError.message,
          };
        }
        
        socket.send(JSON.stringify(response));
      } catch (error) {
        debugLog('Error processing V1 WebSocket message:', error);
        const response = {
          id: message.id,
          sessionId: message.sessionId,
          error: {
            code: -32000,
            message: error.message,
          },
        };
        socket.send(JSON.stringify(response));
      }
    };
    
    // Rest of V1 handling logic (events, etc.)
    const eventListener = (source, method, params) => {
      if (source.tabId === tabId && socket.readyState === WebSocket.OPEN) {
        const event = {
          sessionId: source.sessionId || rootSessionId,
          method,
          params,
        };
        socket.send(JSON.stringify(event));
      }
    };
    
    const detachListener = (source, reason) => {
      if (source.tabId === tabId) {
        debugLog(`V1 Debugger detached from tab ${tabId}, reason: ${reason}`);
        this.disconnectTab();
      }
    };
    
    connection.eventListener = eventListener;
    connection.detachListener = detachListener;
    
    chrome.debugger.onEvent.addListener(eventListener);
    chrome.debugger.onDetach.addListener(detachListener);
    
    socket.onclose = (event) => {
      debugLog(`V1 WebSocket closed for tab ${tabId}, code: ${event.code}`);
      
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };
    
    socket.onerror = (error) => {
      debugLog(`V1 WebSocket error for tab ${tabId}:`, error);
      
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };
  }

  /**
   * Main connection method - auto-detects and uses appropriate architecture
   */
  async connectTab(tabId, bridgeUrl) {
    try {
      debugLog(`Connecting tab ${tabId} to bridge at ${bridgeUrl}`);
      
      // Disconnect any existing connection first
      if (this.currentConnection) {
        await this.cleanupConnection(true);
      }
      
      this.setConnectionState('connecting');
      
      // Detect server version
      const serverInfo = await this.detectServerVersion(bridgeUrl);
      this.isV2Server = serverInfo.isV2;
      this.serverVersion = serverInfo.version;
      
      debugLog(`Detected server version: ${this.serverVersion}`);
      
      // Connect using appropriate architecture
      if (this.isV2Server) {
        await this.connectV2(tabId, bridgeUrl);
      } else {
        await this.connectV1(tabId, bridgeUrl);
      }
      
      this.reconnectAttempts = 0;
      this.lastHeartbeat = Date.now();
      
      debugLog(`Tab ${tabId} connected successfully using ${this.serverVersion} architecture`);
      
    } catch (error) {
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      await this.cleanupConnection(true);
      this.setConnectionState('error');
      throw error;
    }
  }

  /**
   * Cleanup V2 connections
   */
  async cleanupV2Connection() {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Close device connection
    if (this.deviceConnection && this.deviceConnection.readyState === WebSocket.OPEN) {
      this.deviceConnection.close();
    }
    this.deviceConnection = null;
    
    // Close CDP connection
    if (this.cdpConnection && this.cdpConnection.readyState === WebSocket.OPEN) {
      this.cdpConnection.close();
    }
    this.cdpConnection = null;
    
    debugLog('V2 connections cleaned up');
  }

  /**
   * Enhanced cleanup for both V1 and V2
   */
  async cleanupConnection(clearTabState = true) {
    if (!this.currentConnection) return;
    
    const connection = this.currentConnection;
    
    // V2 specific cleanup
    if (connection.isV2) {
      await this.cleanupV2Connection();
    }
    
    // Remove listeners
    if (connection.eventListener) {
      chrome.debugger.onEvent.removeListener(connection.eventListener);
    }
    if (connection.detachListener) {
      chrome.debugger.onDetach.removeListener(connection.detachListener);
    }
    
    // Close WebSocket
    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close();
    }
    
    // Detach debugger if attached
    if (this.isAttached) {
      try {
        await chrome.debugger.detach(connection.debuggee);
      } catch (error) {
        debugLog('Detach error (ignored):', error);
      }
      this.isAttached = false;
    }
    
    // Clear current connection and tab state if requested
    if (clearTabState) {
      this.currentConnection = null;
      this.currentTabId = null;
      this.reconnectAttempts = 0;
      this.lastHeartbeat = null;
    } else {
      this.currentConnection = null;
    }
  }

  // Rest of the methods remain similar to original implementation
  // (onTabActivated, onTabUpdated, etc. - keeping them concise for space)

  async onTabActivated(activeInfo) {
    const { tabId } = activeInfo;
    debugLog(`Tab activated: ${tabId}`);
    
    if (!this.currentConnection && this.autoConnectEnabled) {
      try {
        await this.connectTab(tabId, this.defaultBridgeUrl);
        debugLog(`Auto-connected to activated tab ${tabId}`);
      } catch (error) {
        debugLog(`Auto-connect failed for tab ${tabId}:`, error.message);
      }
    } else if (this.currentConnection && this.currentTabId !== tabId) {
      await this.switchToTab(tabId);
    }
  }

  async switchToTab(newTabId) {
    try {
      debugLog(`Switching connection from tab ${this.currentTabId} to tab ${newTabId}`);
      
      const oldTabId = this.currentTabId;
      const bridgeUrl = this.currentConnection?.bridgeUrl || this.defaultBridgeUrl;
      
      if (this.currentConnection) {
        this.currentConnection.isManualDisconnect = true;
        await this.cleanupConnection(false);
      }
      
      await this.connectTab(newTabId, bridgeUrl);
      
      if (oldTabId) {
        chrome.action.setBadgeText({ tabId: oldTabId, text: '' });
        chrome.action.setTitle({ tabId: oldTabId, title: 'Share tab with Playwright MCP' });
      }
      
      debugLog(`Successfully switched to tab ${newTabId}`);
    } catch (error) {
      debugLog(`Failed to switch to tab ${newTabId}:`, error.message);
      this.setConnectionState('error');
    }
  }

  startGuardianTimer() {
    if (this.guardianTimer) {
      clearInterval(this.guardianTimer);
    }
    
    this.guardianTimer = setInterval(() => {
      this.checkConnectionHealth();
    }, this.guardianInterval);
  }

  async checkConnectionHealth() {
    if (!this.currentConnection) return;
    
    const now = Date.now();
    const connection = this.currentConnection;
    
    // Check WebSocket state
    if (connection.socket && connection.socket.readyState !== WebSocket.OPEN) {
      debugLog('Guardian detected WebSocket not open, triggering reconnection');
      this.attemptReconnection();
      return;
    }
    
    // Check heartbeat timeout
    if (this.lastHeartbeat && (now - this.lastHeartbeat) > 30000) {
      debugLog('Guardian detected heartbeat timeout, triggering reconnection');
      this.attemptReconnection();
      return;
    }
    
    // Send ping to keep connection alive
    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
      try {
        if (connection.isV2) {
          // V2 uses device heartbeat
          if (this.deviceConnection && this.deviceConnection.readyState === WebSocket.OPEN) {
            this.deviceConnection.send(JSON.stringify({
              type: 'device:heartbeat',
              id: 'guardian-hb-' + now,
              timestamp: new Date(),
              data: { deviceId: this.deviceId }
            }));
          }
        } else {
          // V1 uses ping
          connection.socket.send(JSON.stringify({
            type: 'ping',
            deviceId: this.deviceId,
            timestamp: now
          }));
        }
        this.lastHeartbeat = now;
      } catch (error) {
        debugLog('Guardian ping/heartbeat failed:', error.message);
        this.attemptReconnection();
      }
    }
  }

  setConnectionState(state) {
    this.connectionState = state;
    this.updateBadgeState();
    debugLog(`Connection state changed to: ${state}`);
  }

  updateBadgeState() {
    if (!this.currentTabId) return;
    
    const tabId = this.currentTabId;
    const versionLabel = this.serverVersion || 'Unknown';
    
    switch (this.connectionState) {
      case 'disconnected':
        chrome.action.setBadgeText({ tabId, text: '' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#808080' });
        chrome.action.setTitle({ tabId, title: 'Share tab with Playwright MCP' });
        break;
        
      case 'connecting':
        chrome.action.setBadgeText({ tabId, text: '⋯' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#2196F3' });
        chrome.action.setTitle({ tabId, title: `Connecting to Playwright MCP (${versionLabel})...` });
        break;
        
      case 'connected':
        chrome.action.setBadgeText({ tabId, text: '●' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: this.isV2Server ? '#00BCD4' : '#4CAF50' });
        chrome.action.setTitle({ tabId, title: `Connected to Playwright MCP ${versionLabel} (Device: ${this.deviceId})` });
        break;
        
      case 'reconnecting':
        chrome.action.setBadgeText({ tabId, text: '⟳' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF9800' });
        chrome.action.setTitle({ tabId, title: `Reconnecting ${versionLabel}... (${this.reconnectAttempts}/5)` });
        break;
        
      case 'error':
        chrome.action.setBadgeText({ tabId, text: '!' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#F44336' });
        chrome.action.setTitle({ tabId, title: `${versionLabel} connection failed - Click to retry` });
        break;
    }
  }

  async attemptReconnection() {
    if (!this.currentConnection || !this.currentTabId) return;
    
    const maxAttempts = 5;
    const baseDelay = 1000;
    
    if (this.reconnectAttempts >= maxAttempts) {
      debugLog(`Max reconnection attempts reached for tab ${this.currentTabId}, giving up`);
      await this.disconnectTab();
      return;
    }
    
    const delay = baseDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000;
    this.reconnectAttempts++;
    
    debugLog(`Reconnecting tab ${this.currentTabId} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`);
    
    this.setConnectionState('reconnecting');
    
    setTimeout(async () => {
      try {
        if (!this.currentConnection || !this.currentTabId) {
          debugLog('Connection or tab info lost during reconnection delay');
          return;
        }
        
        const { bridgeUrl } = this.currentConnection;
        const tabId = this.currentTabId;
        
        await this.cleanupConnection(false);
        await this.connectTab(tabId, bridgeUrl);
        
        this.reconnectAttempts = 0;
        debugLog(`Successfully reconnected tab ${tabId}`);
        
      } catch (error) {
        debugLog(`Reconnection attempt ${this.reconnectAttempts} failed for tab ${this.currentTabId}:`, error.message);
        
        if (this.reconnectAttempts < maxAttempts) {
          this.attemptReconnection();
        } else {
          debugLog(`All reconnection attempts failed for tab ${this.currentTabId}`);
          await this.disconnectTab();
        }
      }
    }, delay);
  }

  async disconnectTab() {
    if (!this.currentConnection) return;
    
    this.currentConnection.isManualDisconnect = true;
    this.reconnectAttempts = 0;
    
    const tabId = this.currentTabId;
    await this.cleanupConnection(true);
    
    this.setConnectionState('disconnected');
    debugLog(`Tab ${tabId} disconnected`);
  }

  async initAutoConnect() {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      const allTabs = await chrome.tabs.query({ active: true });
      
      if (allTabs.length > 0) {
        const activeTab = allTabs.sort((a, b) => {
          const aTime = a.lastAccessed || 0;
          const bTime = b.lastAccessed || 0;
          return bTime - aTime;
        })[0];
        
        if (activeTab && activeTab.id) {
          debugLog(`Auto-connecting to most recent active tab ${activeTab.id}: ${activeTab.url}`);
          await this.connectTab(activeTab.id, this.defaultBridgeUrl);
          return;
        }
      }
      
      const anyTab = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      if (anyTab.length > 0 && anyTab[0].id) {
        debugLog(`Auto-connecting to first available tab ${anyTab[0].id}: ${anyTab[0].url}`);
        await this.connectTab(anyTab[0].id, this.defaultBridgeUrl);
      }
      
    } catch (error) {
      debugLog('Auto-connect failed:', error.message);
    }
  }

  onMessage(message, sender, sendResponse) {
    switch (message.type) {
      case 'getStatus':
        this.getStatus(message.tabId, sendResponse).catch((error) => {
          debugLog('Error in getStatus:', error);
          sendResponse({
            isConnected: false,
            deviceId: this.deviceId || 'device-error',
            error: 'Failed to get status'
          });
        });
        return true;

      case 'connect':
        this.connectTab(message.tabId, message.bridgeUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;

      case 'disconnect':
        this.disconnectTab().then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true;
    }
    return false;
  }

  async getStatus(requestedTabId, sendResponse) {
    if (!this.deviceId) {
      try {
        await this.initDevice();
      } catch (error) {
        debugLog('Error initializing device ID for status:', error);
      }
    }

    const isConnected = this.currentConnection !== null;
    
    if (isConnected && this.currentTabId) {
      chrome.tabs.get(this.currentTabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            isConnected: false,
            deviceId: this.deviceId,
            connectionState: this.connectionState,
            serverVersion: this.serverVersion,
            error: 'Active tab not found'
          });
        } else {
          sendResponse({
            isConnected: true,
            deviceId: this.deviceId,
            connectionState: this.connectionState,
            serverVersion: this.serverVersion,
            isV2Server: this.isV2Server,
            activeTabId: this.currentTabId,
            activeTabInfo: {
              title: tab.title,
              url: tab.url
            }
          });
        }
      });
    } else {
      sendResponse({
        isConnected: false,
        deviceId: this.deviceId,
        connectionState: this.connectionState,
        serverVersion: this.serverVersion,
        isV2Server: this.isV2Server,
        activeTabId: null,
        activeTabInfo: null
      });
    }
  }

  async onTabUpdated(tabId, changeInfo, tab) {
    if (this.currentTabId === tabId && changeInfo.status === 'complete' && this.currentConnection) {
      debugLog(`Current tab ${tabId} page loaded: ${tab.url}`);
      this.updateBadgeState();
    }
  }

  async onTabRemoved(tabId) {
    if (this.currentTabId === tabId) {
      debugLog(`Current connected tab ${tabId} was removed`);
      await this.cleanupConnection(true);
      this.setConnectionState('disconnected');
    }
  }

  async onExtensionStartup() {
    debugLog('Extension startup detected');
    if (this.deviceId && this.autoConnectEnabled) {
      await this.initAutoConnect();
    }
  }

  async onExtensionInstalled(details) {
    debugLog('Extension installed/updated:', details.reason);
    if (details.reason === 'install' || details.reason === 'update') {
      debugLog('Extension ready for auto-connection');
    }
  }
}

new TabShareExtensionV2();