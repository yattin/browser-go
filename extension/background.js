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
    this.activeConnections = new Map(); // tabId -> connection info
    this.autoConnectEnabled = true; // Enable auto-connect for testing
    this.defaultBridgeUrl = 'ws://localhost:3000/extension'; // Default bridge URL
    this.deviceId = null; // Will be initialized from storage
    this.isAttached = false; // Track debugger attachment status
    this.reconnectAttempts = new Map(); // tabId -> attempt count

    // Remove page action click handler since we now use popup
    chrome.tabs.onRemoved.addListener(this.onTabRemoved.bind(this));

    // Handle messages from popup
    chrome.runtime.onMessage.addListener(this.onMessage.bind(this));

    // Initialize device ID and auto-connect
    this.initDevice().then(() => {
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
   * Initialize auto-connect functionality
   */
  async initAutoConnect() {
    // Wait a bit for extension to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      // Get the active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id) {
        debugLog(`Auto-connecting to tab ${activeTab.id}: ${activeTab.url}`);
        await this.connectTab(activeTab.id, this.defaultBridgeUrl);
      }
    } catch (error) {
      debugLog('Auto-connect failed:', error.message);
      // If auto-connect fails, user can still manually connect via popup
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
        this.disconnectTab(message.tabId).then(
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

    const isConnected = this.activeConnections.size > 0;
    let activeTabId = null;
    let activeTabInfo = null;

    if (isConnected) {
      const [tabId, connection] = this.activeConnections.entries().next().value;
      activeTabId = tabId;

      // Get tab info
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            isConnected: false,
            deviceId: this.deviceId,
            error: 'Active tab not found'
          });
        } else {
          sendResponse({
            isConnected: true,
            deviceId: this.deviceId,
            activeTabId,
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

      // Prepare debuggee but don't attach yet (lazy attach)
      const debuggee = { tabId };
      
      // Get tab info without attaching debugger
      const tab = await chrome.tabs.get(tabId);
      const targetInfo = {
        targetInfo: {
          targetId: `tab-${tabId}`,
          type: 'page',
          title: tab.title,
          url: tab.url,
          attached: false, // Will be true after lazy attach
          canAccessOpener: false,
          browserContextId: `context-${tabId}`
        }
      };

      // Connect to bridge server
      const socket = new WebSocket(bridgeUrl);      const connection = {
        debuggee,
        socket,
        tabId,
        sessionId: `pw-tab-${tabId}`,
        bridgeUrl, // 保存bridgeUrl用于重连
        isManualDisconnect: false // 标记是否为手动断开
      };

      await new Promise((resolve, reject) => {
        socket.onopen = () => {
          debugLog(`WebSocket connected for tab ${tabId}`);
          
          // First send device registration
          socket.send(JSON.stringify({
            type: 'device_register',
            deviceId: this.deviceId,
            deviceInfo: {
              name: 'Chrome Extension Device',
              version: '1.0.0',
              userAgent: navigator.userAgent,
              timestamp: new Date().toISOString()
            }
          }));
          
          // Then send connection info to bridge
          socket.send(JSON.stringify({
            type: 'connection_info',
            deviceId: this.deviceId,
            sessionId: connection.sessionId,
            targetInfo: targetInfo?.targetInfo
          }));
          
          resolve(undefined);
        };
        socket.onerror = reject;
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      // Set up message handling
      this.setupMessageHandling(connection);

      // Store connection
      this.activeConnections.set(tabId, connection);

      // Update UI
      chrome.action.setBadgeText({ tabId, text: '●' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#4CAF50' });
      chrome.action.setTitle({ tabId, title: 'Disconnect from Playwright MCP' });

      debugLog(`Tab ${tabId} connected successfully`);

    } catch (error) {
      debugLog(`Failed to connect tab ${tabId}:`, error.message);
      await this.cleanupConnection(tabId);

      // Show error to user
      chrome.action.setBadgeText({ tabId, text: '!' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#F44336' });
      chrome.action.setTitle({ tabId, title: `Connection failed: ${error.message}` });

      throw error; // Re-throw for popup to handle
    }
  }

  /**
   * Set up bidirectional message handling between debugger and WebSocket
   * @param {Object} connection
   */
  setupMessageHandling(connection) {
    const { debuggee, socket, tabId, sessionId: rootSessionId } = connection;

    // WebSocket -> chrome.debugger
    socket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
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

      try {
        debugLog('Received from bridge:', message);

        // Lazy attach: only attach debugger when receiving actual CDP commands
        if (message.method && !this.isAttached) {
          debugLog('Lazy attaching debugger for first CDP command');
          try {
            await chrome.debugger.attach(debuggee, '1.3');
            this.isAttached = true;
            debugLog('Debugger attached successfully');
          } catch (attachError) {
            debugLog('Failed to attach debugger:', attachError);
            const response = {
              id: message.id,
              sessionId: message.sessionId,
              error: {
                code: -32000,
                message: `Failed to attach debugger: ${attachError.message}`,
              },
            };
            socket.send(JSON.stringify(response));
            return;
          }
        }

        const debuggerSession = { ...debuggee };
        const sessionId = message.sessionId;
        // Pass session id, unless it's the root session.
        if (sessionId && sessionId !== rootSessionId)
          debuggerSession.sessionId = sessionId;

        // Forward CDP command to chrome.debugger
        const result = await chrome.debugger.sendCommand(
          debuggerSession,
          message.method,
          message.params || {}
        );

        // Send response back to bridge
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

    // chrome.debugger events -> WebSocket
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
    chrome.debugger.onDetach.addListener(detachListener);    // Handle WebSocket close
    socket.onclose = (event) => {
      debugLog(`WebSocket closed for tab ${tabId}, code: ${event.code}, reason: ${event.reason}`);
      
      // Only attempt reconnection if not manually disconnected
      if (!connection.isManualDisconnect) {
        this.attemptReconnection(tabId);
      } else {
        this.disconnectTab(tabId);
      }
    };

    socket.onerror = (error) => {
      debugLog(`WebSocket error for tab ${tabId}:`, error);
      
      // Only attempt reconnection if not manually disconnected
      if (!connection.isManualDisconnect) {
        this.attemptReconnection(tabId);
      } else {
        this.disconnectTab(tabId);
      }
    };  }

  /**
   * Attempt to reconnect a tab after connection loss
   * @param {number} tabId
   */
  async attemptReconnection(tabId) {
    const connection = this.activeConnections.get(tabId);
    if (!connection) return;

    const currentAttempts = this.reconnectAttempts.get(tabId) || 0;
    const maxAttempts = 5;
    const baseDelay = 1000;

    if (currentAttempts >= maxAttempts) {
      debugLog(`Max reconnection attempts reached for tab ${tabId}, giving up`);
      await this.disconnectTab(tabId);
      return;
    }

    // Exponential backoff with jitter
    const delay = baseDelay * Math.pow(2, currentAttempts) + Math.random() * 1000;
    this.reconnectAttempts.set(tabId, currentAttempts + 1);

    debugLog(`Reconnecting tab ${tabId} in ${Math.round(delay)}ms (attempt ${currentAttempts + 1}/${maxAttempts})`);

    // Update UI to show reconnecting status
    chrome.action.setBadgeText({ tabId, text: '⟳' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#FFA500' });
    chrome.action.setTitle({ tabId, title: `Reconnecting... (${currentAttempts + 1}/${maxAttempts})` });

    setTimeout(async () => {
      try {
        const { bridgeUrl } = connection;
        
        // Clean up current connection but keep the reconnection flag
        await this.cleanupConnection(tabId, false);
        
        // Try to reconnect
        await this.connectTab(tabId, bridgeUrl);
        
        // Success - reset attempt counter
        this.reconnectAttempts.delete(tabId);
        debugLog(`Successfully reconnected tab ${tabId}`);
        
      } catch (error) {
        debugLog(`Reconnection attempt ${currentAttempts + 1} failed for tab ${tabId}:`, error.message);
        
        // Try again if we haven't reached max attempts
        if (currentAttempts + 1 < maxAttempts) {
          this.attemptReconnection(tabId);
        } else {
          debugLog(`All reconnection attempts failed for tab ${tabId}`);
          await this.disconnectTab(tabId);
        }
      }
    }, delay);
  }

  /**
   * Disconnect a tab from the bridge
   * @param {number} tabId
   */  async disconnectTab(tabId) {
    // Mark as manual disconnect to prevent reconnection attempts
    const connection = this.activeConnections.get(tabId);
    if (connection) {
      connection.isManualDisconnect = true;
    }
    
    // Clear reconnection attempts
    this.reconnectAttempts.delete(tabId);
    
    await this.cleanupConnection(tabId);

    // Update UI
    chrome.action.setBadgeText({ tabId, text: '' });
    chrome.action.setTitle({ tabId, title: 'Share tab with Playwright MCP' });

    debugLog(`Tab ${tabId} disconnected`);
  }
  /**
   * Clean up connection resources
   * @param {number} tabId
   * @param {boolean} clearReconnectAttempts - Whether to clear reconnection attempts (default: true)
   */
  async cleanupConnection(tabId, clearReconnectAttempts = true) {
    const connection = this.activeConnections.get(tabId);
    if (!connection) return;

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

    this.activeConnections.delete(tabId);
    
    // Clear reconnection attempts if requested
    if (clearReconnectAttempts) {
      this.reconnectAttempts.delete(tabId);
    }
  }
  /**
   * Handle tab removal
   * @param {number} tabId
   */
  async onTabRemoved(tabId) {
    if (this.activeConnections.has(tabId)) {
      // Clear reconnection attempts
      this.reconnectAttempts.delete(tabId);
      await this.cleanupConnection(tabId);
    }
  }
}

new TabShareExtension();
