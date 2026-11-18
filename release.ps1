# Build the VANTAGE TRADE installer and publish it as a GitHub release on ShadowRidezz/vantage-trade.
# Needs GH_TOKEN (setx GH_TOKEN "your token"). Bump "version" in desktop\package.json first.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$token = [Environment]::GetEnvironmentVariable("GH_TOKEN", "User"); if (-not $token) { throw "GH_TOKEN isn't set" }
$ver = (Get-Content desktop\package.json -Raw | ConvertFrom-Json).version
$H = @{ Authorization = "Bearer $token"; "User-Agent" = "vantage-trade-release" }
$api = "https://api.github.com/repos/ShadowRidezz/vantage-trade"

# Build tools log to stderr; run them through cmd so PowerShell judges them by exit code only.
cmd /c "npm --prefix web run build 2>&1"; if ($LASTEXITCODE) { throw "Web build failed" }
cmd /c "cd server && .venv\Scripts\python -m PyInstaller --noconfirm --clean --onedir --name vantage-backend --distpath ..\desktop\backend-build --workpath ""%TEMP%\vt-pyi"" --specpath ""%TEMP%\vt-pyi"" --collect-submodules uvicorn --hidden-import websockets.legacy.server --collect-all faster_whisper --collect-all ctranslate2 --collect-all av --collect-all onnxruntime --collect-binaries imageio_ffmpeg --collect-data imageio_ffmpeg --hidden-import brain_video --collect-all youtube_transcript_api run_server.py 2>&1"
if ($LASTEXITCODE) { throw "Backend build failed" }
cmd /c "npm --prefix desktop run dist 2>&1"; if ($LASTEXITCODE) { throw "Installer build failed" }

$exe = "desktop\dist\VANTAGE-TRADE-Setup-$ver.exe"
try { $rel = Invoke-RestMethod "$api/releases/tags/v$ver" -Headers $H } catch { $rel = $null }
if (-not $rel) { $rel = Invoke-RestMethod -Method Post "$api/releases" -Headers $H -ContentType "application/json" -Body (@{ tag_name = "v$ver"; name = "VANTAGE TRADE $ver"; body = "Download VANTAGE-TRADE-Setup-$ver.exe below and run it to install VANTAGE TRADE on Windows." } | ConvertTo-Json) }
$name = Split-Path $exe -Leaf
$old = $rel.assets | Where-Object { $_.name -eq $name }
if ($old) { Invoke-RestMethod -Method Delete "$api/releases/assets/$($old.id)" -Headers $H | Out-Null }
Invoke-RestMethod -Method Post ($rel.upload_url -replace '\{.*\}', "?name=$name") -Headers $H -InFile $exe -ContentType "application/octet-stream" -TimeoutSec 1800 | Out-Null
"Published: https://github.com/ShadowRidezz/vantage-trade/releases/tag/v$ver"
