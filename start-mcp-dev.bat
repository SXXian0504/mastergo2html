@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "MCP_PORT=12322"

echo Starting MasterGo2HTML local MCP service...
echo Project: %PROJECT_DIR%
echo.

cd /d "%PROJECT_DIR%" || (
    echo Failed to enter project directory: %PROJECT_DIR%
    pause
    exit /b 1
)

where npm >nul 2>&1 || (
    echo npm was not found. Please install Node.js first, then run this file again.
    pause
    exit /b 1
)

echo Service: http://127.0.0.1:%MCP_PORT%
echo Running: npm run mcp:dev
echo.

call npm run mcp:dev

echo.
echo MCP service stopped with exit code %errorlevel%.
pause
