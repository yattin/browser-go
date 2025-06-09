# Task Context: TASK6_Attempt1
## Task Description
验证 `npm run build` 是否能正确编译到 `dist` 目录。
## Implementation Details
执行 `npm run build` 命令。
## File Changes
N/A (命令执行)
## Notes
构建失败。错误信息：
`error TS5055: Cannot write file '/Users/holt/workplace/github-proj/browser-go/eslint.config.js' because it would overwrite input file.`
`error TS6059: File '/Users/holt/workplace/github-proj/browser-go/eslint.config.js' is not under 'rootDir' '/Users/holt/workplace/github-proj/browser-go/src'. 'rootDir' is expected to contain all source files.`
原因：[`tsconfig.json`](tsconfig.json:1) 中的 `"include": ["**/*.ts", "**/*.js"]` ([`tsconfig.json:113`](tsconfig.json:113)) 匹配了根目录的 [`eslint.config.js`](eslint.config.js:1)，而 `rootDir` ([`tsconfig.json:30`](tsconfig.json:30)) 已被设置为 `"./src"`。
## Status Summary
失败。需要调整 [`tsconfig.json`](tsconfig.json:1) 的 `include` 配置。