import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    ssr: true,
    rollupOptions: {
      // 只保留 Node.js 内置模块为外部依赖，打包所有第三方依赖
      external: (id) => {
        // Node.js 内置模块
        const builtins = [
          'fs', 'path', 'os', 'http', 'https', 'net', 'tls', 'stream',
          'url', 'util', 'events', 'crypto', 'child_process', 'zlib',
          'querystring', 'buffer', 'process', 'assert', 'async_hooks'
        ];
        
        // 检查是否是内置模块
        if (builtins.includes(id)) return true;
        
        // 检查是否是内置模块的子路径（如 fs/promises）
        if (builtins.some(builtin => id.startsWith(builtin + '/'))) return true;
        
        // 其他所有模块都打包进来
        return false;
      },
      input: resolve(__dirname, 'src/cli.ts'),
      output: {
        format: 'cjs',
        entryFileNames: 'browser-go.cjs',
        // 确保所有内容打包到一个文件中
        inlineDynamicImports: true
      }
    },
    // 输出目录
    outDir: 'dist-vite',
    // 清空输出目录
    emptyOutDir: true,
    // 目标为 Node.js
    target: 'node18',
    // 暂时禁用 minify 以便调试
    minify: false
  },
  // 解析配置
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  // 定义环境变量
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  // 确保所有依赖都被打包
  ssr: {
    noExternal: true
  }
});