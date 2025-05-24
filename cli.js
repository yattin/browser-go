#!/usr/bin/env node

import express from 'express';
import chromeLauncher from 'chrome-launcher';
import http from 'http';
import httpProxy from 'http-proxy';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

// 显示帮助信息
function showHelp() {
    console.log(`
Browser-Go Service Launcher

Usage: node cli.js [options]

Options:
  --max-instances=<number>      Maximum concurrent instances (default: 10)
  --instance-timeout=<minutes>  Instance timeout in minutes (default: 60 minutes)
  --inactive-check-interval=<minutes>  Inactive instance check interval in minutes (default: 5 minutes)
  --token=<string>             Access token (default: 'browser-go-token')
  --help                       Show help information

Examples:
  node cli.js --max-instances=5 --instance-timeout=30
  node cli.js --token=my-secret-token
`);
    process.exit(0);
}

// 解析命令行参数
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        maxInstances: 10,
        instanceTimeout: 60, // 默认60分钟
        inactiveCheckInterval: 5, // 默认5分钟
        token: 'browser-go-token'
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help') {
            showHelp();
        }
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            switch (key) {
                case 'max-instances':
                    config.maxInstances = parseInt(value) || 10;
                    break;
                case 'instance-timeout':
                    config.instanceTimeout = parseInt(value) || 60;
                    break;
                case 'inactive-check-interval':
                    config.inactiveCheckInterval = parseInt(value) || 5;
                    break;
                case 'token':
                    config.token = value || 'browser-go-token';
                    break;
            }
        }
    }
    return config;
}

const config = parseArgs();
const app = express();
const port = 3000;

// 配置项
const MAX_CONCURRENT_INSTANCES = config.maxInstances;
const INSTANCE_TIMEOUT_MS = config.instanceTimeout * 60 * 1000; // Convert minutes to milliseconds
const INACTIVE_CHECK_INTERVAL = config.inactiveCheckInterval * 60 * 1000; // Convert minutes to milliseconds
const token = config.token;

let chromeInstances = {}; // Cache for Chrome instances
let instanceLastActivity = {}; // Record last activity time for each instance

// Add function to calculate current instance count
const getCurrentInstanceCount = () => {
    return Object.keys(chromeInstances).length;
};

// Add function to check if max instances reached
const reachedMaxInstances = () => {
    return getCurrentInstanceCount() >= MAX_CONCURRENT_INSTANCES;
};

// Add function to update instance activity time
const updateInstanceActivity = (userKey) => {
    if (userKey && chromeInstances[userKey]) {
        instanceLastActivity[userKey] = Date.now();
    }
};

// Add function to clean up inactive instances
const cleanupInactiveInstances = async () => {
    const now = Date.now();
    const inactiveUserKeys = [];

    for (const [userKey, lastActivity] of Object.entries(instanceLastActivity)) {
        if (now - lastActivity > INSTANCE_TIMEOUT_MS) {
            inactiveUserKeys.push(userKey);
        }
    }

    for (const userKey of inactiveUserKeys) {
        if (chromeInstances[userKey]) {
            try {
                logger.info(`Closing inactive Chrome instance (user: ${userKey})`);
                await chromeInstances[userKey].kill();
                delete chromeInstances[userKey];
                delete instanceLastActivity[userKey];
            } catch (error) {
                logger.error(`Failed to close inactive instance (user: ${userKey}):`, error);
            }
        }
    }

    logger.info(`Current active Chrome instances: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`);
};

// Periodically clean up inactive instances
setInterval(cleanupInactiveInstances, INACTIVE_CHECK_INTERVAL);

const launchChromeInstance = async (chromeOptions, userKey = null) => {
    const chrome = await chromeLauncher.launch(chromeOptions);
    const chromeProcess = chrome.process;
    chromeProcess.on('exit', () => {
        if (userKey) {
            logger.info(`Received Chrome process exit signal (user: ${userKey}), cleaning up instance`);
            delete chromeInstances[userKey];
            delete instanceLastActivity[userKey];
        } else {
            logger.info('Received Chrome process exit signal (no user), cleaning up instance');
        }
    });

    if (userKey) {
        instanceLastActivity[userKey] = Date.now();
    }

    logger.info(`Launched new Chrome instance ${userKey ? `for user: ${userKey}` : '(no user)'}`);
    logger.info(`Current active Chrome instances: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`);

    return chrome;
};

// Create an HTTP server
const server = http.createServer(app);

// Parse parameters from path URL format
function parsePathParameters(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const params = {};

    for (let i = 0; i < parts.length - 1; i += 2) {
        if (parts[i] && parts[i + 1]) {
            params[parts[i]] = decodeURIComponent(parts[i + 1]);
        }
    }

    return params;
}

