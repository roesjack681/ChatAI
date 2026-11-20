$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not $env:HARNESS_ADMIN_TOKEN) { $env:HARNESS_ADMIN_TOKEN = "dev-admin" }
$worker = Start-Process -FilePath npx -ArgumentList "tsx","apps/worker/src/main.ts" -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
try {
    npm run dev
}
finally {
    if (-not $worker.HasExited) { Stop-Process -Id $worker.Id }
}
