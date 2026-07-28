$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$rustRoot = Join-Path $repoRoot "rust"

Push-Location $rustRoot
try {
  cargo build --release
  $artifact = Join-Path $rustRoot "target\release\nsect-rs.exe"
  Write-Host "Built artifact: $artifact"
} finally {
  Pop-Location
}
