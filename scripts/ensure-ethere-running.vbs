' Windowless launcher for the Ethere watchdog check.
scriptDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ensureScript = scriptDirectory & "ensure-ethere-running.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ensureScript & """"
Set launcher = CreateObject("WScript.Shell")
launcher.Run command, 0, False
Set launcher = Nothing
WScript.Quit 0
