# Task Context: TASK7
## Task Description
验证 `npm pack` 是否只包含 `dist` 目录和必要文件 (修复 `dist` 目录中意外文件的问题)。
## Implementation Details
- **Attempt 1 (Initial Pack)**: `npm pack` 的输出显示 `dist/eslint.config.js` 和 `dist/eslint.config.js.map` 被包含。
- **Attempt 2 (Fix)**:
    - 修改 `tsconfig.json`，将 `compilerOptions.allowJs` ([`tsconfig.json:50`](tsconfig.json:50)) 从 `true` 改为 `false`。
    - 删除 `dist` 目录 (`rm -rf dist`)。
    - 重新运行 `npm run build`。
    - 重新运行 `npm pack`。
- **Attempt 3 (Verification)**: `npm pack` 执行成功，输出的 `Tarball Contents` 显示只有 `dist` 目录中由 TypeScript 编译生成的文件以及 [`package.json`](package.json:1) 和 `README` 文件。`dist/eslint.config.js` 不再被打包。
## File Changes
- [`tsconfig.json`](tsconfig.json:1) (修改 `allowJs` 为 `false`)
## Notes
将 `allowJs` 设置为 `false` 是关键，以防止 TypeScript 编译器处理或复制项目根目录下的 JavaScript 文件到 `dist` 目录。
## Status Summary
已完成。`npm pack` 现在只包含预期的编译产物。