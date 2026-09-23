@echo off
rem === Chay app o che do DEV (co hot-reload). Lan dau build lau, sau nhanh. ===
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=amd64 -host_arch=amd64 >nul
cd /d "%~dp0"
echo Starting Hexa Studio (dev)...
npm run tauri dev
pause
