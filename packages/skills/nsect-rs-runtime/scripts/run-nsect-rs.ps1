[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$bundledBinary = Join-Path $skillRoot "assets\\bin\\nsect-rs.exe"
$candidateBinaries = @()

if ($env:NSECT_RS_BIN) {
  $candidateBinaries += $env:NSECT_RS_BIN
}

$candidateBinaries += $bundledBinary

$binary = $candidateBinaries |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -First 1

if (-not $binary) {
  throw "nsect-rs.exe not found. Expected $bundledBinary or set NSECT_RS_BIN."
}

& $binary @CliArgs
exit $LASTEXITCODE
