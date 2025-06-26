/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Simple Chrome Extension that pumps CDP messages between chrome.debugger and WebSocket
 */

// @ts-check

function debugLog(...args) {
  const enabled = true; // Enable for device ID debugging
  if (enabled) {
    console.log('[Extension]', ...args);
  }
}

class TabShareExtension {
  constructor() {
    // Single connection mode - only track current active tab
    this.currentConnection = null; // Single connection object
    this.currentTabId = null; // Currently connected tab ID
    this.autoConnectEnabled = true; // Enable auto-connect for testing
    this.defaultBridgeUrl = 'ws://localhost:3000/extension'; // Default bridge URL
    this.deviceId = null; // Will be initialized from storage
    this.isAttached = false; // Track debugger attachment status
    this.reconnectAttempts = 0; // Single counter for current tab
    this.connectionState = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'reconnecting', 'error'
    
    // Guardian timer for connection health monitoring
    this.guardianTimer = null;
    this.guardianInterval = 10000; // Check every 10 seconds
    this.lastHeartbeat = null;

    // Tab change monitoring
    chrome.tabs.onActivated.addListener(this.onTabActivated.bind(this));
    chrome.tabs.onUpdated.addListener(this.onTabUpdated.bind(this));
    chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));

    // Extension lifecycle monitoring
    chrome.runtime.onStartup.addListener(this.onExtensionStartup.bind(this));
    chrome.runtime.onInstalled.addListener(this.onExtensionInstalled.bind(this));

    // Handle messages from popup
    chrome.runtime.onMessage.addListener(this.onMessage.bind(this));

    // Initialize device ID and auto-connect
    this.initDevice().then(() => {
      // Start guardian timer
      this.startGuardianTimer();
      
      if (this.autoConnectEnabled) {
        this.initAutoConnect();
      }
    });
  }

  /**
   * Initialize device ID - generate UUID if not exists
   */
  async initDevice() {
    try {
      debugLog('Initializing device ID...');
      // Try to get existing device ID from storage
      const result = await chrome.storage.local.get(['deviceId']);
      
      if (result.deviceId) {
        this.deviceId = result.deviceId;
        debugLog('Loaded existing device ID:', this.deviceId);
      } else {
        // Generate new device ID
        this.deviceId = `device-${this.generateUUID()}`;
        await chrome.storage.local.set({ deviceId: this.deviceId });
        debugLog('Generated new device ID:', this.deviceId);
      }
    } catch (error) {
      debugLog('Error initializing device ID:', error.message);
      // Fallback to session-based ID
      this.deviceId = `device-session-${Date.now()}`;
      debugLog('Using fallback device ID:', this.deviceId);
    }
  }

  /**
   * Generate UUID v4
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Get device ID
   */
  getDeviceId() {
    return this.deviceId;
  }

  /**
   * Handle tab activation (switching between tabs)
   */
  async onTabActivated(activeInfo) {
    const { tabId } = activeInfo;
    debugLog(`Tab activated: ${tabId}`);
    
    // Auto-connect to activated tab if we don't have a connection
    if (!this.currentConnection && this.autoConnectEnabled) {
      try {
        await this.connectTab(tabId, this.defaultBridgeUrl);
        debugLog(`Auto-connected to activated tab ${tabId}`);
      } catch (error) {
        debugLog(`Auto-connect failed for tab ${tabId}:`, error.message);
      }
    }
    // If we have an active connection and it's not for this tab, switch connection
    else if (this.currentConnection && this.currentTabId !== tabId) {
      await this.switchToTab(tabId);
    }
  }

  /**
   * Handle tab updates (URL changes, loading states)
   */
  async onTabUpdated(tabId, changeInfo, tab) {
    // Only handle completed page loads for the current connected tab
    if (this.currentTabId === tabId && changeInfo.status === 'complete' && this.currentConnection) {
      debugLog(`Current tab ${tabId} page loaded: ${tab.url}`);
      // Update connection info if needed
      this.updateBadgeState();
    }
  }

  /**
   * Switch connection to a new active tab
   */
  async switchToTab(newTabId) {
    try {
      debugLog(`Switching connection from tab ${this.currentTabId} to tab ${newTabId}`);
      
      const oldTabId = this.currentTabId;
      const bridgeUrl = this.currentConnection?.bridgeUrl || this.defaultBridgeUrl;
      
      // Disconnect from current tab (but don't clear device state)
      if (this.currentConnection) {
        this.currentConnection.isManualDisconnect = true; // Prevent reconnection
        await this.cleanupConnection(false);
      }
      
      // Connect to new tab
      await this.connectTab(newTabId, bridgeUrl);
      
      // Clear badge on old tab
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

  /**
   * Start guardian timer for connection health monitoring
   */
  startGuardianTimer() {
    if (this.guardianTimer) {
      clearInterval(this.guardianTimer);
    }
    
    this.guardianTimer = setInterval(() => {
      this.checkConnectionHealth();
    }, this.guardianInterval);
    
    debugLog('Guardian timer started');
  }

  /**
   * Stop guardian timer
   */
  stopGuardianTimer() {
    if (this.guardianTimer) {
      clearInterval(this.guardianTimer);
      this.guardianTimer = null;
      debugLog('Guardian timer stopped');
    }
  }

  /**
   * Check connection health and trigger reconnection if needed
   */
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
    
    // Check heartbeat timeout (if no activity for 30 seconds)
    if (this.lastHeartbeat && (now - this.lastHeartbeat) > 30000) {
      debugLog('Guardian detected heartbeat timeout, triggering reconnection');
      this.attemptReconnection();
      return;
    }
    
    // Send ping to keep connection alive
    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
      try {
        connection.socket.send(JSON.stringify({
          type: 'ping',
          deviceId: this.deviceId,
          timestamp: now
        }));
        this.lastHeartbeat = now;
      } catch (error) {
        debugLog('Guardian ping failed:', error.message);
        this.attemptReconnection();
      }
    }
  }

  /**
   * Set connection state and update badge
   */
  setConnectionState(state) {
    this.connectionState = state;
    this.updateBadgeState();
    debugLog(`Connection state changed to: ${state}`);
  }

  /**
   * Update badge based on current connection state
   */
  updateBadgeState() {
    if (!this.currentTabId) return;
    
    const tabId = this.currentTabId;
    
    switch (this.connectionState) {
      case 'disconnected':
        chrome.action.setBadgeText({ tabId, text: '' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#808080' });
        chrome.action.setTitle({ tabId, title: 'Share tab with Playwright MCP' });
        break;
        
      case 'connecting':
        chrome.action.setBadgeText({ tabId, text: '⋯' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#2196F3' });
        chrome.action.setTitle({ tabId, title: 'Connecting to Playwright MCP...' });
        break;
        
      case 'connected':
        chrome.action.setBadgeText({ tabId, text: '●' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#4CAF50' });
        chrome.action.setTitle({ tabId, title: `Connected to Playwright MCP (Device: ${this.deviceId})` });
        break;
        
      case 'reconnecting':
        chrome.action.setBadgeText({ tabId, text: '⟳' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#FF9800' });
        chrome.action.setTitle({ tabId, title: `Reconnecting... (${this.reconnectAttempts}/5)` });
        break;
        
      case 'error':
        chrome.action.setBadgeText({ tabId, text: '!' });
        chrome.action.setBadgeBackgroundColor({ tabId, color: '#F44336' });
        chrome.action.setTitle({ tabId, title: 'Connection failed - Click to retry' });
        break;
    }
  }

  /**
   * Initialize auto-connect functionality
   */
  async initAutoConnect() {
    // Wait a bit for extension to fully initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      // In service worker, we need to find the most recently active tab
      // across all windows since there's no "current window" context
      const allTabs = await chrome.tabs.query({ active: true });
      
      if (allTabs.length > 0) {
        // Sort by lastAccessed if available, otherwise use the first active tab
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
      
      // Fallback: get any available tab
      const anyTab = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
      if (anyTab.length > 0 && anyTab[0].id) {
        debugLog(`Auto-connecting to first available tab ${anyTab[0].id}: ${anyTab[0].url}`);
        await this.connectTab(anyTab[0].id, this.defaultBridgeUrl);
      }
      
    } catch (error) {
      debugLog('Auto-connect failed:', error.message);
      debugLog('Will auto-connect when user activates a tab');
      // Extension will auto-connect when user activates any tab via onTabActivated
    }
  }

  /**
   * Handle messages from popup
   * @param {any} message
   * @param {chrome.runtime.MessageSender} sender
   * @param {Function} sendResponse
   */
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
        return true; // Will respond asynchronously

      case 'connect':
        this.connectTab(message.tabId, message.bridgeUrl).then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true; // Will respond asynchronously

      case 'disconnect':
        this.disconnectTab().then(
          () => sendResponse({ success: true }),
          (error) => sendResponse({ success: false, error: error.message })
        );
        return true; // Will respond asynchronously
    }
    return false;
  }

  /**
   * Get connection status for popup
   * @param {number} requestedTabId
   * @param {Function} sendResponse
   */
  async getStatus(requestedTabId, sendResponse) {
    // Ensure device ID is initialized before responding
    if (!this.deviceId) {
      try {
        await this.initDevice();
      } catch (error) {
        debugLog('Error initializing device ID for status:', error);
      }
    }

    const isConnected = this.currentConnection !== null;
    
    if (isConnected && this.currentTabId) {
      // Get current tab info
      chrome.tabs.get(this.currentTabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            isConnected: false,
            deviceId: this.deviceId,
            connectionState: this.connectionState,
            error: 'Active tab not found'
          });
        } else {
          sendResponse({
            isConnected: true,
            deviceId: this.deviceId,
            connectionState: this.connectionState,
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
        activeTabId: null,
        activeTabInfo: null
      });
    }
  }

  /**
   * Connect a tab to the bridge server
   * @param {number} tabId
   * @param {string} bridgeUrl
   */
  async connectTab(tabId, bridgeUrl) {
    try {
      debugLog(`Connecting tab ${tabId} to bridge at ${bridgeUrl}`);
      
      // Disconnect any existing connection first
      if (this.currentConnection) {
        await this.cleanupConnection(true);
      }
      
      this.setConnectionState('connecting');

      // Attach chrome debugger immediately (like Microsoft's implementation)
      const debuggee = { tabId };
      await chrome.debugger.attach(debuggee, '1.3');

      if (chrome.runtime.lastError)
        throw new Error(chrome.runtime.lastError.message);
      
      // Mark debugger as attached
      this.isAttached = true;
      
      // Get target info after attaching
      const targetInfo = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
      debugLog('Target info:', targetInfo);

      // Connect to bridge server
      const socket = new WebSocket(bridgeUrl);
      const connection = {
        debuggee,
        socket,
        tabId,
        sessionId: `pw-tab-${tabId}`,
        bridgeUrl, // 保存bridgeUrl用于重连
        isManualDisconnect: false // 标记是否为手动断开
      };

      // Store as current connection BEFORE setting up message handling
      // This ensures event handlers can properly check connection state
      this.currentConnection = connection;
      this.currentTabId = tabId;

      // Set up message handling IMMEDIATELY after creating the connection
      // This ensures no messages are lost during the connection setup process
      debugLog('>>> Setting up message handling for connection, tabId:', tabId);
      this.setupMessageHandling(connection);
      debugLog('>>> Message handling setup completed');

      await new Promise((resolve, reject) => {
        socket.onopen = () => {
          debugLog(`WebSocket connected for tab ${tabId}`);
          
          // Send connection info to bridge (simplified like Microsoft's implementation)
          const connectionInfo = {
            type: 'connection_info',
            sessionId: connection.sessionId,
            targetInfo: targetInfo?.targetInfo
          };
          debugLog('Sending connection info:', connectionInfo);
          socket.send(JSON.stringify(connectionInfo));
          debugLog('Connection info sent successfully');
          
          resolve(undefined);
        };
        socket.onerror = (error) => {
          debugLog(`WebSocket connection error for tab ${tabId}:`, error);
          reject(error);
        };
        setTimeout(() => {
          debugLog(`WebSocket connection timeout for tab ${tabId}`);
          reject(new Error('Connection timeout'));
        }, 5000);
      });
      this.reconnectAttempts = 0; // Reset reconnect attempts
      this.lastHeartbeat = Date.now(); // Initialize heartbeat
      
      this.setConnectionState('connected');
      debugLog(`Tab ${tabId} connected successfully`);

    } catch (error) {
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      await this.cleanupConnection(true);
      this.setConnectionState('error');
      throw error; // Re-throw for popup to handle
    }
  }

  /**
   * Set up bidirectional message handling between debugger and WebSocket
   * @param {Object} connection
   */
  setupMessageHandling(connection) {
    const { debuggee, socket, tabId, sessionId: rootSessionId } = connection;

    debugLog('>>> setupMessageHandling called for tabId:', tabId, 'socket readyState:', socket.readyState);

    // WebSocket -> chrome.debugger
    socket.onmessage = async (event) => {
      debugLog('>>> WebSocket onmessage event triggered! Event data length:', event.data?.length);
      
      let message;
      try {
        message = JSON.parse(event.data);
        debugLog('>>> Successfully parsed message:', message);
      } catch (error) {
        debugLog('Error parsing message:', error);
        socket.send(JSON.stringify({
          error: {
            code: -32700,
            message: `Error parsing message: ${error.message}`
          }
        }));
        return;
      }

      // Update heartbeat on any message
      this.lastHeartbeat = Date.now();

      // Handle pong responses from server (heartbeat response)
      if (message.type === 'pong') {
        debugLog('Received pong from server');
        return;
      }

      try {
        debugLog('>>> Processing CDP message from bridge:', message.method || 'response', 'id:', message.id);



        const debuggerSession = { ...debuggee };
        const sessionId = message.sessionId;
        // Pass session id, unless it's the root session.
        if (sessionId && sessionId !== rootSessionId && typeof sessionId === 'string')
          debuggerSession.sessionId = sessionId;

        // Ensure params is an object
        const params = message.params && typeof message.params === 'object' ? message.params : {};

        debugLog('Calling chrome.debugger.sendCommand with:', {
          debuggerSession,
          method: message.method,
          params
        });

        // Forward CDP command to chrome.debugger
        let result, error = null;
        try {
          result = await chrome.debugger.sendCommand(
            debuggerSession,
            message.method,
            params || {}
          );
          
          // Check for Chrome runtime error immediately after the call
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

        // Send response back to bridge (simplified like Microsoft's implementation)
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
        debugLog('Error processing WebSocket message:', error);
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

    // chrome.debugger events -> WebSocket (simplified like Microsoft's implementation)
    const eventListener = (source, method, params) => {
      if (source.tabId === tabId && socket.readyState === WebSocket.OPEN) {
        // If the sessionId is not provided, use the root sessionId.
        const event = {
          sessionId: source.sessionId || rootSessionId,
          method,
          params,
        };
        debugLog('Forwarding CDP event:', event);
        socket.send(JSON.stringify(event));
      }
    };

    const detachListener = (source, reason) => {
      if (source.tabId === tabId) {
        debugLog(`Debugger detached from tab ${tabId}, reason: ${reason}`);
        this.disconnectTab(tabId);
      }
    };

    // Store listeners for cleanup
    connection.eventListener = eventListener;
    connection.detachListener = detachListener;

    chrome.debugger.onEvent.addListener(eventListener);
    chrome.debugger.onDetach.addListener(detachListener);

    // Handle WebSocket close
    socket.onclose = (event) => {
      debugLog(`WebSocket closed for tab ${tabId}, code: ${event.code}, reason: ${event.reason}`);
      
      // Only attempt reconnection if not manually disconnected and this is current connection
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };

    // Handle WebSocket error
    socket.onerror = (error) => {
      debugLog(`WebSocket error for tab ${tabId}:`, error);
      
      // Only attempt reconnection if not manually disconnected and this is current connection
      if (!connection.isManualDisconnect && this.currentConnection === connection) {
        this.attemptReconnection();
      } else if (this.currentConnection === connection) {
        this.disconnectTab();
      }
    };

  }

  /**
   * Attempt to reconnect current tab after connection loss
   */
  async attemptReconnection() {
    if (!this.currentConnection || !this.currentTabId) return;

    const maxAttempts = 5;
    const baseDelay = 1000;

    if (this.reconnectAttempts >= maxAttempts) {
      debugLog(`Max reconnection attempts reached for tab ${this.currentTabId}, giving up`);
      await this.disconnectTab();
      return;
    }

    // Exponential backoff with jitter
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
        
        // Clean up current connection but keep tab ID for reconnection
        await this.cleanupConnection(false);
        
        // Try to reconnect
        await this.connectTab(tabId, bridgeUrl);
        
        // Success - reset attempt counter
        this.reconnectAttempts = 0;
        debugLog(`Successfully reconnected tab ${tabId}`);
        
      } catch (error) {
        debugLog(`Reconnection attempt ${this.reconnectAttempts} failed for tab ${this.currentTabId}:`, error.message);
        
        // Try again if we haven't reached max attempts
        if (this.reconnectAttempts < maxAttempts) {
          this.attemptReconnection();
        } else {
          debugLog(`All reconnection attempts failed for tab ${this.currentTabId}`);
          await this.disconnectTab();
        }
      }
    }, delay);
  }

  /**
   * Disconnect current tab from the bridge
   */
  async disconnectTab() {
    if (!this.currentConnection) return;
    
    // Mark as manual disconnect to prevent reconnection attempts
    this.currentConnection.isManualDisconnect = true;
    
    // Clear reconnection attempts
    this.reconnectAttempts = 0;
    
    const tabId = this.currentTabId;
    await this.cleanupConnection(true);

    this.setConnectionState('disconnected');
    debugLog(`Tab ${tabId} disconnected`);
  }
  /**
   * Clean up connection resources
   * @param {boolean} clearTabState - Whether to clear current tab state (default: true)
   */
  async cleanupConnection(clearTabState = true) {
    if (!this.currentConnection) return;

    const connection = this.currentConnection;

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
        // Ignore detach errors - might already be detached
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
      // Just clear the connection object but keep tab reference for reconnection
      this.currentConnection = null;
    }
  }
  /**
   * Handle tab removal
   * @param {number} tabId
   */
  async onTabRemoved(tabId) {
    // If the removed tab is our current connection, clean up
    if (this.currentTabId === tabId) {
      debugLog(`Current connected tab ${tabId} was removed`);
      await this.cleanupConnection(true);
      this.setConnectionState('disconnected');
    }
  }

  /**
   * Handle extension startup (browser restart)
   */
  async onExtensionStartup() {
    debugLog('Extension startup detected');
    // Wait for device initialization and then auto-connect
    if (this.deviceId && this.autoConnectEnabled) {
      await this.initAutoConnect();
    }
  }

  /**
   * Handle extension installation/update
   */
  async onExtensionInstalled(details) {
    debugLog('Extension installed/updated:', details.reason);
    // For new installs or updates, ensure we're ready to auto-connect
    if (details.reason === 'install' || details.reason === 'update') {
      // Device will be initialized in constructor, then auto-connect will trigger
      debugLog('Extension ready for auto-connection');
    }
  }
}

new TabShareExtension();
