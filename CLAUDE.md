# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-Go is a Chrome DevTools Protocol (CDP) based browser management service that supports multi-user concurrent access and session management. It provides WebSocket-based Chrome instance proxying with automatic lifecycle management, user session persistence, and RESTful APIs for instance control.

### Core Architecture

The application consists of three main components:

1. **Main Service (`src/cli.ts`)**: Express server with WebSocket upgrade handling for Chrome instance proxying
2. **Logger (`src/logger.ts`)**: Winston-based logging with daily rotation and console/file output
3. **Type Definitions (`src/types.ts`)**: TypeScript interfaces for API responses, configuration, and internal data structures

### Key Features

- Multi-user concurrent Chrome instance management with configurable limits
- WebSocket proxy to Chrome DevTools Protocol endpoints
- Automatic cleanup of inactive instances based on timeout
- User session persistence via dedicated Chrome user data directories
- RESTful API for instance control (stop, list, stats)
- Swagger UI documentation at `/api-docs`

## Build, Lint, and Test Commands

- **Build Project**: `pnpm run build`
  - Compiles TypeScript files from the root directory to JavaScript in the `./dist` directory.
- **Build Bundle**: `pnpm run build:bundle`
  - Creates optimized bundled version using Vite at `./dist-vite/browser-go.cjs`.
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

## Binary Generation Commands

### Traditional PKG Binary Generation (Legacy)
- **Build Binary for macOS**: `pnpm run build:binary:macos`
- **Build Binary for Windows**: `pnpm run build:binary:windows`  
- **Build Binary for All Platforms**: `pnpm run build:binary:all`

### Node.js SEA (Single Executable Applications) - Recommended
- **Prepare SEA Bundle**: `pnpm run build:sea:prep`
  - Creates the application bundle and generates `sea-prep.blob` file.
- **Build SEA for macOS**: `pnpm run build:sea:macos`
  - Creates `binary/browser-go-sea-macos` using Node.js official SEA.
- **Build SEA for Windows**: `pnpm run build:sea:windows`
  - Creates `binary/browser-go-sea-windows.exe` using Node.js official SEA.
- **Build SEA for Linux**: `pnpm run build:sea:linux`
  - Creates `binary/browser-go-sea-linux` using Node.js official SEA.

**Note**: SEA (Single Executable Applications) is the official Node.js solution for creating standalone executables, replacing third-party tools like PKG. SEA requires Node.js 20+ and uses the `sea-config.json` configuration file.

## Automated Builds

GitHub Actions automatically builds SEA executables for all platforms:

- **Trigger**: Push to `main`/`ts` branches, tags starting with `v*`, or pull requests to `main`
- **Platforms**: Linux, Windows, macOS
- **Artifacts**: Available for 30 days after build completion
- **Releases**: Automatically created for version tags with all platform binaries attached

The build workflow is defined in `.github/workflows/build-sea.yml`.

## WebSocket Connection Formats

The service supports two WebSocket URL formats for browser instance launching:

1. **Query String Format**:
   ```
   ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
   ```

2. **Path Format**:
   ```
   ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
   ```

Launch parameters (`launch`) are JSON-formatted and include:
- `user`: User identifier for session persistence (creates dedicated Chrome user data directory)
- `args`: Chrome launch arguments array (e.g., `["--window-size=1920,1080", "--lang=en-US"]`)

## Instance Management

- **Session Persistence**: When a `user` parameter is provided, Chrome instances are cached and reused for subsequent connections from the same user
- **User Data Directories**: Located at `~/.browser-go/browser_data/<user_id>/`
- **Automatic Cleanup**: Inactive instances are cleaned up based on configurable timeout (default: 60 minutes)
- **Concurrent Limits**: Configurable maximum concurrent instances (default: 10)

## API Endpoints

- `GET /api/v1/browser/stop?user_id=<id>` - Stop specific browser instance
- `GET /api/v1/browser/list` - List all active instances with activity data
- `GET /api/v1/browser/stats` - System statistics and configuration
- `GET /api-docs` - Swagger UI documentation
- `GET /openapi.json` - OpenAPI specification

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

## Build System

The project uses a dual build system:

1. **TypeScript Compilation** (`pnpm run build`): Direct tsc compilation from `src/` to `dist/`
2. **Vite Bundling** (`pnpm run build:bundle`): Creates a single bundled CommonJS file at `dist-vite/browser-go.cjs`

### Vite Configuration

- **Target**: Node.js 18+ with CommonJS output
- **Bundling Strategy**: Packages all third-party dependencies, excludes only Node.js built-ins
- **Entry Point**: `src/cli.ts` → `dist-vite/browser-go.cjs`
- **External Dependencies**: Only Node.js built-in modules (fs, path, http, etc.)

## YAML Parsing

The application includes a custom simple YAML parser (`parseSimpleYaml()` in `src/cli.ts`) for loading the OpenAPI specification. This lightweight parser handles basic YAML structures and should be considered when modifying `openapi.yaml`.

## Logging Configuration

Logs are written to:
- **Console**: Colorized format for development
- **Files**: `~/.browser-go/logs/browser-go-YYYY-MM-DD.log` with daily rotation
- **Retention**: 10 days, 10MB per file maximum

## Error Handling Patterns

- WebSocket errors are handled gracefully with proper socket cleanup
- Chrome instance failures trigger automatic cleanup of cached instances
- All API endpoints return consistent JSON response format with `code`, `msg`, and optional `data` fields
