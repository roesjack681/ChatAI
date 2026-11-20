$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
npm test
npx tsc --noEmit
$env:HARNESS_ADMIN_TOKEN = "compose-validation-only"
docker compose config --quiet
