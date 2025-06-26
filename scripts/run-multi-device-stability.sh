#!/bin/bash

# Multi-Device Stability Test Runner for Browser-Go
# Tests device registration and connection stability without real browsers

set -e

echo "🔧 Browser-Go Multi-Device Stability Test Runner"
echo "=============================================+"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
print_status "Checking prerequisites..."

# Check if pnpm is available
if ! command -v pnpm &> /dev/null; then
    print_error "pnpm is not installed. Please install pnpm first."
    exit 1
fi

# Check if port 3000 is free
if lsof -i:3000 &> /dev/null; then
    print_error "Port 3000 is already in use. Please free the port or run 'pnpm run cleanup' first."
    exit 1
fi

print_status "Prerequisites check passed!"

# Build the project
print_status "Building the project..."
pnpm run build

if [ $? -ne 0 ]; then
    print_error "Build failed. Please fix the build errors first."
    exit 1
fi

print_status "Build successful!"

# Parse command line arguments
VERBOSE=""
if [ "$1" = "--verbose" ] || [ "$1" = "-v" ]; then
    VERBOSE="DEBUG=*"
    print_status "Running in verbose mode..."
fi

# Set timeout for the test
TIMEOUT=90  # 90 seconds - shorter than full E2E
if [ "$1" = "--timeout" ] && [ -n "$2" ]; then
    TIMEOUT=$2
fi

print_status "Test timeout: ${TIMEOUT} seconds"

# Function to run command with timeout (cross-platform)
run_with_timeout() {
    local timeout=$1
    shift
    local cmd="$@"
    
    # Check if gtimeout is available (from coreutils via Homebrew)
    if command -v gtimeout &> /dev/null; then
        gtimeout $timeout $cmd
        return $?
    elif command -v timeout &> /dev/null; then
        timeout $timeout $cmd
        return $?
    else
        # Fallback: run without timeout on macOS
        print_warning "timeout command not available. Running test without timeout limit."
        print_warning "You can install coreutils via Homebrew for timeout support: brew install coreutils"
        $cmd
        return $?
    fi
}

# Clean up any existing runtime directories
print_status "Cleaning up runtime directories..."
rm -rf .runtime
mkdir -p .runtime

# Run the multi-device stability test
print_status "Starting multi-device stability test..."
print_warning "This test will:"
print_warning "  1. Start a browser-go server on port 3000"
print_warning "  2. Simulate multiple device connections via WebSocket"
print_warning "  3. Test device registration conflicts and resolution"
print_warning "  4. Verify concurrent CDP message routing"
print_warning "  5. Test connection resilience under stress"
print_warning "  6. Clean up automatically when done"
echo ""

# Run the stability test with timeout
if [ -n "$VERBOSE" ]; then
    run_with_timeout $TIMEOUT env $VERBOSE node dist/test-multi-device-stability.js
else
    run_with_timeout $TIMEOUT node dist/test-multi-device-stability.js
fi

TEST_RESULT=$?

if [ $TEST_RESULT -eq 0 ]; then
    print_status "🎉 Multi-device stability test completed successfully!"
elif [ $TEST_RESULT -eq 124 ]; then
    print_error "❌ Multi-device stability test timed out after ${TIMEOUT} seconds"
    exit 1
else
    print_error "❌ Multi-device stability test failed with exit code $TEST_RESULT"
    exit $TEST_RESULT
fi

print_status "Multi-device stability test finished."