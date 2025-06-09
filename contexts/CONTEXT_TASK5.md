# Task Context: TASK5
## Task Description
更新 package.json (main, bin, files, scripts) 以适应新的结构。
## Implementation Details
- 修改 `main` 字段从 `"cli.js"` 为 `"dist/cli.js"`。
- 修改 `bin` 字段中 `"browser-go"` 的路径从 `"cli.js"` 为 `"dist/cli.js"`。
- 添加 `files` 字段: `"files": ["dist"]`。
- `scripts` 字段中的 `start`, `test`, `build` 保持不变，因为它们已经指向或使用 `dist` 目录或与源码位置无关。`lint` 脚本暂时未修改。
## File Changes
- [`package.json`](package.json:1)
## Notes
确认所有路径都指向编译后的 `dist` 目录中的相应文件。
## Status Summary
已完成。[`package.json`](package.json:1) 已更新以反映新的项目结构和打包要求。
