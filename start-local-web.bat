@echo off
setlocal
cd /d %~dp0
echo Starting MUD local web client with continuous world runtime...
echo.
echo URL: http://127.0.0.1:8790/client
echo Autosave: world-engine/output/live-world-save.json every 25 ticks
echo.
start "MUD World Server" cmd /k npm run api:live
timeout /t 2 /nobreak >nul
start "MUD Local Client" http://127.0.0.1:8790/client
endlocal
