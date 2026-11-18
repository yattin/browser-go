/**
 * Chrome instance management utilities
 * Handles launching, caching, cleanup and lifecycle management of Chrome instances
 */

import chromeLauncher, { LaunchedChrome } from 'chrome-launcher';
import { logger } from './logger.js';
import { AppConfig } from './types.js';

export class ChromeManager {
  private chromeInstances: { [key: string]: LaunchedChrome } = {};
  private instanceLastActivity: { [key: string]: number } = {};
  private maxConcurrentInstances: number;
  private instanceTimeoutMs: number;
  private inactiveCheckInterval: number;
  private cleanupIntervalId: NodeJS.Timeout;

  constructor(config: AppConfig) {
    this.maxConcurrentInstances = config.maxInstances;
    this.instanceTimeoutMs = config.instanceTimeout * 60 * 1000; // Convert minutes to milliseconds
    this.inactiveCheckInterval = config.inactiveCheckInterval * 60 * 1000; // Convert minutes to milliseconds

    // Periodically clean up inactive instances
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupInactiveInstances();
    }, this.inactiveCheckInterval);
  }

  /**
   * Calculate current instance count
   */
  getCurrentInstanceCount(): number {
    return Object.keys(this.chromeInstances).length;
  }

  /**
   * Check if max instances reached
   */
  reachedMaxInstances(): boolean {
    return this.getCurrentInstanceCount() >= this.maxConcurrentInstances;
  }

  /**
   * Update instance activity time
   */
  updateInstanceActivity(userKey: string): void {
    if (userKey && this.chromeInstances[userKey]) {
      this.instanceLastActivity[userKey] = Date.now();
    }
  }

  /**
   * Launch a new Chrome instance
   */
  async launchChromeInstance(
    chromeOptions: chromeLauncher.Options,
    userKey: string | null = null,
  ): Promise<LaunchedChrome> {
    const chrome: LaunchedChrome = await chromeLauncher.launch(chromeOptions);
    const chromeProcess = chrome.process;
    
    if (chromeProcess) {
      chromeProcess.on('exit', () => {
        if (userKey) {
          logger.info(
            `Received Chrome process exit signal (user: ${userKey}), cleaning up instance`,
          );
          delete this.chromeInstances[userKey];
          delete this.instanceLastActivity[userKey];
        } else {
          logger.info(
            'Received Chrome process exit signal (no user), cleaning up instance',
          );
        }
      });
    }

    if (userKey) {
      this.instanceLastActivity[userKey] = Date.now();
    }

    logger.info(
      `Launched new Chrome instance ${userKey ? `for user: ${userKey}` : '(no user)'}`,
    );
    logger.info(
      `Current active Chrome instances: ${this.getCurrentInstanceCount()}/${this.maxConcurrentInstances}`,
    );

    return chrome;
  }

  /**
   * Get existing Chrome instance for user
   */
  getChromeInstance(userKey: string): LaunchedChrome | null {
    return this.chromeInstances[userKey] || null;
  }

  /**
   * Store Chrome instance for user
   */
  setChromeInstance(userKey: string, chrome: LaunchedChrome): void {
    this.chromeInstances[userKey] = chrome;
  }

  /**
   * Remove Chrome instance for user
   */
  removeChromeInstance(userKey: string): void {
    delete this.chromeInstances[userKey];
    delete this.instanceLastActivity[userKey];
  }

  /**
   * Get all Chrome instances
   */
  getAllChromeInstances(): { [key: string]: LaunchedChrome } {
    return { ...this.chromeInstances };
  }

  /**
   * Get instance activity data
   */
  getInstanceActivity(): { [key: string]: number } {
    return { ...this.instanceLastActivity };
  }

  /**
   * Clean up inactive instances
   */
  async cleanupInactiveInstances(): Promise<void> {
    const now = Date.now();
    const inactiveUserKeys: string[] = [];

    for (const [userKey, lastActivity] of Object.entries(this.instanceLastActivity)) {
      if (now - lastActivity > this.instanceTimeoutMs) {
        inactiveUserKeys.push(userKey);
      }
    }

    for (const userKey of inactiveUserKeys) {
      if (this.chromeInstances[userKey]) {
        try {
          logger.info(`Closing inactive Chrome instance (user: ${userKey})`);
          await this.chromeInstances[userKey].kill();
          delete this.chromeInstances[userKey];
          delete this.instanceLastActivity[userKey];
        } catch (error) {
          logger.error(
            `Failed to close inactive instance (user: ${userKey}):`,
            error,
          );
        }
      }
    }

    logger.info(
      `Current active Chrome instances: ${this.getCurrentInstanceCount()}/${this.maxConcurrentInstances}`,
    );
  }

  /**
   * Kill specific Chrome instance
   */
  async killChromeInstance(userKey: string): Promise<boolean> {
    const instance = this.chromeInstances[userKey];
    if (instance) {
      try {
        await instance.kill();
        delete this.chromeInstances[userKey];
        delete this.instanceLastActivity[userKey];
        return true;
      } catch (error) {
        logger.error(`Failed to kill Chrome instance (user: ${userKey}):`, error);
        return false;
      }
    }
    return false;
  }

  /**
   * Get configuration info
   */
  getConfig() {
    return {
      maxConcurrentInstances: this.maxConcurrentInstances,
      instanceTimeoutMs: this.instanceTimeoutMs,
      inactiveCheckInterval: this.inactiveCheckInterval,
    };
  }

  /**
   * Cleanup all instances and stop the manager
   */
  async shutdown(): Promise<void> {
    // Clear the cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    // Kill all active instances
    const killPromises = Object.entries(this.chromeInstances).map(async ([userKey, instance]) => {
      try {
        logger.info(`Shutting down Chrome instance (user: ${userKey})`);
        await instance.kill();
      } catch (error) {
        logger.error(`Failed to shutdown instance (user: ${userKey}):`, error);
      }
    });

    await Promise.all(killPromises);
    
    // Clear all tracking data
    this.chromeInstances = {};
    this.instanceLastActivity = {};
    
    logger.info('Chrome manager shutdown complete');
  }
}