# ============================================================
#  Start Dr. Elroi -  launches the full local stack in order
#  Database -> Cache -> AI -> EMR API -> EMR App -> Connector
#  NOTE: arguments are passed as single quoted strings because
#  PowerShell Start-Process -ArgumentList (array) mangles paths
#  that contain spaces (this folder has spaces).
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'
$Root = 'D:\Software Engineering\Dr. Ubuntu'
$Node = Join-Path $Root 'node-v24.16.0-win-x64'

# Make the supported Node the one all child processes use, and point Ollama models to D:
$env:PATH = "$Node;$env:PATH"
$env:OLLAMA_MODELS = Join-Path $Root 'Ollama\models'

function Test-Port([int]$Port) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $Port); $c.Connected } catch { $false } finally { $c.Close() }
}

function Wait-Port([int]$Port, [int]$TimeoutSec = 60) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 700
    }
    return $false
}

# $ArgString must be a single string with any space-containing paths already wrapped in quotes.
function Start-Svc($Name, [int]$Port, $Exe, $ArgString, $WorkDir) {
    if (Test-Port $Port) { Write-Host "  [skip] $Name already running on port $Port" -ForegroundColor DarkGray; return }
    Write-Host "  [start] $Name ..." -ForegroundColor Cyan
    $p = @{ FilePath = $Exe; WindowStyle = 'Minimized' }
    if ($ArgString) { $p.ArgumentList = $ArgString }
    if ($WorkDir)   { $p.WorkingDirectory = $WorkDir }
    Start-Process @p
}

Write-Host "`n=== Starting Dr. Elroi ===`n" -ForegroundColor Green

# 1) PostgreSQL (database) - run the server process directly
Start-Svc 'Database (PostgreSQL)' 5432 (Join-Path $Root 'pgsql\bin\postgres.exe') `
    ('-D "' + (Join-Path $Root 'pgdata') + '"') (Join-Path $Root 'pgsql\bin')

# 2) Memurai (cache) - config file (path quoted)
Start-Svc 'Cache (Memurai)' 6379 (Join-Path $Root 'Memurai\memurai.exe') `
    ('"' + (Join-Path $Root 'Memurai\dr-elroi.conf') + '"') (Join-Path $Root 'Memurai')

# 3) Ollama (AI engine for MedGemma)
Start-Svc 'AI engine (Ollama)' 11434 (Join-Path $Root 'Ollama\ollama.exe') 'serve' $null

# 3b) Kokoro voice service (GPU via venv python; loads the speech model once so the voice is fast)
Start-Svc 'Voice engine (Kokoro)' 8123 (Join-Path $Root 'Kokoro\venv\Scripts\python.exe') `
    ('"' + (Join-Path $Root 'Kokoro\kokoro_server.py') + '"') (Join-Path $Root 'Kokoro')

Write-Host "`n  waiting for database, cache, AI to be ready..." -ForegroundColor DarkGray
$okDb = Wait-Port 5432; $okCache = Wait-Port 6379; $okAi = Wait-Port 11434
if (-not $okDb)    { Write-Host "  ! database did not come up on 5432" -ForegroundColor Yellow }
if (-not $okCache) { Write-Host "  ! cache did not come up on 6379" -ForegroundColor Yellow }

# 4) Medplum API server (needs DB + cache)
Start-Svc 'EMR API (Medplum server)' 8103 (Join-Path $Node 'node.exe') `
    '--import ./dist/otel/instrumentation.js dist/index.js file:medplum.config.json' (Join-Path $Root 'medplum\packages\server')

# 5) Medplum web app
Start-Svc 'EMR App (web UI)' 3002 (Join-Path $Node 'npm.cmd') 'run dev' (Join-Path $Root 'medplum\packages\app')

# 5b) Dr. Elroi Clinic (doctor-facing charting app, medplum-provider)
Start-Svc 'Clinic App (doctors)' 3001 (Join-Path $Node 'npm.cmd') 'run dev' (Join-Path $Root 'medplum\examples\medplum-provider')

Write-Host "`n  waiting for EMR API before starting the connector..." -ForegroundColor DarkGray
Wait-Port 8103 120 | Out-Null

# 6) Dr. Elroi connector (needs EMR API + Ollama)
Start-Svc 'Dr. Elroi connector' 3300 (Join-Path $Node 'node.exe') 'dr-elroi.mjs' (Join-Path $Root 'connector')
Wait-Port 3300 60 | Out-Null

Write-Host "`n=== Dr. Elroi is ready ===" -ForegroundColor Green
Write-Host "  Chat with Dr. Elroi : http://localhost:3300"
Write-Host "  Clinic (doctors)     : http://localhost:3001"
Write-Host "  EMR (records/admin)  : http://localhost:3002   (sign in with your admin account)"
Write-Host ""
Start-Process 'http://localhost:3300'
Write-Host "Tip: leave the small minimized windows open - they ARE the running services."
Write-Host "Press any key to close this launcher window (services keep running)..."
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
