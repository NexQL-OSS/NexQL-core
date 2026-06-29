@echo off
REM NexQL Test Runner Script for Windows
REM This script helps run tests with various configurations

setlocal enabledelayedexpansion

REM Default values
set TEST_TYPE=all
set POSTGRES_VERSION=16
set VERBOSE=false
set DOCKER_UP=false

REM Parse arguments
:parse_args
if "%1"=="" goto done_parsing
if "%1"=="--unit" (
  set TEST_TYPE=unit
  shift
  goto parse_args
)
if "%1"=="--integration" (
  set TEST_TYPE=integration
  shift
  goto parse_args
)
if "%1"=="--renderer" (
  set TEST_TYPE=renderer
  shift
  goto parse_args
)
if "%1"=="--all" (
  set TEST_TYPE=all
  shift
  goto parse_args
)
if "%1"=="--versions" (
  set TEST_TYPE=versions
  shift
  goto parse_args
)
if "%1"=="--pg" (
  set POSTGRES_VERSION=%2
  shift
  shift
  goto parse_args
)
if "%1"=="--coverage" (
  set TEST_TYPE=coverage
  shift
  goto parse_args
)
if "%1"=="--docker-up" (
  set DOCKER_UP=true
  shift
  goto parse_args
)
if "%1"=="--help" (
  call :show_help
  exit /b 0
)

echo Unknown option: %1
call :show_help
exit /b 1

:done_parsing

if %DOCKER_UP%==true (
  call :start_docker_containers
)

if "%TEST_TYPE%"=="unit" (
  call :run_unit_tests
) else if "%TEST_TYPE%"=="integration" (
  call :run_integration_tests
) else if "%TEST_TYPE%"=="renderer" (
  call :run_renderer_tests
) else if "%TEST_TYPE%"=="all" (
  call :run_all_tests
) else if "%TEST_TYPE%"=="versions" (
  call :start_docker_containers
  call :run_version_tests
  call :stop_docker_containers
) else if "%TEST_TYPE%"=="coverage" (
  call :run_coverage
) else (
  echo Unknown test type: %TEST_TYPE%
  call :show_help
  exit /b 1
)

echo.
echo [OK] Test run completed successfully!
exit /b 0

:show_help
echo NexQL Test Runner
echo.
echo Usage:
echo   test.bat [OPTIONS]
echo.
echo Options:
echo   --unit              Run unit tests
echo   --integration       Run integration tests
echo   --renderer          Run renderer component tests
echo   --all               Run all tests (default)
echo   --versions          Run version compatibility tests
echo   --coverage          Run tests with coverage report
echo   --pg VERSION        PostgreSQL version (12, 14, 15, 16, 17) - default: 16
echo   --docker-up         Start Docker containers before running tests
echo   --help              Show this help message
echo.
echo Examples:
echo   REM Run unit tests
echo   test.bat --unit
echo.
echo   REM Run integration tests on PostgreSQL 14
echo   test.bat --integration --pg 14
echo.
echo   REM Run all tests with Docker
echo   test.bat --all --docker-up
echo.
exit /b 0

:start_docker_containers
echo [INFO] Starting PostgreSQL Test Containers
docker-compose -f docker-compose.test.yml up -d
if errorlevel 1 (
  echo [ERROR] Failed to start containers
  exit /b 1
)
echo [OK] PostgreSQL containers started
echo [INFO] Waiting for containers to be ready...
timeout /t 5 /nobreak
exit /b 0

:stop_docker_containers
echo [INFO] Stopping PostgreSQL Test Containers
docker-compose -f docker-compose.test.yml down
if errorlevel 1 (
  echo [ERROR] Failed to stop containers
  exit /b 1
)
echo [OK] Containers stopped
exit /b 0

:run_unit_tests
echo [INFO] Running Unit Tests
call npm run test:unit
if errorlevel 1 (
  echo [ERROR] Unit tests failed
  exit /b 1
)
echo [OK] Unit tests completed
exit /b 0

:run_integration_tests
echo [INFO] Running Integration Tests
echo [INFO] Running against PostgreSQL %POSTGRES_VERSION%
set DB_VERSION=%POSTGRES_VERSION%
call npm run test:integration
if errorlevel 1 (
  echo [ERROR] Integration tests failed
  exit /b 1
)
echo [OK] Integration tests completed
exit /b 0

:run_renderer_tests
echo [INFO] Running Renderer Component Tests
call npm run test:renderer
if errorlevel 1 (
  echo [ERROR] Renderer component tests failed
  exit /b 1
)
echo [OK] Renderer component tests completed
exit /b 0

:run_all_tests
echo [INFO] Running All Tests
call npm run test:all
if errorlevel 1 (
  echo [ERROR] Tests failed
  exit /b 1
)
echo [OK] All tests completed
exit /b 0

:run_version_tests
echo [INFO] Running Version Compatibility Tests
for %%P in (5412 5414 5415 5416 5417) do (
  echo [INFO] Testing on port %%P...
  set DB_PORT=%%P
  call npm run test:integration
  if errorlevel 1 (
    echo [WARN] Tests failed on port %%P
  )
)
echo [OK] Version compatibility tests completed
exit /b 0

:run_coverage
echo [INFO] Running Tests with Coverage
call npm run coverage
if errorlevel 1 (
  echo [ERROR] Coverage generation failed
  exit /b 1
)
call npm run coverage:report
echo [OK] Coverage report generated in ./coverage/index.html
exit /b 0
