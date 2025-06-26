# Testing Guide

This guide explains how to run tests and handle common testing issues in Browser-Go.

## Quick Start

### Recommended Commands

```bash
# Run simplified E2E test (fastest, most reliable - recommended for CI/CD)
pnpm run test:e2e:simple

# Run E2E tests with automatic cleanup
pnpm run test:e2e:clean

# Run any test with enhanced cleanup
pnpm run test:safe

# Clean up environment manually
pnpm run cleanup
```

## Test Commands

### Basic Tests
- `pnpm run test:bridge` - Test CDP bridge functionality (unit test)
- `pnpm run test:e2e` - Complete end-to-end test with real Chrome and extension
- `pnpm run test:e2e:simple` - Simplified E2E test with improved stability
- `pnpm run test:patchright` - Playwright compatibility testing
- `pnpm run test:stability` - Multi-device connection stability test (no real browsers)

### Simplified E2E Test (Recommended)

The simplified E2E test (`pnpm run test:e2e:simple`) is designed for maximum reliability and focuses on core functionality:

**✅ What it tests:**
- Server health and startup
- Device registration and heartbeat
- Basic CDP connection and commands
- Multi-device connection handling (when available)
- Concurrent message processing

**✅ Key improvements over full E2E:**
- **100% success rate** - No frame detachment issues
- **Faster execution** - Completes in ~2 minutes
- **Stable connections** - Sequential rather than concurrent testing
- **Smart fallbacks** - Gracefully handles single-device scenarios
- **Focused testing** - Core CDP functionality without complex navigation

**📊 Current Results:**
```
📊 Simplified E2E Test Results:
===============================
✅ PASS Server Health
✅ PASS Device Registration  
✅ PASS Basic CDP Connection
✅ PASS Bing Search & Screenshot
✅ PASS Concurrent Messaging

Overall: 5/5 tests passed (100% success rate)
```

**🔍 New Bing Search Test Features:**
- **Real-world navigation** to bing.com
- **Random search term generation** from 15 predefined technical topics
- **Automatic search execution** with form filling and submission
- **Full-page screenshots** saved to `.test_result/` directory
- **Robust error handling** with retry logic for navigation failures
- **Search result validation** to confirm successful completion

**📁 Screenshot Output:**
Screenshots are automatically saved with descriptive filenames:
```
.test_result/bing-search-client-{ID}-{timestamp}.png
```
Example: `bing-search-client-1-2025-06-26T08-09-39-308Z.png`

### Multi-Device Stability Test

The multi-device stability test (`pnpm run test:stability`) focuses on connection robustness without real browsers:

**🔧 What it tests:**
- Simultaneous device registration (5 simulated devices)
- Device ID conflict resolution and proper cleanup
- Concurrent CDP message routing and response handling
- Connection resilience under stress (disconnect/reconnect cycles)

**⚡ Key advantages:**
- **Fast execution** - Completes in ~90 seconds
- **No browser dependencies** - Pure WebSocket simulation  
- **Targeted testing** - Focuses specifically on connection stability
- **Conflict detection** - Tests edge cases that are hard to reproduce manually

**📊 Example Results:**
```
📊 Multi-Device Stability Test Results:
=======================================
✅ PASS Simultaneous Device Registration
✅ PASS Device ID Conflict Resolution
✅ PASS Concurrent Message Routing
✅ PASS Connection Resilience

Overall: 4/4 tests passed
```

### Enhanced Tests (with cleanup)
- `pnpm run test:e2e:clean` - E2E test with automatic cleanup
- `pnpm run test:safe` - Enhanced test runner with automatic cleanup

### Cleanup Commands
- `pnpm run cleanup` - Clean up ports, processes, and temporary files
- `scripts/cleanup-test-env.sh` - Direct cleanup script execution

## Common Issues and Solutions

### Port 3000 Already in Use

**Problem**: Test fails with "Port 3000 is already in use"