// Listen for WebSocket requests
server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const searchParams = url.searchParams;
    const pathParams = parsePathParameters(url.pathname);

    // 尝试从查询字符串或路径中获取参数
    const reqToken = searchParams.get('token') || pathParams['token'];
    const startingUrl = searchParams.get('startingUrl') || pathParams['startingUrl'];

    if (!reqToken) {
        logger.error('Missing token parameter');
        socket.end('HTTP/1.1 400 Bad Request\r\n');
        return;
    }
    if (reqToken !== token) {
        logger.error('Invalid token');
        socket.end('HTTP/1.1 403 Forbidden\r\n');
        return;
    }

    if (!startingUrl) {
        logger.error('Missing startingUrl parameter');
        socket.end('HTTP/1.1 400 Bad Request\r\n');
        return;
    }

    try {
        // const launchArgs = JSON.stringify({ headless: false, args: ["--window-size=1920,1080", "--lang=en-US"] });
        const launchArgs = searchParams.has('launch') ? JSON.parse(searchParams.get('launch')) : {};

        // sample args: ["--window-size=1920,1080", "--lang=en-US"]
        const launchFlags = launchArgs.args || [];

        const defaultFlags = ['--start-maximized', '--remote-allow-origins=*'];

        // Merge launch parameters
        const finalFlags = [...defaultFlags, ...launchFlags];

        const chromeOptions = {
            startingUrl: startingUrl,
            chromeFlags: finalFlags,
            logLevel: 'info',
            handleSIGINT: true
        };

        const hasUser = launchArgs.user ? true : false;
        let chrome = null;

        if (hasUser) {
            const userKey = launchArgs.user;
            if (chromeInstances[userKey]) {
                chrome = chromeInstances[userKey];
                logger.info(`Reusing existing Chrome instance for user: ${userKey}`);
                updateInstanceActivity(userKey);
            } else {
                if (reachedMaxInstances()) {
                    logger.error('Maximum concurrent instances limit reached');
                    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nMaximum concurrent instances limit reached, please try again later');
                    return;
                }

                const userDataDir = path.join(os.homedir(), '.browser-go', 'browser_data', userKey);
                if (!fs.existsSync(userDataDir)) {
                    fs.mkdirSync(userDataDir, { recursive: true });
                }
                chromeOptions.userDataDir = userDataDir;
                chrome = await launchChromeInstance(chromeOptions, userKey);
                chromeInstances[userKey] = chrome; // Cache for Chrome instances
            }
        } else {
            if (reachedMaxInstances()) {
                logger.error('Maximum concurrent instances limit reached');
                socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nMaximum concurrent instances limit reached, please try again later');
                return;
            }
            chrome = await launchChromeInstance(chromeOptions);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        const debugPort = chrome.port;
        const res = await axios.get(`http://127.0.0.1:${debugPort}/json/version`);
        logger.info('Chrome launched:', res.data);
        const { webSocketDebuggerUrl } = res.data
        // Create a proxy server object
        const cdpProxy = httpProxy.createProxyServer({
            ws: true, // Enable WebSocket support
        });
        cdpProxy.ws(req, socket, head, { changeOrigin: true, target: webSocketDebuggerUrl }, (err) => {
            if (err) {
                logger.error('WebSocket proxy error:', err);
                socket.end('HTTP/1.1 500 Internal Server Error\r\n');
            }
        });
        // Listen for proxy server close event
        cdpProxy.on('close', (req, socket, head) => {
            logger.info('WebSocket connection closed');
            // chrome.kill(); // 注释掉 chrome.kill()
        });
    } catch (error) {
        logger.error('Failed to launch Chrome:', error);
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
    }
});

// Define GET /api/v1/browser/stop endpoint
app.get('/api/v1/browser/stop', async (req, res) => {
    const userId = req.query.user_id;

    if (!userId) {
        return res.status(400).json({ code: -1, msg: 'Missing user_id parameter' });
    }

    if (chromeInstances[userId]) {
        try {
            await chromeInstances[userId].kill();
            delete chromeInstances[userId];
            delete instanceLastActivity[userId];
            res.json({ code: 0, msg: 'success' });
        } catch (error) {
            logger.error('Failed to close browser instance:', error);
            res.status(500).json({ code: -1, msg: 'Failed to close browser instance' });
        }
    } else {
        res.status(404).json({ code: -1, msg: 'Browser instance not found for this user_id' });
    }
});

// Define GET /api/v1/browser/list endpoint
app.get('/api/v1/browser/list', (req, res) => {
    const userIds = Object.keys(chromeInstances);
    const now = Date.now();

    const data = userIds.map(userId => {
        const lastActivityTime = instanceLastActivity[userId] || 0;
        const idleTimeMs = now - lastActivityTime;

        return {
            user_id: userId,
            last_activity: new Date(lastActivityTime).toISOString(),
            idle_time_seconds: Math.floor(idleTimeMs / 1000),
            // 这里可以添加更多环境信息，例如代理信息等
        };
    });

    res.json({
        code: 0,
        msg: 'success',
        data,
        stats: {
            current_instances: getCurrentInstanceCount(),
            max_instances: MAX_CONCURRENT_INSTANCES,
            instance_timeout_ms: INSTANCE_TIMEOUT_MS
        }
    });
});

// Add GET /api/v1/browser/stats endpoint to view system status
app.get('/api/v1/browser/stats', (req, res) => {
    res.json({
        code: 0,
        msg: 'success',
        data: {
            current_instances: getCurrentInstanceCount(),
            max_instances: MAX_CONCURRENT_INSTANCES,
            available_slots: MAX_CONCURRENT_INSTANCES - getCurrentInstanceCount(),
            instance_timeout_ms: INSTANCE_TIMEOUT_MS,
            inactive_check_interval: INACTIVE_CHECK_INTERVAL
        }
    });
});

// Listen on port
server.listen(port, '0.0.0.0', () => {
    logger.info(`Server is running on http://0.0.0.0:${port}`);
    logger.info(`Maximum concurrent instances: ${MAX_CONCURRENT_INSTANCES}`);
    logger.info(`Instance timeout: ${INSTANCE_TIMEOUT_MS / 60000} minutes`);
    logger.info(`Inactive check interval: ${INACTIVE_CHECK_INTERVAL / 60000} minutes`);
});