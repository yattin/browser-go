# Browser-Go

Browser-Go is a Chrome DevTools Protocol (CDP) based browser management service that supports multi-user concurrent access and session management.

[中文文档](README.zh-CN.md)

## Features

- Multi-user concurrent access support
- Automatic browser instance lifecycle management
- User session persistence
- Automatic cleanup of inactive instances
- RESTful API interface
- WebSocket connection support

## System Requirements

- Node.js 16.0 or higher
- Chrome browser
- Operating System: Windows/Linux/macOS

## Installation

1. Clone the repository:

```bash
git clone https://github.com/yattin/browser-go.git
cd browser-go
```

2. Install dependencies (pnpm is specified in package.json):

```bash
pnpm install
```

3. Build the project:

```bash
pnpm run build
```

## Usage

### Starting the Service

First, ensure you have built the project:
```bash
pnpm run build
```

Then, run the compiled JavaScript file:
```bash
node dist/cli.js [options]
```

### Command Line Options

| Option                                | Description                                         | Default            |
| ------------------------------------- | --------------------------------------------------- | ------------------ |
| `--max-instances=<number>`            | Maximum number of concurrent instances              | 10                 |
| `--instance-timeout=<minutes>`        | Instance timeout in minutes                         | 60                 |
| `--inactive-check-interval=<minutes>` | Interval for checking inactive instances in minutes | 5                  |
| `--token=<string>`                    | Access token                                        | 'browser-go-token' |
| `--help`                              | Show help information                               | -                  |

### Examples

Ensure the project is built first (`pnpm run build`).

```bash
# Start with default configuration
node dist/cli.js

# Start with custom configuration
node dist/cli.js --max-instances=5 --instance-timeout=30 --inactive-check-interval=2

# Set custom access token
node dist/cli.js --token=my-secret-token
```

## API Reference

### 1. Launch Browser Instance

Launch a browser instance via WebSocket connection:

Two URL formats are supported:

1. Query String Format:

```
ws://localhost:3000?token=<token>&startingUrl=<url>&launch=<launch_args>
```

2. Path Format:

```
ws://localhost:3000/startingUrl/<url>/token/<token>?launch=<launch_args>
```

Parameters:

- `token`: Access token
- `startingUrl`: URL to open after browser launch (URL-encoded in path format)
- `launch`: JSON format launch parameters (optional, only supported as query parameter)
  ```json
  {
    "user": "user123", // User identifier for session persistence
    "args": ["--window-size=1920,1080", "--lang=en-US"] // Chrome launch arguments
  }
  ```

### 2. Stop Browser Instance

```
GET /api/v1/browser/stop?user_id=<user_id>
```

### 3. List All Instances

```
GET /api/v1/browser/list
```

### 4. View System Status

```
GET /api/v1/browser/stats
```

## Configuration

### Maximum Concurrent Instances

Controls the maximum number of browser instances that can run simultaneously. New connection requests will be rejected when this limit is reached.

### Instance Timeout

Maximum survival time for browser instances in inactive state. Instances will be automatically closed after this time.

### Check Interval

Time interval for the system to check inactive instances. Adjust this value based on your actual usage.

### Access Token

Token used to authenticate client requests. Use a strong random value in production environment.

## Notes

1. Ensure sufficient system memory for running multiple Chrome instances
2. Recommended to use a reverse proxy (e.g., Nginx) for load balancing in production
3. Regularly check log files to monitor system status
4. Adjust configuration parameters based on actual needs

## Development

### Project Structure

```
browser-go/
├── cli.ts                # Main entry point (TypeScript)
├── logger.ts             # Logging module (TypeScript)
├── types.ts              # TypeScript type definitions
├── test.ts               # Test script (TypeScript)
├── dist/                 # Compiled JavaScript output
│   ├── cli.js
│   ├── logger.js
│   └── ...
├── tsconfig.json         # TypeScript compiler configuration
├── eslint.config.js      # ESLint configuration (flat config)
├── .eslintrc.cjs         # ESLint legacy config (used by FlatCompat)
├── .prettierrc.cjs       # Prettier configuration
├── package.json          # Project configuration
├── pnpm-lock.yaml        # PNPM lock file
└── README.md             # Project documentation
```

### Development Environment

The project is now written in TypeScript. Key development scripts in `package.json`:

- `pnpm run build`: Compiles TypeScript to JavaScript in the `dist` directory.
- `pnpm run lint`: Lints TypeScript and JavaScript files.
- `pnpm run lint:fix`: Lints and attempts to automatically fix issues.
- `pnpm run start`: Starts the compiled application (after building).
- `pnpm run test`: Runs the test script (after building).

### Dependencies

- express: Web server framework
- chrome-launcher: Chrome browser launcher
- http-proxy: HTTP proxy
- axios: HTTP client

## License

MIT License
