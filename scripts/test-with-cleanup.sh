#!/bin/bash

# Enhanced Test Runner with Automatic Cleanup
# This script provides robust test execution with proper cleanup

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}[TEST]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo -e "${BLUE}🧪 Enhanced Browser-Go Test Runner${NC}"
echo "=================================="

# Function to cleanup on exit
cleanup_on_exit() {
    local exit_code=$?
    print_warning "Test interrupted or completed, running cleanup..."
    "$SCRIPT_DIR/cleanup-test-env.sh"
    exit $exit_code
}

# Set up cleanup trap
trap cleanup_on_exit EXIT INT TERM

# Parse command line arguments
TEST_TYPE="e2e"
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --type)
            TEST_TYPE="$2"
            shift 2
            ;;
        --verbose|-v)
            VERBOSE=true
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--type e2e|bridge|patchright|stability] [--verbose] [--help]"
            echo ""
            echo "Options:"
            echo "  --type TYPE    Test type to run (e2e, bridge, patchright, stability)"
            echo "  --verbose      Enable verbose output"
            echo "  --help         Show this help message"
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Initial cleanup
print_status "Running initial cleanup..."
"$SCRIPT_DIR/cleanup-test-env.sh"

# Wait a moment for cleanup to complete
sleep 2

# Verify port is free
if lsof -i:3000 &>/dev/null; then
    print_error "Port 3000 is still in use after cleanup"
    exit 1
fi

print_status "Environment cleaned, starting test: $TEST_TYPE"

cd "$PROJECT_ROOT"

# Run the specified test
case $TEST_TYPE in
    e2e)
        if [ "$VERBOSE" = true ]; then
            print_info "Running E2E tests in verbose mode..."
            DEBUG=* "$SCRIPT_DIR/run-e2e-test.sh" --verbose
        else
            print_info "Running E2E tests..."
            "$SCRIPT_DIR/run-e2e-test.sh"
        fi
        ;;
    bridge)
        print_info "Running bridge tests..."
        pnpm run test:bridge
        ;;
    patchright)
        print_info "Running patchright tests..."
        pnpm run test:patchright
        ;;
    stability)
        if [ "$VERBOSE" = true ]; then
            print_info "Running stability tests in verbose mode..."
            DEBUG=* "$SCRIPT_DIR/run-multi-device-stability.sh" --verbose
        else
            print_info "Running stability tests..."
            "$SCRIPT_DIR/run-multi-device-stability.sh"
        fi
        ;;
    *)
        print_error "Unknown test type: $TEST_TYPE"
        print_info "Available types: e2e, bridge, patchright, stability"
        exit 1
        ;;
esac

TEST_EXIT_CODE=$?

if [ $TEST_EXIT_CODE -eq 0 ]; then
    print_status "✅ Test completed successfully!"
else
    print_error "❌ Test failed with exit code $TEST_EXIT_CODE"
fi

exit $TEST_EXIT_CODE