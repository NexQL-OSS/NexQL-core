#!/bin/bash

# PgStudio Test Runner Script
# This script helps run tests with various configurations

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
TEST_TYPE="all"
POSTGRES_VERSION="16"
VERBOSE=false
DOCKER_UP=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --unit)
      TEST_TYPE="unit"
      shift
      ;;
    --integration)
      TEST_TYPE="integration"
      shift
      ;;
    --renderer)
      TEST_TYPE="renderer"
      shift
      ;;
    --all)
      TEST_TYPE="all"
      shift
      ;;
    --versions)
      TEST_TYPE="versions"
      shift
      ;;
    --pg)
      POSTGRES_VERSION="$2"
      shift 2
      ;;
    --coverage)
      TEST_TYPE="coverage"
      shift
      ;;
    --docker-up)
      DOCKER_UP=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      show_help
      exit 1
      ;;
  esac
done

show_help() {
  cat << 'EOF'
PgStudio Test Runner

Usage:
  ./scripts/test.sh [OPTIONS]

Options:
  --unit              Run unit tests
  --integration       Run integration tests
  --renderer          Run renderer component tests
  --all               Run all tests (default)
  --versions          Run version compatibility tests
  --coverage          Run tests with coverage report
  --pg VERSION        PostgreSQL version (12, 14, 15, 16, 17) - default: 16
  --docker-up         Start Docker containers before running tests
  --verbose           Show detailed output
  --help              Show this help message

Examples:
  # Run unit tests
  ./scripts/test.sh --unit

  # Run integration tests on PostgreSQL 14
  ./scripts/test.sh --integration --pg 14

  # Run all tests with Docker
  ./scripts/test.sh --all --docker-up

  # Generate coverage report
  ./scripts/test.sh --coverage

  # Run version compatibility tests
  ./scripts/test.sh --versions
EOF
}

print_header() {
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_info() {
  echo -e "${YELLOW}ℹ $1${NC}"
}

check_docker() {
  if ! command -v docker &> /dev/null; then
    print_error "Docker is not installed"
    exit 1
  fi
  
  if ! command -v docker-compose &> /dev/null; then
    print_error "Docker Compose is not installed"
    exit 1
  fi
  
  print_success "Docker and Docker Compose are available"
}

check_node() {
  if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed"
    exit 1
  fi
  
  local node_version=$(node --version)
  print_success "Node.js $node_version is available"
}

start_docker_containers() {
  print_header "Starting PostgreSQL Test Containers"
  check_docker
  
  docker-compose -f docker-compose.test.yml up -d
  
  # Wait for containers to be ready
  print_info "Waiting for PostgreSQL containers to be ready..."
  sleep 5
  
  for port in 5412 5413 5414 5415 5416 5417 5418; do
    local counter=0
    while ! nc -z localhost $port &> /dev/null; do
      if [ $counter -eq 30 ]; then
        print_error "PostgreSQL on port $port did not become ready"
        exit 1
      fi
      counter=$((counter + 1))
      sleep 1
    done
  done
  
  print_success "All PostgreSQL containers are ready"
}

stop_docker_containers() {
  print_header "Stopping PostgreSQL Test Containers"
  docker-compose -f docker-compose.test.yml down
  print_success "Containers stopped"
}

run_unit_tests() {
  print_header "Running Unit Tests"
  check_node
  npm run test:unit
  print_success "Unit tests completed"
}

run_integration_tests() {
  print_header "Running Integration Tests"
  check_node
  
  local port_map=("12:5412" "13:5413" "14:5414" "15:5415" "16:5416" "17:5417")
  local port=5416
  
  for mapping in "${port_map[@]}"; do
    local version="${mapping%%:*}"
    port="${mapping##*:}"
    if [ "$version" == "$POSTGRES_VERSION" ]; then
      break
    fi
  done
  
  export DB_PORT=$port
  export DB_VERSION=$POSTGRES_VERSION
  
  print_info "Running against PostgreSQL $POSTGRES_VERSION on port $port"
  npm run test:integration
  print_success "Integration tests completed"
}

run_renderer_tests() {
  print_header "Running Renderer Component Tests"
  check_node
  npm run test:renderer
  print_success "Renderer component tests completed"
}

run_all_tests() {
  print_header "Running All Tests"
  check_node
  npm run test:all
  print_success "All tests completed"
}

run_version_tests() {
  print_header "Running Version Compatibility Tests"
  check_node
  
  for port in 5412 5413 5414 5415 5416 5417 5418; do
    local version="pg$(($port - 5400))"
    print_info "Testing on $version (port $port)..."
    export DB_PORT=$port
    npm run test:integration || print_error "Tests failed on port $port"
  done
  
  print_success "Version compatibility tests completed"
}

run_coverage() {
  print_header "Running Tests with Coverage"
  check_node
  npm run coverage
  npm run coverage:report
  print_success "Coverage report generated in ./coverage/index.html"
}

# Main execution
main() {
  if $DOCKER_UP; then
    start_docker_containers
  fi
  
  case $TEST_TYPE in
    unit)
      run_unit_tests
      ;;
    integration)
      run_integration_tests
      ;;
    renderer)
      run_renderer_tests
      ;;
    all)
      run_all_tests
      ;;
    versions)
      start_docker_containers
      run_version_tests
      stop_docker_containers
      ;;
    coverage)
      run_coverage
      ;;
    *)
      print_error "Unknown test type: $TEST_TYPE"
      show_help
      exit 1
      ;;
  esac
  
  print_success "Test run completed successfully!"
}

main
