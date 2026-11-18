' Starts the VANTAGE TRADE server in the background (no console window) and opens the app.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\server\.venv\Scripts\python.exe"" -m uvicorn --app-dir server main:app --host 127.0.0.1 --port 8010", 0, False
WScript.Sleep 3500
sh.Run "http://localhost:8010", 1, False
