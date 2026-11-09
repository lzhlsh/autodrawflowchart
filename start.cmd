@echo off
setlocal

rem ===========================================================================
rem  AutoDrawFlowchart launcher
rem  Double-click this file, or run it from a terminal:  start.cmd
rem
rem  NOTE: this file is intentionally ASCII-only. Adding non-ASCII characters
rem  (or "chcp 65001") makes cmd.exe mis-parse the batch file mid-execution and
rem  fail with errors like  'DrawFlowchart' is not recognized .
rem ===========================================================================

rem Always run from the directory containing this script, so double-clicking
rem works no matter what the current directory happens to be.
cd /d "%~dp0"

echo.
echo   ==========================================
echo     AutoDrawFlowchart  -  AI Diagram Tool
echo   ==========================================
echo.

rem --- Preconditions: build output must exist --------------------------------
if not exist "server\dist\index.js" goto no_server_build
if not exist "web\dist\index.html" goto no_web_build

rem --- The bundled draw.io editor is fetched separately; warn but continue ----
if not exist "web\dist\drawio\index.html" (
  echo   [warn] Bundled draw.io editor not found.
  echo          Run "npm run setup" once for the full editor.
  echo.
)

rem --- Port (override with:  set PORT=5180 && start.cmd ) --------------------
if not defined PORT set PORT=5174

echo   Starting... once ready, open this URL in your browser:
echo.
echo       http://127.0.0.1:%PORT%
echo.
echo   Press Ctrl+C in this window to stop the server.
echo.

node "server\dist\index.js"
set EXITCODE=%ERRORLEVEL%

if not "%EXITCODE%"=="0" (
  echo.
  echo   [error] Server exited with code %EXITCODE%.
  echo           If the port is already in use, try another one:
  echo               set PORT=5180 ^&^& start.cmd
  echo           Or run:  npm start
  echo.
)

echo.
pause
endlocal
exit /b %EXITCODE%

rem ===========================================================================

:no_server_build
echo   [error] Missing server\dist\index.js
echo           Run this first, from the project root:  npm run build
echo.
pause
endlocal
exit /b 1

:no_web_build
echo   [error] Missing web\dist\index.html
echo           Run this first, from the project root:  npm run build
echo.
pause
endlocal
exit /b 1
