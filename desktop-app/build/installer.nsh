!macro customUnInit
  ; Cleanly stop any running Smart Xerox desktop and child background print agent processes before uninstall
  nsExec::ExecToLog 'taskkill /F /IM "Smart Xerox.exe" /T'
  nsExec::ExecToLog 'wmic process where "name like \"%python%\" and commandline like \"%print-agent%agent.py%\"" call terminate'
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "electron.app.Smart Xerox"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Smart Xerox"
!macroend
