' Restarts only the API server, hidden, without opening a browser (used after code changes).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = dir
sh.Run "powershell -NoProfile -WindowStyle Hidden -Command ""Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }""", 0, True
WScript.Sleep 1000
sh.Run """" & dir & "\server\.venv\Scripts\python.exe"" -m uvicorn --app-dir server main:app --host 127.0.0.1 --port 8010", 0, False