**Solution**: 
```bash
# Clean up the environment
pnpm run cleanup

# Then run your test
pnpm run test:e2e
```

### Chrome Processes Not Cleaned Up

**Problem**: Chrome processes from previous tests are still running

**Solution**:
```bash
# The cleanup script handles this automatically
pnpm run cleanup

# Or use the enhanced test runner
pnpm run test:safe --type e2e
```

### Test Hangs or Times Out

**Problem**: Test appears to hang or doesn't complete

**Solution**:
```bash
# Kill all related processes and clean up
pnpm run cleanup

# Use the safe test runner which handles interruptions
pnpm run test:safe
```

## Manual Cleanup

If automatic cleanup doesn't work, you can manually clean up:

### Kill Processes Using Port 3000
```bash
# Find processes using port 3000
lsof -i :3000

# Kill them
kill -9 <PID>
```

### Kill Chrome Extension Processes
```bash
# macOS/Linux
pkill -f "chrome.*extension"

# Or more specific
pkill -f "chrome.*load-extension"
```

### Clean Up Directories
```bash
# Remove runtime directories
rm -rf .runtime

# Clean build artifacts
pnpm run clean
```

## Advanced Usage

### Enhanced Test Runner Options

```bash
# Run with verbose output
scripts/test-with-cleanup.sh --type e2e --verbose

# Run specific test types
scripts/test-with-cleanup.sh --type bridge
scripts/test-with-cleanup.sh --type patchright
scripts/test-with-cleanup.sh --type e2e
```

### Cleanup Script Details

The cleanup script (`scripts/cleanup-test-env.sh`) performs:

1. ✅ Kills processes using port 3000
2. ✅ Terminates browser-go server processes
3. ✅ Stops test runner processes
4. ✅ Cleans up Chrome extension processes
5. ✅ Platform-specific Chrome cleanup
6. ✅ Removes runtime directories
7. ✅ Cleans temporary files
8. ✅ Clears node_modules cache
9. ✅ Verifies port 3000 is free

## Test Environment

### Isolated User Data Directories

All tests use isolated user data directories to prevent cross-test contamination:

- Main E2E tests: `.runtime/test-e2e-main/`
- Multi-device tests: `.runtime/test-device-0/`, `.runtime/test-device-1/`, etc.
- Playwright tests: `.runtime/test-patchright/`
- Manual testing: `.runtime/` (via `pnpm run open:browser`)

### Current Test Results

As of the latest run, Browser-Go achieves **13/14 tests passing (93% success rate)**:

```
📊 Test Results Summary:
✅ PASS Server Startup
✅ PASS Server Health Check
✅ PASS Chrome with Extension Launch
✅ PASS Device Registration
✅ PASS CDP Connection
✅ PASS Connection Health
✅ PASS Browser Domain Methods
✅ PASS Target Domain Methods
✅ PASS Message Type Identification
✅ PASS Page Navigation
✅ PASS Multi-Device Setup
❌ FAIL Multi-Device Playwright Connections (frame detachment issue)
✅ PASS Device Isolation & Routing
✅ PASS Concurrent Message Handling
```

## Troubleshooting

### If Tests Still Fail After Cleanup

1. **Restart your terminal** - Sometimes environment variables persist
2. **Check for system-level Chrome processes** - System Chrome might interfere
3. **Verify Node.js version** - Ensure you're using Node.js 18+
4. **Check file permissions** - Ensure scripts have execute permissions:
   ```bash
   chmod +x scripts/*.sh
   ```

### For Developers

When adding new tests:

1. Use the `.runtime/` directory for any temporary files
2. Always clean up processes in test teardown
3. Use unique device IDs to avoid conflicts
4. Consider using the enhanced test runner pattern for new test suites

## Contributing

When modifying tests:

1. Test your changes with `pnpm run test:safe`
2. Ensure cleanup works properly after interruptions
3. Update this guide if adding new test commands
4. Verify tests work on different platforms (macOS, Linux, Windows)