@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-server.ps1" %*
set "exit_code=%ERRORLEVEL%"
if not "%exit_code%"=="0" (
  echo.
  echo The local server failed to start. Review the error above.
  if not defined AI_PROJECT_HUB_NO_PAUSE pause
)
endlocal & exit /b %exit_code%
