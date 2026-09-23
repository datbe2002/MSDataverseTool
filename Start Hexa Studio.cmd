@echo off
rem Double-click this to launch Hexa Studio (uses the built release app).
set "EXE=%~dp0src-tauri\target\release\hexa-studio.exe"
if exist "%EXE%" (
  start "" "%EXE%"
) else (
  echo The app has not been built yet.
  echo Run:  "Build App (one-time).cmd"
  pause
)
