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

2. Install dependencies:
```bash
npm install
```

## Usage

### Starting the Service

```bash
node cli.js [options]
```

### Command Line Options

| Option | Description | Default |
|--------|-------------|---------|
| `--max-instances=<number>` | Maximum number of concurrent instances | 10 |
| `--instance-timeout=<minutes>` | Instance timeout in minutes | 60 |
| `--inactive-check-interval=<minutes>` | Interval for checking inactive instances in minutes | 5 |
| `--token=<string>` | Access token | 'browser-go-token' |
| `--help` | Show help information | - |

### Examples

```bash
# Start with default configuration
node cli.js

# Start with custom configuration
node cli.js --max-instances=5 --instance-timeout=30 --inactive-check-interval=2

# Set custom access token
node cli.js --token=my-secret-token
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
    "user": "user123",  // User identifier for session persistence
    "args": ["--window-size=1920,1080", "--lang=en-US"]  // Chrome launch arguments
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
├── cli.js          # Main entry point
├── logger.js       # Logging module
├── package.json    # Project configuration
└── README.md       # Project documentation
```

### Dependencies

- express: Web server framework
- chrome-launcher: Chrome browser launcher
- http-proxy: HTTP proxy
- axios: HTTP client

## License

MIT License