@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "MCP_PORT=12322"
set "DESKTOP_DIR=%USERPROFILE%\Desktop"
set "LAUNCHER_PATH=%DESKTOP_DIR%\启动本地监听.bat"

echo Installing MasterGo2HTML desktop launcher...
echo Project: %PROJECT_DIR%
echo.

if not exist "%DESKTOP_DIR%" (
    echo Desktop directory was not found: %DESKTOP_DIR%
    pause
    exit /b 1
)

(
echo @echo off
echo setlocal
echo.
echo set "PROJECT_DIR=%PROJECT_DIR%"
echo set "MCP_PORT=%MCP_PORT%"
echo.
echo echo Starting MasterGo2HTML local MCP service...
echo echo Project: %%PROJECT_DIR%%
echo echo.
echo.
echo cd /d "%%PROJECT_DIR%%" || (
echo     echo Failed to enter project directory: %%PROJECT_DIR%%
echo     pause
echo     exit /b 1
echo )
echo.
echo where npm ^>nul 2^>^&1 || (
echo     echo npm was not found. Please install Node.js first, then run this file again.
echo     pause
echo     exit /b 1
echo )
echo.
echo echo Service: http://127.0.0.1:%%MCP_PORT%%
echo echo Running: npm run mcp:dev
echo echo.
echo.
echo call npm run mcp:dev
echo.
echo echo.
echo echo MCP service stopped with exit code %%errorlevel%%.
echo pause
) > "%LAUNCHER_PATH%"

echo Desktop launcher installed:
echo %LAUNCHER_PATH%
echo.
echo You can now double-click it to start the local MCP listener.
pause
