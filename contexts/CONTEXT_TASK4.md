# Task Context: TASK4
## Task Description
更新 tsconfig.json 以适应新的源码结构（`rootDir` 或 `include`）和输出目录 (`outDir`)。
## Implementation Details
- 将 `compilerOptions.rootDir` 从 `"./"` 修改为 `"./src"`。
- `compilerOptions.outDir` 保持 `"./dist"` 不变。
- `include` 保持 `["**/*.ts", "**/*.js"]` 不变，它将相对于新的 `rootDir` 解析。
## File Changes
- [`tsconfig.json`](tsconfig.json:1)
## Notes
确认 `include` 和 `exclude` 路径在新的 `rootDir`下仍然按预期工作。
## Status Summary
已完成。`rootDir` 已更新。
