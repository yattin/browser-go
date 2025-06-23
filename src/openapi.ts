/**
 * OpenAPI specification loading and YAML parsing utilities
 */

import fs from 'fs';
import { getAsset, isSea } from 'node:sea';
import { logger } from './logger.js';

// 简单的 YAML 解析函数
export function parseSimpleYaml(content: string): any {
  // 这是一个非常简化的 YAML 解析器，仅用于基本的 OpenAPI 文件
  // 在生产环境中应该使用更完整的 YAML 解析库
  try {
    const lines = content.split('\n');
    const result: any = {};
    let currentPath: any = result;
    let indentStack: any[] = [result];
    let indentLevels: number[] = [0];

    for (const line of lines) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;

      const match = line.match(/^(\s*)([^:]+):\s*(.*)$/);
      if (match) {
        const [, indent, key, value] = match;
        const indentLevel = indent.length;

        // 调整缩进栈
        while (indentLevels.length > 1 && indentLevel <= indentLevels[indentLevels.length - 1]) {
          indentLevels.pop();
          indentStack.pop();
        }

        currentPath = indentStack[indentStack.length - 1];

        if (value.trim() === '') {
          // 这是一个对象
          currentPath[key.trim()] = {};
          indentStack.push(currentPath[key.trim()]);
          indentLevels.push(indentLevel);
        } else {
          // 这是一个值
          let parsedValue: any = value.trim();
          if (parsedValue === 'true') parsedValue = true;
          else if (parsedValue === 'false') parsedValue = false;
          else if (/^\d+$/.test(parsedValue)) parsedValue = parseInt(parsedValue);
          else if (/^\d+\.\d+$/.test(parsedValue)) parsedValue = parseFloat(parsedValue);
          else if (parsedValue.startsWith('"') && parsedValue.endsWith('"')) {
            parsedValue = parsedValue.slice(1, -1);
          }

          currentPath[key.trim()] = parsedValue;
        }
      }
    }

    return result;
  } catch (error) {
    logger.error('Simple YAML parsing failed:', error);
    return createDefaultOpenApiSpec();
  }
}

// 创建默认的 OpenAPI 规范
export function createDefaultOpenApiSpec(): any {
  return {
    openapi: '3.0.0',
    info: { title: 'Browser-Go API', version: '1.0.0' },
    paths: {}
  };
}

// 加载 OpenAPI 规范
export function loadOpenApiSpec(): any {
  try {
    // 如果是 Sea 环境，尝试从资源中获取 openapi.yaml
    // 否则从本地文件系统读取
    const yamlContent = isSea() 
      ? getAsset('openapi.yaml', 'utf8') 
      : fs.readFileSync('./openapi.yaml', 'utf8');
    
    return parseSimpleYaml(yamlContent);
  } catch (error) {
    // 如果加载失败，记录警告并提示只显示空白接口文档
    logger.warn('Failed to load OpenAPI specification from openapi.yaml, using default empty spec.');
    return createDefaultOpenApiSpec();
  }
}