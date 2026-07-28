[CmdletBinding()]
param(
  [string]$Url = "https://example.com",
  [string]$OutputDir = ""
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-nsect-rs.ps1"

if (-not $OutputDir) {
  $OutputDir = Join-Path $env:TEMP "nsect-rs-smoke"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$outputPath = Join-Path $OutputDir "page.txt"

powershell -ExecutionPolicy Bypass -File $runner --help | Out-Null
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

powershell -ExecutionPolicy Bypass -File $runner engine --url $Url --format text --timeout 15 --output $outputPath --metadata
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $outputPath)) {
  throw "Smoke output not created: $outputPath"
}

$item = Get-Item -LiteralPath $outputPath
if ($item.Length -le 0) {
  throw "Smoke output is empty: $outputPath"
}

Write-Output "Smoke OK: $outputPath"
