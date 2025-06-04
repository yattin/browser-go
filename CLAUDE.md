# Project Configuration for Browser-Go (TypeScript Version)

This document outlines the build commands, code style guidelines, and project structure
for the Browser-Go project, now migrated to TypeScript. This information is intended
for AI coding agents (like yourself) to understand and interact with the codebase effectively.

## Build, Lint, and Test Commands

- **Build Project**: `pnpm run build`
  - Compiles TypeScript files from the root directory to JavaScript in the `./dist` directory.
- **Run Linter**:
    - `pnpm run lint`: Checks for linting issues.
    - `pnpm run lint:fix`: Checks and attempts to automatically fix linting issues.
  - ESLint is configured via `eslint.config.js` (which uses `FlatCompat` to load `.eslintrc.cjs`).
- **Run Tests**: `pnpm run test`
  - This command executes the compiled test script at `dist/test.js`.
  - To run a single test file (if applicable, depends on test runner): The current `test.ts` is a single script. If a test runner like Jest is integrated later, this command would change.
- **Start Application**: `pnpm run start`
  - This command executes the compiled main application script at `dist/cli.js`.
  - Alternatively, after building: `node dist/cli.js [options]`
- **Type Check**: `pnpm run build` (as it runs `tsc`) or `npx tsc --noEmit` for a dry run.

## Code Style Guidelines

- **Language**: TypeScript.
- **Formatting**: Enforced by Prettier. Configuration is in `.prettierrc.cjs`.
  - Key settings: 2 spaces for indentation, semicolons, single quotes.
- **Linting**: Enforced by ESLint with TypeScript support (`@typescript-eslint`). Configuration is in `eslint.config.js` and `.eslintrc.cjs`.
- **Naming Conventions**:
  - Variables and Functions: `camelCase`.
  - Interfaces and Types: `PascalCase`.
  - Classes and Constructors: `PascalCase`.
  - Constants: `UPPER_SNAKE_CASE`.
  - Enum members: `PascalCase`.
- **Error Handling**: Use try-catch blocks for synchronous errors. For asynchronous operations, handle promise rejections. Utilize custom error types if/when defined.
- **Logging**: Utilize the `logger.ts` module for application logging.
- **Imports**: Use ES module `import/export` syntax. Ensure type imports use `import type { ... } from '...'` where appropriate.
- **Type Safety**: Strive for strong type safety. Avoid `any` where possible; prefer `unknown` or more specific types. Use ESLint rule `@typescript-eslint/no-explicit-any` (currently set to 'warn' in `eslint.config.js`, consider 'error').

## Project Structure

```
browser-go/
├── cli.ts                # Main entry point (TypeScript)
├── logger.ts             # Logging module (TypeScript)
├── types.ts              # TypeScript type definitions for API and internal structures
├── test.ts               # Test script (TypeScript)
├── dist/                 # Compiled JavaScript output from TypeScript
│   ├── cli.js
│   ├── logger.js
│   ├── types.js
│   └── test.js
├── tsconfig.json         # TypeScript compiler configuration
├── eslint.config.js      # ESLint configuration (flat config, new default)
├── .eslintrc.cjs         # ESLint legacy configuration (used by FlatCompat in eslint.config.js)
├── .prettierrc.cjs       # Prettier code formatter configuration
├── package.json          # Project dependencies and scripts
├── pnpm-lock.yaml        # PNPM lock file for consistent installs
├── openapi.yaml          # OpenAPI specification for the API
├── README.md             # Project documentation (English)
├── README.zh-CN.md       # Project documentation (Chinese)
├── CLAUDE.md             # This configuration file for AI agents
└── contexts/             # Directory for /flow mode context files
    └── ...
