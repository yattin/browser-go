# Task Context: TASK1

## Task Description

TypeScript 环境搭建与核心配置。目标是为项目引入 TypeScript 支持，包括必要的依赖安装、配置文件创建以及构建和 linting 脚本的设置。项目将采用编译到 JavaScript 后执行的策略，不使用 `ts-node`。

## Implementation Details

1.  **依赖安装**: 使用 `pnpm` 安装了以下开发依赖：
    - `typescript`
    - `@types/node`
    - `@types/express`
    - `@types/http-proxy`
    - `@types/uuid`
    - `@types/ws`
    - `@types/yamljs`
    - `@types/swagger-jsdoc`
    - `@types/swagger-ui-express`
    - `eslint`
    - `@typescript-eslint/parser`
    - `@typescript-eslint/eslint-plugin`
    - `eslint-config-prettier`
    - `eslint-plugin-prettier`
    - `prettier`
2.  **TypeScript 配置 (`tsconfig.json`)**:
    - 通过 `npx tsc --init` 生成初始文件。
    - 修改配置以适应项目需求：
      - `target`: `"es2020"`
      - `module`: `"nodenext"`
      - `moduleResolution`: `"nodenext"`
      - `outDir`: `"./dist"`
      - `rootDir`: `"./"`
      - `sourceMap`: `true`
      - `allowJs`: `true`
      - `include`: `["**/*.ts", "**/*.js"]`
      - `exclude`: `["node_modules", "dist"]`
3.  **ESLint 配置 (`.eslintrc.js`)**:
    - 创建了 `.eslintrc.js` 文件。
    - 配置了 `@typescript-eslint/parser` 和相关插件/扩展。
    - 将 `prettier/prettier` 设置为错误。
    - 指定了 `project: './tsconfig.json'`。
    - 忽略了 `node_modules/`, `dist/`, `.eslintrc.js`。
4.  **Prettier 配置 (`.prettierrc.js`)**:
    - 创建了 `.prettierrc.js` 文件。
    - 配置了基本的格式化规则（`semi`, `trailingComma`, `singleQuote`, `printWidth`, `tabWidth`）。
5.  **`package.json` 脚本更新**:
    - 修改了 `start` 和 `test` 脚本以指向 `dist` 目录中的编译后文件。
    - 添加了 `build` 脚本: `"tsc"`。
    - 添加了 `lint` 脚本: `"eslint . --ext .ts,.js"`。
    - 添加了 `lint:fix` 脚本: `"eslint . --ext .ts,.js --fix"`。

## File Changes

- **Created**:
  - [`tsconfig.json`](../tsconfig.json:1)
  - [`.eslintrc.js`](../.eslintrc.js:1)
  - [`.prettierrc.js`](../.prettierrc.js:1)
  - `contexts/` (directory)
- **Modified**:
  - [`package.json`](../package.json:1) (devDependencies, scripts)

## Notes

- 项目现在配置为将 TypeScript 文件编译到 `./dist` 目录。
- ESLint 和 Prettier 已配置为与 TypeScript 一起工作。
- 后续步骤将涉及将现有的 `.js` 文件迁移到 `.ts`。

## Status Summary

TASK1 已完成。TypeScript 开发环境、编译流程和 linting 工具已成功配置。
下一个任务是 TASK2: 核心文件迁移 - `cli.js`。
