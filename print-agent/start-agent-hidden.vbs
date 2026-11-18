Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
AgentDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = AgentDir

VenvPythonW = AgentDir & "\.venv\Scripts\pythonw.exe"
VenvPython = AgentDir & "\.venv\Scripts\python.exe"

If FSO.FileExists(VenvPythonW) Then
    WshShell.Run """" & VenvPythonW & """ """ & AgentDir & "\agent.py""", 0, False
ElseIf FSO.FileExists(VenvPython) Then
    WshShell.Run """" & VenvPython & """ """ & AgentDir & "\agent.py""", 0, False
Else
    WshShell.Run "cmd /c python agent.py", 0, False
End If
