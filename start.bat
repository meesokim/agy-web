@echo off
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies...
  call npm.cmd install
)
echo Starting AGY Web Console Server...
node server.js
