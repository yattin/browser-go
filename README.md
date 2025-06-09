# Browser-Go

Browser-Go is a Chrome DevTools Protocol (CDP) based browser management service that provides WebSocket-based Chrome instance proxying with automatic lifecycle management, user session persistence, and RESTful APIs for instance control.

[中文文档](README.zh-CN.md)

## Features

- **Multi-user concurrent access** with configurable instance limits
- **WebSocket proxy** to Chrome DevTools Protocol endpoints  
- **Automatic lifecycle management** with timeout-based cleanup
- **User session persistence** via dedicated Chrome user data directories
- **RESTful API** for instance control (stop, list, stats)
- **Swagger UI documentation** at `/api-docs`
- **Multiple deployment options** including standalone executables
- **TypeScript** implementation with comprehensive type safety
- **Structured logging** with daily rotation and console/file output

## System Requirements

- **Node.js 18.0+** (required for Single Executable Applications)
- **Chrome browser** (automatically detected)
- **Operating System**: Windows/Linux/macOS
- **Package Manager**: pnpm (recommended, specified in packageManager field)

## Installation

### Option 1: From Source

1. Clone the repository:
```bash
git clone https://github.com/yattin/browser-go.git
cd browser-go
```

2. Install dependencies:
```bash
pnpm install
```

3. Build the project:
```bash
pnpm run build
```

### Option 2: Download Binaries

