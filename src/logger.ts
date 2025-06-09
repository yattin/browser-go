import winston, { Logger, format, transports } from 'winston';
import 'winston-daily-rotate-file';
import path from 'path';
import os from 'os';

// 创建日志目录
const logDir: string = path.join(os.homedir(), '.browser-go', 'logs');

// 定义日志格式
const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.errors({ stack: true }),
  format.splat(),
  format.json(),
);

// 创建 Winston logger 实例
const logger: Logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // 控制台输出
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message, ...meta }) => {
          return `[${timestamp as string}] [${level}]: ${message as string} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
        }),
      ),
    }),
    // 文件输出，使用 daily-rotate-file
    new transports.DailyRotateFile({
      dirname: logDir,
      filename: 'browser-go-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '10m', // 单个文件最大 10MB
      maxFiles: '10d', // 保留最近 10 天的日志
      format: format.combine(format.timestamp(), format.json()),
    }),
  ],
});

// 添加错误处理
logger.on('error', (error: Error) => {
  console.error('Logger error:', error);
});

// 导出 logger 实例
export { logger };
