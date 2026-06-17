@echo off
setlocal
cd /d %~dp0
echo Starting MUD local web client...
echo.
echo URL: http://127.0.0.1:8790/client
echo.
start "MUD Local Client" http://127.0.0.1:8790/client
npm run api
pause
