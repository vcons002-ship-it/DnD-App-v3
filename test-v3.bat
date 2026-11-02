@echo off
setlocal
title DnD-App-v3 Test Server (v3.nic024i.app / Port 4300)
cd /d "%~dp0"

set "PORT=4300"
set "PUBLIC_URL=https://v3.nic024i.app"
set "CF_TUNNEL_CONFIG=%~dp0deploy\cloudflared-v3.yml"

echo ============================================================
echo   Starting DnD-App-v3 on https://v3.nic024i.app (Port 4300)
echo   (Your main DnD-App-v2 service on dnd.nic024i.app is untouched)
echo.
echo     DM View:     https://v3.nic024i.app/dm
echo     Player View: https://v3.nic024i.app/join
echo     Alt Domain:  https://dnd-v3.nic024i.app/dm
echo     Local URL:   http://localhost:4300/dm
echo ============================================================
echo.

call npm.cmd run start -w server
pause
