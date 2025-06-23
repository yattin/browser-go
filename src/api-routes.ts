/**
 * HTTP API routes definitions
 * Defines REST API endpoints for browser instance management
 */

import { Request, Response, Application } from 'express';
import { logger } from './logger.js';
import { ChromeManager } from './chrome-manager.js';
import { 
  StopBrowserResponse, 
  ListBrowserResponse, 
  StatsBrowserResponse,
  BrowserInstance,
  SystemStats,
  SystemStatsData 
} from './types.js';

export class ApiRoutes {
  private chromeManager: ChromeManager;

  constructor(chromeManager: ChromeManager) {
    this.chromeManager = chromeManager;
  }

  /**
   * Setup all API routes on the Express app
   */
  setupRoutes(app: Application): void {
    this.setupStopRoute(app);
    this.setupListRoute(app);
    this.setupStatsRoute(app);
  }

  /**
   * Setup GET /api/v1/browser/stop endpoint
   */
  private setupStopRoute(app: Application): void {
    app.get(
      '/api/v1/browser/stop',
      async (req: Request, res: Response): Promise<void> => {
        const userId = req.query.user_id as string;

        if (!userId) {
          const response: StopBrowserResponse = {
            code: -1,
            msg: 'Missing user_id parameter',
          };
          res.status(400).json(response);
          return;
        }

        const instance = this.chromeManager.getChromeInstance(userId);
        if (instance) {
          try {
            const success = await this.chromeManager.killChromeInstance(userId);
            if (success) {
              const response: StopBrowserResponse = { code: 0, msg: 'success' };
              res.json(response);
            } else {
              const response: StopBrowserResponse = {
                code: -1,
                msg: 'Failed to close browser instance',
              };
              res.status(500).json(response);
            }
            return;
          } catch (error) {
            logger.error('Failed to close browser instance:', error);
            const response: StopBrowserResponse = {
              code: -1,
              msg: 'Failed to close browser instance',
            };
            res.status(500).json(response);
            return;
          }
        } else {
          const response: StopBrowserResponse = {
            code: -1,
            msg: 'Browser instance not found for this user_id',
          };
          res.status(404).json(response);
          return;
        }
      },
    );
  }

  /**
   * Setup GET /api/v1/browser/list endpoint
   */
  private setupListRoute(app: Application): void {
    app.get('/api/v1/browser/list', (req: Request, res: Response) => {
      const instances = this.chromeManager.getAllChromeInstances();
      const activities = this.chromeManager.getInstanceActivity();
      const config = this.chromeManager.getConfig();
      
      const userIds = Object.keys(instances);
      const now = Date.now();

      const browserListData: BrowserInstance[] = userIds.map((userId) => {
        const lastActivityTime = activities[userId] || 0;
        const idleTimeMs = now - lastActivityTime;

        return {
          user_id: userId,
          last_activity: new Date(lastActivityTime).toISOString(),
          idle_time_seconds: Math.floor(idleTimeMs / 1000),
        };
      });

      const systemStats: SystemStats = {
        current_instances: this.chromeManager.getCurrentInstanceCount(),
        max_instances: config.maxConcurrentInstances,
        instance_timeout_ms: config.instanceTimeoutMs,
      };

      const response: ListBrowserResponse = {
        code: 0,
        msg: 'success',
        data: browserListData,
        stats: systemStats,
      };
      res.json(response);
    });
  }

  /**
   * Setup GET /api/v1/browser/stats endpoint
   */
  private setupStatsRoute(app: Application): void {
    app.get('/api/v1/browser/stats', (req: Request, res: Response) => {
      const config = this.chromeManager.getConfig();
      
      const statsData: SystemStatsData = {
        current_instances: this.chromeManager.getCurrentInstanceCount(),
        max_instances: config.maxConcurrentInstances,
        available_slots: config.maxConcurrentInstances - this.chromeManager.getCurrentInstanceCount(),
        instance_timeout_ms: config.instanceTimeoutMs,
        inactive_check_interval: config.inactiveCheckInterval,
      };
      
      const response: StatsBrowserResponse = {
        code: 0,
        msg: 'success',
        data: statsData,
      };
      res.json(response);
    });
  }
}