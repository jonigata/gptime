@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or later is required.
  pause
  exit /b 1
)
if not exist node_modules\jose call npm ci --ignore-scripts
if errorlevel 1 exit /b 1
echo Open http://127.0.0.1:18765 in your browser.
node src\server.mjs
pause
