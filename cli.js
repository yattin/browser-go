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
Browser-Go 服务启动工具

用法: node cli.js [选项]

选项:
  --max-instances=<number>      最大并发实例数 (默认: 10)
  --instance-timeout=<minutes>  实例超时时间，单位分钟 (默认: 60分钟)
  --inactive-check-interval=<minutes> 检查不活跃实例的间隔，单位分钟 (默认: 5分钟)
  --token=<string>             访问令牌 (默认: 'browser-go-token')
  --help                       显示帮助信息

示例:
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
const INSTANCE_TIMEOUT_MS = config.instanceTimeout * 60 * 1000; // 将分钟转换为毫秒
const INACTIVE_CHECK_INTERVAL = config.inactiveCheckInterval * 60 * 1000; // 将分钟转换为毫秒
const token = config.token;

let chromeInstances = {}; // 用于缓存 Chrome 实例
let instanceLastActivity = {}; // 记录每个实例的最后活跃时间

// 添加计算当前实例数量的函数
const getCurrentInstanceCount = () => {
    return Object.keys(chromeInstances).length;
};

// 添加检查是否达到最大实例数的函数
const reachedMaxInstances = () => {
    return getCurrentInstanceCount() >= MAX_CONCURRENT_INSTANCES;
};

// 添加更新实例活跃时间的函数
const updateInstanceActivity = (userKey) => {
    if (userKey && chromeInstances[userKey]) {
        instanceLastActivity[userKey] = Date.now();
    }
};

// 添加清理不活跃实例的函数
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
                logger.info(`关闭不活跃的 Chrome 实例 (user: ${userKey})`);
                await chromeInstances[userKey].kill();
                delete chromeInstances[userKey];
                delete instanceLastActivity[userKey];
            } catch (error) {
                logger.error(`关闭不活跃实例失败 (user: ${userKey}):`, error);
            }
        }
    }

    logger.info(`当前活跃 Chrome 实例数量: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`);
};

// 定期清理不活跃的实例
setInterval(cleanupInactiveInstances, INACTIVE_CHECK_INTERVAL);

const launchChromeInstance = async (chromeOptions, userKey = null) => {
    const chrome = await chromeLauncher.launch(chromeOptions);
    const chromeProcess = chrome.process;
    chromeProcess.on('exit', () => {
        if (userKey) {
            logger.info(`收到 Chrome 进程 exit 信号 (user: ${userKey})，清理实例`);
            delete chromeInstances[userKey];
            delete instanceLastActivity[userKey];
        } else {
            logger.info('收到 Chrome 进程 exit 信号 (无 user)，清理实例');
        }
    });

    if (userKey) {
        instanceLastActivity[userKey] = Date.now();
    }

    logger.info(`启动新的 Chrome 实例 ${userKey ? `for user: ${userKey}` : '(无 user)'}`);
    logger.info(`当前活跃 Chrome 实例数量: ${getCurrentInstanceCount()}/${MAX_CONCURRENT_INSTANCES}`);

    return chrome;
};

// 创建一个 HTTP 服务器
const server = http.createServer(app);

// 监听 WebSocket 请求
server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const searchParams = url.searchParams;

    if (!searchParams.has('token')) {
        logger.error('Missing token parameter');
        socket.end('HTTP/1.1 400 Bad Request\r\n');
        return;
    }
    if (searchParams.get('token') !== token) {
        logger.error('Invalid token');
        socket.end('HTTP/1.1 403 Forbidden\r\n');
        return
    }

    if (!searchParams.has('startingUrl')) {
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

        // 合并 launch 参数
        const finalFlags = [...defaultFlags, ...launchFlags];

        const chromeOptions = {
            startingUrl: url.searchParams.get('startingUrl'),
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
                logger.info(`复用已存在的 Chrome 实例 for user: ${userKey}`);
                updateInstanceActivity(userKey);
            } else {
                if (reachedMaxInstances()) {
                    logger.error('已达到最大并发实例数量限制');
                    socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n已达到最大并发实例数量限制，请稍后再试');
                    return;
                }

                const userDataDir = path.join(os.homedir(), '.browser-go', 'browser_data', userKey);
                if (!fs.existsSync(userDataDir)) {
                    fs.mkdirSync(userDataDir, { recursive: true });
                }
                chromeOptions.userDataDir = userDataDir;
                chrome = await launchChromeInstance(chromeOptions, userKey);
                chromeInstances[userKey] = chrome; // 缓存 Chrome 实例
            }
        } else {
            if (reachedMaxInstances()) {
                logger.error('已达到最大并发实例数量限制');
                socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\n已达到最大并发实例数量限制，请稍后再试');
                return;
            }
            chrome = await launchChromeInstance(chromeOptions);
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        const debugPort = chrome.port;
        const res = await axios.get(`http://127.0.0.1:${debugPort}/json/version`);
        logger.info('Chrome launched:', res.data);
        const { webSocketDebuggerUrl } = res.data
        // 创建一个代理服务器对象
        const cdpProxy = httpProxy.createProxyServer({
            ws: true, // 启用 WebSocket 支持
        });
        cdpProxy.ws(req, socket, head, { changeOrigin: true, target: webSocketDebuggerUrl }, (err) => {
            if (err) {
                logger.error('WebSocket proxy error:', err);
                socket.end('HTTP/1.1 500 Internal Server Error\r\n');
            }
        });
        // 监听代理服务器的关闭事件
        cdpProxy.on('close', (req, socket, head) => {
            logger.info('WebSocket 连接已关闭');
            // chrome.kill(); // 注释掉 chrome.kill()
        });
    } catch (error) {
        logger.error('Failed to launch Chrome:', error);
        socket.end('HTTP/1.1 500 Internal Server Error\r\n');
    }
});

// 定义 GET /api/v1/browser/stop 接口
app.get('/api/v1/browser/stop', async (req, res) => {
    const userId = req.query.user_id;

    if (!userId) {
        return res.status(400).json({ code: -1, msg: '缺少 user_id 参数' });
    }

    if (chromeInstances[userId]) {
        try {
            await chromeInstances[userId].kill();
            delete chromeInstances[userId];
            delete instanceLastActivity[userId];
            res.json({ code: 0, msg: 'success' });
        } catch (error) {
            logger.error('关闭浏览器实例失败:', error);
            res.status(500).json({ code: -1, msg: '关闭浏览器实例失败' });
        }
    } else {
        res.status(404).json({ code: -1, msg: '未找到该 user_id 的浏览器实例' });
    }
});

// 定义 GET /api/v1/browser/list 接口
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

// 添加 GET /api/v1/browser/stats 接口查看系统状态
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

// 监听端口
server.listen(port, '0.0.0.0', () => {
    logger.info(`Server is running on http://0.0.0.0:${port}`);
    logger.info(`最大并发实例数: ${MAX_CONCURRENT_INSTANCES}`);
    logger.info(`实例超时时间: ${INSTANCE_TIMEOUT_MS / 60000} 分钟`);
    logger.info(`不活跃检查间隔: ${INACTIVE_CHECK_INTERVAL / 60000} 分钟`);
});