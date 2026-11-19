; Smart Xerox Commercial NSIS Installer Customization (Windows 10 & Windows 11)
BrandingText "Smart Xerox v3.1 — Smart Printing. Simplified."
ShowInstDetails show
ShowUnInstDetails show

!macro customHeader
  !system "echo Building Smart Xerox Commercial Windows Installer..."
!macroend

!macro customInit
  ; Safely stop any existing running instance before upgrade or fresh installation
  nsExec::ExecToLog 'taskkill /F /IM "Smart Xerox.exe" /T'
!macroend

!macro customInstall
  DetailPrint "Configuring Smart Xerox Vendor Desktop Console..."
  DetailPrint "Installing self-contained Python 3.13 Print Agent runtime..."
  DetailPrint "Registering Windows Print Spooler & DPAPI credential bridge..."
  DetailPrint "Creating Smart Xerox Desktop and Start Menu shortcuts..."
!macroend

!macro customUnInit
  ; Cleanly stop any running Smart Xerox desktop and child background print agent processes before uninstall
  nsExec::ExecToLog 'taskkill /F /IM "Smart Xerox.exe" /T'
  nsExec::ExecToLog 'wmic process where "name like \"%python%\" and commandline like \"%print-agent%agent.py%\"" call terminate'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Smart Xerox"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Smart Xerox"
!macroend
