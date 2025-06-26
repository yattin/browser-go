#!/bin/bash

# Simplified E2E Test Runner for Browser-Go
# This script runs the simplified E2E test with proper environment setup

set -e

echo "🧪 Browser-Go Simplified E2E Test Runner"
echo "========================================"

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

# Check if extension exists
if [ ! -d "extension" ]; then
    print_error "Extension directory not found. Please ensure the extension is in the 'extension/' directory."
    exit 1
fi

if [ ! -f "extension/manifest.json" ]; then
    print_error "Extension manifest.json not found."
    exit 1
fi

if [ ! -f "extension/background.js" ]; then
    print_error "Extension background.js not found."
    exit 1
fi

print_status "Extension files verified!"

# Clean up any existing runtime directories
print_status "Cleaning up runtime directories..."
rm -rf .runtime
mkdir -p .runtime

# Run the simplified E2E test
print_status "Starting simplified E2E test..."
print_warning "This test will:"
print_warning "  1. Start a browser-go server on port 3000"
print_warning "  2. Launch Chrome instances with the extension loaded"
print_warning "  3. Run focused tests on core CDP functionality"
print_warning "  4. Test multi-device connections with improved stability"
print_warning "  5. Clean up automatically when done"
echo ""

# Parse command line arguments
VERBOSE=""
if [ "$1" = "--verbose" ] || [ "$1" = "-v" ]; then
    VERBOSE="DEBUG=*"
    print_status "Running in verbose mode..."
fi

# Set timeout for the test
TIMEOUT=120  # 2 minutes - shorter than full E2E
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

# Run the simplified test with timeout
if [ -n "$VERBOSE" ]; then
    run_with_timeout $TIMEOUT env $VERBOSE node dist/test-e2e-simple.js
else
    run_with_timeout $TIMEOUT node dist/test-e2e-simple.js
fi

TEST_RESULT=$?

if [ $TEST_RESULT -eq 0 ]; then
    print_status "🎉 Simplified E2E test completed successfully!"
elif [ $TEST_RESULT -eq 124 ]; then
    print_error "❌ Simplified E2E test timed out after ${TIMEOUT} seconds"
    exit 1
else
    print_error "❌ Simplified E2E test failed with exit code $TEST_RESULT"
    exit $TEST_RESULT
fi

print_status "Simplified E2E test finished."