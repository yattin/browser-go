# Task Context: TASK7_Attempt1
## Task Description
验证 `npm pack` 是否只包含 `dist` 目录和必要文件。
## Implementation Details
执行 `npm pack` 命令。
## File Changes
N/A (命令执行)
## Notes
`npm pack` 执行成功，但输出的 `Tarball Contents` 显示 `dist/eslint.config.js` 和 `dist/eslint.config.js.map` 被包含在内，这是不期望的。
这可能是因为 `tsconfig.json` 中的 `compilerOptions.allowJs` ([`tsconfig.json:50`](tsconfig.json:50)) 设置为 `true`，导致根目录的 JS 文件也被处理并复制到了 `dist` 目录。
## Status Summary
失败。需要修改 `tsconfig.json` 中的 `allowJs` 设置，并重新构建和打包。