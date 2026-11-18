// General API Response Structure
export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data?: T;
  stats?: SystemStats; // Specifically for /api/v1/browser/list
}

// Error Response (matches components/schemas/ErrorResponse)
export interface ErrorResponse {
  code: -1;
  msg: string;
}

// components/schemas/BrowserInstance
export interface BrowserInstance {
  user_id: string;
  last_activity: string; // ISO date-time string
  idle_time_seconds: number;
}

// components/schemas/SystemStats (used in /api/v1/browser/list)
export interface SystemStats {
  current_instances: number;
  max_instances: number;
  instance_timeout_ms: number;
}

// Data structure for /api/v1/browser/stats response
// (matches paths["/api/v1/browser/stats"].get.responses[200].content.application/json.schema.properties.data)
export interface SystemStatsData {
  current_instances: number;
  max_instances: number;
  available_slots: number;
  instance_timeout_ms: number;
  inactive_check_interval: number;
}

// Response type for GET /api/v1/browser/stop
export type StopBrowserResponse = ApiResponse<null> | ErrorResponse;

// Response type for GET /api/v1/browser/list
export interface ListBrowserResponse extends ApiResponse<BrowserInstance[]> {
  stats: SystemStats; // Overriding optional stats to be required for this specific endpoint
}

// Response type for GET /api/v1/browser/stats
export type StatsBrowserResponse = ApiResponse<SystemStatsData>;

// components/schemas/LaunchParameters (for WebSocket)
export interface LaunchParameters {
  user?: string;
  args?: string[];
}

// For cli.ts internal config
export interface AppConfig {
  maxInstances: number;
  instanceTimeout: number; // minutes
  inactiveCheckInterval: number; // minutes
  token: string;
  cdpLogging: boolean; // Enable detailed CDP protocol logging for debugging
  port?: number; // Server port number
}

// For chromeLauncher options in cli.ts
// This is a simplified version, chrome-launcher has more options.
export interface ChromeLaunchOptions {
  startingUrl?: string;
  chromeFlags?: string[];
  port?: number;
  userDataDir?: string | boolean;
  logLevel?: 'verbose' | 'info' | 'error' | 'silent';
  ignoreDefaultFlags?: boolean;
  connectionPollInterval?: number;
  maxConnectionRetries?: number;
  envVars?: { [key: string]: string };
  handleSIGINT?: boolean;
}
