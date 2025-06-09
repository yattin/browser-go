# Project Implementation Plan
## Project Overview
将项目中的 TypeScript 源码迁移到 `src` 目录，调整编译配置和打包策略，确保 `npm pack` 只包含编译后的产物。
## Context Files
- contexts/CONTEXT_TASK1.md (completed)
- contexts/CONTEXT_TASK2.md (completed)
- contexts/CONTEXT_TASK3.md (completed)
- contexts/CONTEXT_TASK4.md (completed)
- contexts/CONTEXT_TASK5.md (completed)
- contexts/CONTEXT_TASK6_Attempt1.md (failed)
- contexts/CONTEXT_TASK6.md (completed)
- contexts/CONTEXT_TASK7_Attempt1.md (failed)
- contexts/CONTEXT_TASK7.md (completed)
## Subtask List
- [x] TASK1: 创建 `src` 目录。
- [x] TASK2: 识别项目根目录下的所有 `.ts` 文件 (cli.ts, logger.ts, test.ts, types.ts)。
- [x] TASK3: 将识别出的 `.ts` 文件移动到 `src` 目录。
- [x] TASK4: 更新 tsconfig.json 以适应新的源码结构（`rootDir` 或 `include`）和输出目录 (`outDir`)。
- [x] TASK5: 更新 package.json (main, bin, files, scripts) 以适应新的结构。
- [x] TASK6: 验证 `npm run build` 是否能正确编译到 `dist` 目录。
- [x] TASK7: 验证 `npm pack` 是否只包含 `dist` 目录和必要文件。
## Implementation Notes
- 编译输出目录将是 `dist`。
- 源码目录将是 `src`。
- `npm pack` 初步结果显示 `dist/eslint.config.js` 被打包，通过将 `tsconfig.json` 的 `allowJs` 设置为 `false` 并重新构建已解决。
