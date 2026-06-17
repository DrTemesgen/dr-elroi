# ============================================================
#  Stop Dr. Elroi  -  cleanly shuts down the whole local stack.
#  Node services are stopped BY PORT so other Node apps are never touched.
# ============================================================

$ErrorActionPreference = 'SilentlyContinue'
$Root = 'D:\Software Engineering\Dr. Ubuntu'

function Stop-Port([int]$Port, $Label) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "  stopped $Label (port $Port)" -ForegroundColor Cyan
    } else {
        Write-Host "  $Label not running" -ForegroundColor DarkGray
    }
}

Write-Host "`n=== Stopping Dr. Elroi ===`n" -ForegroundColor Yellow

# App tier (Node) - stop by owning PID so we never touch unrelated Node processes
Stop-Port 3300 'Dr. Elroi connector'
Stop-Port 3001 'Clinic App (doctors)'
Stop-Port 3002 'EMR App (web UI)'
Stop-Port 8103 'EMR API (Medplum server)'
Stop-Port 8123 'Voice engine (Kokoro)'

# Database - graceful shutdown so no stale lock files are left behind
if (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue) {
    Start-Process -FilePath (Join-Path $Root 'pgsql\bin\pg_ctl.exe') `
        -ArgumentList ('stop -m fast -D "' + (Join-Path $Root 'pgdata') + '"') -Wait -WindowStyle Hidden
    Write-Host "  stopped Database (PostgreSQL, graceful)" -ForegroundColor Cyan
} else {
    Write-Host "  Database not running" -ForegroundColor DarkGray
}

# Cache + AI engine (process names are unique to our stack)
if (Get-Process memurai -ErrorAction SilentlyContinue) {
    Get-Process memurai -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "  stopped Cache (Memurai)" -ForegroundColor Cyan
} else { Write-Host "  Cache not running" -ForegroundColor DarkGray }

if (Get-Process ollama, 'ollama app' -ErrorAction SilentlyContinue) {
    Get-Process ollama, 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "  stopped AI engine (Ollama)" -ForegroundColor Cyan
} else { Write-Host "  AI engine not running" -ForegroundColor DarkGray }

Write-Host "`n=== Dr. Elroi stopped ===`n" -ForegroundColor Green
Start-Sleep -Seconds 2
