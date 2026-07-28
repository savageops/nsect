[CmdletBinding()]
param(
  [string]$VideoId,
  [string]$Url,
  [string]$Format = "json",
  [string]$OutputPath,
  [switch]$IncludeSegments,
  [switch]$NoAutoCaptions,
  [string[]]$Methods = @()
)

if (-not $OutputPath) {
  throw "OutputPath is required."
}

if (-not $VideoId -and -not $Url) {
  throw "Provide VideoId or Url."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptDir "run-nsect-rs.ps1"
$args = @("transcribe-youtube", "--format", $Format)

if ($VideoId) {
  $args += @("--video-id", $VideoId)
}

if ($Url) {
  $args += @("--url", $Url)
}

if ($IncludeSegments) {
  $args += "--include-segments"
}

if (-not $NoAutoCaptions) {
  $args += "--include-auto-captions"
}

if ($Methods.Count -gt 0) {
  $args += @("--methods", ($Methods -join ","))
}

$args += @("--output", $OutputPath)

$parent = Split-Path -Parent $OutputPath
if ($parent) {
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
}

powershell -ExecutionPolicy Bypass -File $runner @args
exit $LASTEXITCODE
