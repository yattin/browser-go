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

// @ts-check

/**
 * Popup script for Playwright MCP Bridge extension
 */

class PopupController {
  constructor() {
    this.currentTab = null;
    this.bridgeUrlInput = /** @type {HTMLInputElement} */ (document.getElementById('bridge-url'));
    this.connectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('connect-btn'));
    this.statusContainer = /** @type {HTMLElement} */ (document.getElementById('status-container'));
    this.actionContainer = /** @type {HTMLElement} */ (document.getElementById('action-container'));
    this.deviceIdElement = /** @type {HTMLElement} */ (document.getElementById('device-id'));

    this.init();
  }

  async init() {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    this.currentTab = tab;

    // Set default bridge URL (read-only for display)
    this.bridgeUrlInput.value = 'ws://localhost:3000/extension';
    this.bridgeUrlInput.disabled = true; // Always disabled for auto-connection mode

    // URL input is now display-only, no event listeners needed
    
    // Set up device ID click to copy
    if (this.deviceIdElement) {
      this.deviceIdElement.addEventListener('click', this.onDeviceIdClick.bind(this));
    }

    // Update UI based on current state
    await this.updateUI();
  }

  async updateUI() {
    if (!this.currentTab?.id) return;

    // Get connection status from background script
    const response = await chrome.runtime.sendMessage({
      type: 'getStatus',
      tabId: this.currentTab.id
    });

    const { isConnected, activeTabId, activeTabInfo, error, deviceId, connectionState } = response;

    // Update device ID display
    if (this.deviceIdElement) {
      if (deviceId && deviceId !== 'device-error') {
        this.deviceIdElement.textContent = deviceId;
      } else if (deviceId === 'device-error') {
        this.deviceIdElement.textContent = 'Error loading device ID';
        this.deviceIdElement.style.color = '#c62828';
      } else {
        this.deviceIdElement.textContent = 'Loading...';
        // Retry getting status after a short delay
        setTimeout(() => this.updateUI(), 1000);
      }
    }

    if (!this.statusContainer || !this.actionContainer) return;

    this.statusContainer.innerHTML = '';
    this.actionContainer.innerHTML = '';

    if (error) {
      this.showStatus('error', `Error: ${error}`);
      this.showWaitingMessage();
    } else if (isConnected && activeTabId === this.currentTab.id) {
      // Current tab is connected
      const stateMessage = this.getConnectionStateMessage(connectionState);
      this.showStatus('connected', stateMessage);
      this.showDisconnectButton();
    } else if (isConnected && activeTabId !== this.currentTab.id) {
      // Another tab is connected
      this.showStatus('warning', 'Another tab is already sharing the CDP session');
      this.showActiveTabInfo(activeTabInfo);
      this.showFocusButton(activeTabId);
    } else {
      // No connection - show current state
      const stateMessage = this.getConnectionStateMessage(connectionState);
      this.showStatus('info', stateMessage);
      this.showWaitingMessage();
    }
  }

  showStatus(type, message) {
    const statusDiv = document.createElement('div');
    statusDiv.className = `status ${type}`;
    statusDiv.textContent = message;
    this.statusContainer.appendChild(statusDiv);
  }

  getConnectionStateMessage(connectionState) {
    switch (connectionState) {
      case 'connecting':
        return 'Connecting to bridge server...';
      case 'connected':
        return 'This tab is shared with MCP server';
      case 'reconnecting':
        return 'Reconnecting to bridge server...';
      case 'error':
        return 'Connection failed - will retry automatically';
      case 'disconnected':
      default:
        return 'Ready for auto-connection';
    }
  }

  showWaitingMessage() {
    if (!this.actionContainer) return;

    this.actionContainer.innerHTML = `
      <div class="waiting-message">
        <div class="status info">Auto-connection is enabled</div>
        <div class="small-text">
          The extension will automatically connect to this tab when you make it active.
          Switch away and back to this tab to trigger connection.
        </div>
      </div>
    `;
  }

  showDisconnectButton() {
    if (!this.actionContainer) return;

    this.actionContainer.innerHTML = `
      <button id="disconnect-btn" class="button disconnect">Stop Sharing</button>
    `;

    const disconnectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('disconnect-btn'));
    if (disconnectBtn) {
      disconnectBtn.addEventListener('click', this.onDisconnectClick.bind(this));
    }
  }

  showActiveTabInfo(tabInfo) {
    if (!tabInfo) return;

    const tabDiv = document.createElement('div');
    tabDiv.className = 'tab-info';
    tabDiv.innerHTML = `
      <div class="tab-title">${tabInfo.title || 'Unknown Tab'}</div>
      <div class="tab-url">${tabInfo.url || ''}</div>
    `;
    this.statusContainer.appendChild(tabDiv);
  }

  showFocusButton(activeTabId) {
    if (!this.actionContainer) return;

    this.actionContainer.innerHTML = `
      <button id="focus-btn" class="button focus-button">Switch to Shared Tab</button>
    `;

    const focusBtn = /** @type {HTMLButtonElement} */ (document.getElementById('focus-btn'));
    if (focusBtn) {
      focusBtn.addEventListener('click', () => this.onFocusClick(activeTabId));
    }
  }

  onUrlChange() {
    if (!this.bridgeUrlInput) return;

    const isValid = this.isValidWebSocketUrl(this.bridgeUrlInput.value);
    const connectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('connect-btn'));
    if (connectBtn) {
      connectBtn.disabled = !isValid;
    }

    // Save URL to storage
    if (isValid) {
      chrome.storage.sync.set({ bridgeUrl: this.bridgeUrlInput.value });
    }
  }

  // Connection is now handled automatically by background script
  // This method is disabled to make popup display-only
  async onConnectClick() {
    // No longer used - auto-connection handles this
    console.log('Manual connection disabled - using auto-connection');
  }

  async onDisconnectClick() {
    const response = await chrome.runtime.sendMessage({
      type: 'disconnect'
      // No tabId needed - background script handles current connection
    });

    if (response.success) {
      await this.updateUI();
    } else {
      this.showStatus('error', response.error || 'Failed to disconnect');
    }
  }

  async onFocusClick(activeTabId) {
    try {
      await chrome.tabs.update(activeTabId, { active: true });
      window.close(); // Close popup after switching
    } catch (error) {
      this.showStatus('error', 'Failed to switch to tab');
    }
  }

  isValidWebSocketUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  async onDeviceIdClick() {
    if (!this.deviceIdElement) return;
    
    const deviceId = this.deviceIdElement.textContent;
    if (!deviceId || deviceId === 'Loading...') return;

    try {
      await navigator.clipboard.writeText(deviceId);
      
      // Show feedback
      const originalText = this.deviceIdElement.textContent;
      this.deviceIdElement.textContent = 'Copied!';
      this.deviceIdElement.style.background = '#e8f5e8';
      this.deviceIdElement.style.color = '#2e7d32';
      
      setTimeout(() => {
        this.deviceIdElement.textContent = originalText;
        this.deviceIdElement.style.background = '#f9f9f9';
        this.deviceIdElement.style.color = '#333';
      }, 1500);
    } catch (error) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = deviceId;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      
      // Show feedback
      const originalText = this.deviceIdElement.textContent;
      this.deviceIdElement.textContent = 'Copied!';
      setTimeout(() => {
        this.deviceIdElement.textContent = originalText;
      }, 1500);
    }
  }
}

// Initialize popup when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});
