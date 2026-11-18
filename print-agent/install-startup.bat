@echo off
setlocal
set "AGENT_DIR=%~dp0"
set "STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS_PATH=%AGENT_DIR%start-agent-hidden.vbs"
set "SHORTCUT_PATH=%STARTUP_DIR%\SmartXeroxPrintAgent.lnk"

echo Installing Smart Xerox Background Print Agent into Windows 11 Startup...
powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '\"%VBS_PATH%\"'; $s.WorkingDirectory = '%AGENT_DIR%'; $s.Description = 'Smart Xerox USB Printer Background Agent'; $s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo Startup shortcut created at:
    echo %SHORTCUT_PATH%
    echo Starting background agent now...
    wscript.exe "%VBS_PATH%"
    echo Done! The print agent is now running in the background.
) else (
    echo Failed to create startup shortcut.
)
