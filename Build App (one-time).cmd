@echo off
rem === Build ra file .exe chay doc lap + bo cai (chi can chay 1 lan). ===
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
call "C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat" -arch=amd64 -host_arch=amd64 >nul
cd /d "%~dp0"
echo Building release... (vai phut)
npm run tauri build
echo.
echo Xong! File .exe o: src-tauri\target\release\hexa-studio.exe
echo Bo cai o:          src-tauri\target\release\bundle\
pause
