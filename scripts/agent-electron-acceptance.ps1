[CmdletBinding()]
param(
  [ValidateRange(0, 65535)]
  [int]$RemoteDebuggingPort = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw "Electron launcher not found: $electron"
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
$tempUserData = Join-Path $tempRoot ("xinjing-agent-acceptance-" + [Guid]::NewGuid().ToString('N'))
$tempUserData = [System.IO.Path]::GetFullPath($tempUserData)
if (-not $tempUserData.StartsWith($tempRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a userData directory outside the system temp folder: $tempUserData"
}

$previousAcceptance = $env:XJ_AGENT_ACCEPTANCE
$previousUserData = $env:XJ_AGENT_ACCEPTANCE_USER_DATA
try {
  New-Item -ItemType Directory -Path $tempUserData -Force | Out-Null
  $env:XJ_AGENT_ACCEPTANCE = '1'
  $env:XJ_AGENT_ACCEPTANCE_USER_DATA = $tempUserData
  # Chromium switches must precede the application path; arguments after the
  # path are forwarded to the app and do not reliably enable CDP/userData.
  # Software rendering keeps this acceptance path deterministic without
  # weakening Electron's renderer sandbox.
  $electronArgs = @("--disable-gpu", "--user-data-dir=$tempUserData")
  if ($RemoteDebuggingPort -gt 0) {
    # The semantic harness may opt in to CDP, but only on loopback and only in acceptance mode.
    $electronArgs += "--remote-debugging-address=127.0.0.1"
    $electronArgs += "--remote-debugging-port=$RemoteDebuggingPort"
  }
  $electronArgs += $repoRoot
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $electron
  $startInfo.WorkingDirectory = $repoRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.Arguments = (($electronArgs | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' ')
  $startInfo.EnvironmentVariables['XJ_AGENT_ACCEPTANCE'] = '1'
  $startInfo.EnvironmentVariables['XJ_AGENT_ACCEPTANCE_USER_DATA'] = $tempUserData
  $process = [System.Diagnostics.Process]::Start($startInfo)
  $process.WaitForExit()
  exit $process.ExitCode
} finally {
  $env:XJ_AGENT_ACCEPTANCE = $previousAcceptance
  $env:XJ_AGENT_ACCEPTANCE_USER_DATA = $previousUserData
  if (Test-Path -LiteralPath $tempUserData) {
    Remove-Item -LiteralPath $tempUserData -Recurse -Force
  }
}