Download pre-built binaries from the [Releases](https://github.com/yattin/browser-go/releases) page:
- `browser-go-sea-linux` (Linux)
- `browser-go-sea-windows.exe` (Windows) 
- `browser-go-sea-macos` (macOS)

## Usage

### Starting the Service

#### From Source Build
```bash
# Build and start
pnpm run build
node dist/cli.js [options]

# Or use the start script
pnpm run start -- [options]
```

#### From Binary
```bash
# Linux/macOS
./browser-go-sea-linux [options]

# Windows
browser-go-sea-windows.exe [options]
```

### Command Line Options

| Option                                | Description                                         | Default            |
| ------------------------------------- | --------------------------------------------------- | ------------------ |
| `--max-instances=<number>`            | Maximum number of concurrent instances              | 10                 |
| `--instance-timeout=<minutes>`        | Instance timeout in minutes                         | 60                 |
| `--inactive-check-interval=<minutes>` | Interval for checking inactive instances in minutes | 5                  |
| `--token=<string>`                    | Access token for authentication                     | 'browser-go-token' |
| `--help`                              | Show help information                               | -                  |

### Examples

```bash
# Start with default configuration
node dist/cli.js
# or using binary
./browser-go-sea-linux

# Start with custom configuration  
node dist/cli.js --max-instances=5 --instance-timeout=30 --inactive-check-interval=2

# Set custom access token
node dist/cli.js --token=my-secret-token

# Using pnpm start script with options
pnpm run start -- --max-instances=5 --token=custom-token
```

## API Reference

The service provides both WebSocket and RESTful API endpoints. Complete API documentation is available at `/api-docs` (Swagger UI) when the service is running.

### WebSocket Connection (Browser Launch)

Launch a browser instance via WebSocket connection with two supported URL formats:

#### 1. Query String Format
```
ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
```

#### 2. Path Format  
```
ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
```

**Parameters:**
- `token`: Access token for authentication (required)
- `startingUrl`: URL to open after browser launch (required, URL-encoded in path format)
- `launch`: JSON format launch parameters (optional, query parameter only)

**Launch Parameters Example:**
```json
{
  "user": "user123", 
  "args": ["--window-size=1920,1080", "--lang=en-US", "--disable-web-security"]
}
```

**User Session Persistence:** When a `user` parameter is provided, Chrome instances are cached and reused for subsequent connections from the same user. User data is stored in `~/.browser-go/browser_data/<user_id>/`.

### RESTful API Endpoints

#### Stop Browser Instance
```http
GET /api/v1/browser/stop?user_id=<user_id>
```
Stops a specific browser instance for the given user.

#### List Active Instances  
```http
GET /api/v1/browser/list
```
Returns all active browser instances with activity data and system statistics.

#### System Statistics
```http
GET /api/v1/browser/stats  
```
Returns current system status including instance counts, limits, and configuration.

#### API Documentation
```http
GET /api-docs
```
Interactive Swagger UI documentation for all endpoints.

```http
GET /openapi.json
```
OpenAPI 3.0 specification in JSON format.

## Configuration

### Instance Management

- **Maximum Concurrent Instances**: Controls the maximum number of browser instances that can run simultaneously. New connection requests will be rejected when this limit is reached.
- **Instance Timeout**: Maximum survival time for browser instances in inactive state (default: 60 minutes). Instances will be automatically closed after this time.
- **Inactive Check Interval**: How often the system checks for inactive instances (default: 5 minutes). Adjust based on your usage patterns.
- **Access Token**: Token used to authenticate client requests. Use a strong random value in production.

### File Locations

- **User Data**: `~/.browser-go/browser_data/<user_id>/` - Chrome user data directories
- **Logs**: `~/.browser-go/logs/browser-go-YYYY-MM-DD.log` - Daily rotated logs (10 days retention, 10MB max per file)

### Logging

Structured logging with Winston featuring:
- **Console output**: Colorized format for development
- **File output**: Daily rotation with automatic cleanup
- **Log levels**: Error, warn, info, debug

## Production Deployment

### Performance Considerations

1. **Memory Requirements**: Ensure sufficient system memory for running multiple Chrome instances (recommended: 2GB+ per 10 instances)
2. **Reverse Proxy**: Use Nginx or similar for load balancing and SSL termination
3. **Process Management**: Use PM2, systemd, or Docker for process supervision
4. **Monitoring**: Regularly check logs and `/api/v1/browser/stats` endpoint

### Security Recommendations

1. Use strong, unique access tokens in production
2. Consider network-level access controls
3. Monitor resource usage and set appropriate limits
4. Regular log review for suspicious activity

## Development

### Project Structure

```
browser-go/
├── src/                    # TypeScript source code
│   ├── cli.ts             # Main entry point 
│   ├── logger.ts          # Winston-based logging module
│   ├── types.ts           # TypeScript type definitions
│   └── test.ts            # Test script
├── dist/                   # Compiled JavaScript output (tsc)
├── dist-vite/              # Bundled output (Vite)
├── binary/                 # Built executable files
├── .github/workflows/      # GitHub Actions CI/CD
├── openapi.yaml           # API specification
├── sea-config.json        # Single Executable Application config
├── vite.config.ts         # Vite bundler configuration
├── tsconfig.json          # TypeScript compiler configuration
├── eslint.config.js       # ESLint configuration (flat config)
├── .prettierrc.cjs        # Prettier configuration
├── package.json           # Project configuration
└── pnpm-lock.yaml         # PNPM lock file
```

### Build System

The project uses a **dual build system**:

1. **TypeScript Compilation** (`pnpm run build`): Direct tsc compilation for development
2. **Vite Bundling** (`pnpm run build:bundle`): Creates optimized single-file bundles for distribution

### Development Scripts

#### Core Development
- `pnpm run build` - Compile TypeScript to JavaScript
- `pnpm run start` - Start the compiled application  
- `pnpm run test` - Run tests
- `pnpm run lint` - Lint code
- `pnpm run lint:fix` - Lint and auto-fix issues

#### Binary Generation
- `pnpm run build:sea:macos` - Build macOS SEA executable
- `pnpm run build:sea:windows` - Build Windows SEA executable  
- `pnpm run build:sea:linux` - Build Linux SEA executable
- `pnpm run build:binary:all` - Build PKG binaries (legacy)

#### Bundling
- `pnpm run build:bundle` - Create single-file bundle with Vite

### Code Style & Quality

- **TypeScript**: Full type safety with strict configuration
- **ESLint**: Code linting with TypeScript support
- **Prettier**: Code formatting (2 spaces, single quotes, semicolons)
- **Naming Conventions**: camelCase for variables/functions, PascalCase for types/classes

### Dependencies

#### Runtime Dependencies
- **express** - Web server framework
- **chrome-launcher** - Chrome browser launcher  
- **ws** - WebSocket implementation
- **http-proxy** - HTTP proxying
- **winston** - Structured logging
- **swagger-ui-express** - API documentation
- **uuid** - Unique identifier generation

#### Development Dependencies  
- **typescript** - TypeScript compiler
- **vite** - Fast bundler
- **eslint** - Code linting
- **prettier** - Code formatting
- **pkg** - Binary packaging (legacy)
- **postject** - SEA binary injection

### Automated Builds

GitHub Actions automatically builds SEA executables for all platforms:

- **Triggers**: Push to `main`/`ts` branches, version tags (`v*`), or pull requests to `main`
- **Platforms**: Linux, Windows, macOS  
- **Artifacts**: Available for 30 days after build completion
- **Releases**: Automatically created for version tags with all platform binaries attached

The build workflow is defined in `.github/workflows/build-sea.yml`.

### Single Executable Applications (SEA)

The project supports Node.js 20+ SEA for creating standalone executables:

- **Configuration**: `sea-config.json` 
- **Advantages**: Official Node.js solution, no external dependencies
- **Replaces**: Third-party tools like PKG for better compatibility and performance

## License

ISC License
