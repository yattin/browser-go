#!/bin/bash

# Test Environment Cleanup Script
# This script cleans up any leftover processes and resources from testing

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[CLEANUP]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

echo -e "${BLUE}🧹 Browser-Go Test Environment Cleanup${NC}"
echo "======================================="

# 1. Kill processes using port 3000
print_status "Checking port 3000 usage..."
PORT_3000_PID=$(lsof -ti:3000 2>/dev/null || echo "")
if [ -n "$PORT_3000_PID" ]; then
    print_warning "Port 3000 is in use by PID(s): $PORT_3000_PID"
    for pid in $PORT_3000_PID; do
        PROCESS_INFO=$(ps -p $pid -o pid,ppid,command 2>/dev/null || echo "Process not found")
        print_info "  PID $pid: $PROCESS_INFO"
        print_status "Killing process $pid..."
        kill -TERM $pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true
    done
    
    # Wait and check again
    sleep 2
    PORT_3000_PID_AFTER=$(lsof -ti:3000 2>/dev/null || echo "")
    if [ -n "$PORT_3000_PID_AFTER" ]; then
        print_warning "Some processes still using port 3000, force killing..."
        for pid in $PORT_3000_PID_AFTER; do
            kill -KILL $pid 2>/dev/null || true
        done
    else
        print_status "Port 3000 is now free"
    fi
else
    print_status "Port 3000 is free"
fi

# 2. Kill browser-go related processes
print_status "Cleaning up browser-go processes..."
BROWSER_GO_PIDS=$(pgrep -f "browser-go|dist/cli.js" 2>/dev/null || echo "")
if [ -n "$BROWSER_GO_PIDS" ]; then
    print_warning "Found browser-go processes: $BROWSER_GO_PIDS"
    for pid in $BROWSER_GO_PIDS; do
        print_status "Killing browser-go process $pid..."
        kill -TERM $pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true
    done
else
    print_status "No browser-go processes found"
fi

# 3. Kill test runner processes
print_status "Cleaning up test runner processes..."
TEST_PIDS=$(pgrep -f "test-e2e|pnpm.*test|npm.*test" 2>/dev/null || echo "")
if [ -n "$TEST_PIDS" ]; then
    print_warning "Found test processes: $TEST_PIDS"
    for pid in $TEST_PIDS; do
        print_status "Killing test process $pid..."
        kill -TERM $pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true
    done
else
    print_status "No test processes found"
fi

# 4. Kill Chrome processes with our extension
print_status "Cleaning up Chrome processes with extension..."
if command -v pgrep &> /dev/null; then
    CHROME_PIDS=$(pgrep -f "chrome.*extension" 2>/dev/null || echo "")
    if [ -n "$CHROME_PIDS" ]; then
        print_warning "Found Chrome extension processes: $CHROME_PIDS"
        for pid in $CHROME_PIDS; do
            print_status "Killing Chrome process $pid..."
            kill -TERM $pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true
        done
    else
        print_status "No Chrome extension processes found"
    fi
fi

# 5. Platform-specific Chrome cleanup
print_status "Platform-specific Chrome cleanup..."
case "$(uname -s)" in
    Darwin)  # macOS
        print_info "macOS detected - cleaning up Chrome processes"
        # Kill Chrome processes that might be related to our extension
        pkill -f "Google Chrome.*load-extension" 2>/dev/null || true
        pkill -f "chrome.*--load-extension" 2>/dev/null || true
        # Also clean up any chrome-launcher processes
        pkill -f "chrome-launcher" 2>/dev/null || true
        ;;
    Linux)
        print_info "Linux detected - cleaning up Chrome processes"
        pkill -f "google-chrome.*load-extension" 2>/dev/null || true
        pkill -f "chromium.*load-extension" 2>/dev/null || true
        pkill -f "chrome.*--load-extension" 2>/dev/null || true
        ;;
    CYGWIN*|MINGW32*|MSYS*|MINGW*)
        print_info "Windows detected - cleaning up Chrome processes"
        taskkill //F //IM chrome.exe //T 2>/dev/null || true
        taskkill //F //IM "Google Chrome.exe" //T 2>/dev/null || true
        ;;
    *)
        print_warning "Unknown platform: $(uname -s)"
        ;;
esac

# 6. Clean up runtime directories
print_status "Cleaning up runtime directories..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -d "$PROJECT_ROOT/.runtime" ]; then
    print_info "Removing .runtime directory..."
    rm -rf "$PROJECT_ROOT/.runtime"
    print_status ".runtime directory cleaned"
else
    print_status ".runtime directory not found"
fi

# 7. Clean up temporary test files
print_status "Cleaning up temporary test files..."
TEMP_FILES=(
    "/tmp/browser-go.log"
    "/tmp/server.pid"
    "/tmp/chrome-*.log"
)

for file in "${TEMP_FILES[@]}"; do
    if [ -f "$file" ]; then
        print_info "Removing $file"
        rm -f "$file"
    fi
done

# 8. Clean up any node_modules/.cache that might be locked
print_status "Cleaning up node_modules cache..."
if [ -d "$PROJECT_ROOT/node_modules/.cache" ]; then
    print_info "Clearing node_modules cache..."
    rm -rf "$PROJECT_ROOT/node_modules/.cache" 2>/dev/null || true
fi

# 9. Check for remaining processes
print_status "Final process check..."
REMAINING_3000=$(lsof -ti:3000 2>/dev/null || echo "")
if [ -n "$REMAINING_3000" ]; then
    print_error "Warning: Port 3000 still in use by: $REMAINING_3000"
    exit 1
else
    print_status "Port 3000 is clean"
fi

# 10. Wait a moment for all processes to fully terminate
print_status "Waiting for processes to terminate..."
sleep 3

print_status "Cleanup completed successfully!"
echo ""
print_info "✅ Port 3000 is now available"
print_info "✅ All test processes cleaned up"
print_info "✅ Chrome extension processes terminated"
print_info "✅ Runtime directories cleaned"
echo ""
print_status "Environment is ready for new tests!"