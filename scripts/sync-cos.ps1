# XinJing - sync release assets to Tencent COS.
# Run locally as Admin PowerShell.
# Two modes:
#   1. Default: download GitHub Release assets, then upload to COS.
#   2. -UploadOnly: assume assets already exist in -AssetsDir, just upload.
# CI cross-region upload hangs, so we run this on the local machine instead.
param(
  [string]$Ver = "1.0.4",
  [string]$AssetsDir = "",
  [switch]$UploadOnly
)

$ProgressPreference = 'SilentlyContinue'

$repo   = "mei-junhao/xinjing-desktop"
$bucket = "xinjing-1439314927"
$region = "ap-guangzhou"
# Local-only keys; never in git. From env vars, or gitignored scripts/.cos-secret.ps1.
$secretFile = Join-Path $PSScriptRoot ".cos-secret.ps1"
if ((-not $env:COS_SECRET_ID -or -not $env:COS_SECRET_KEY) -and (Test-Path $secretFile)) { . $secretFile }
$id     = $env:COS_SECRET_ID
$key    = $env:COS_SECRET_KEY
if (-not $id -or -not $key) {
  Write-Error "COS 密钥缺失：请设置环境变量 COS_SECRET_ID / COS_SECRET_KEY，或在 scripts\.cos-secret.ps1 中填写（该文件已 gitignore）。"
  exit 1
}

if ($AssetsDir -eq "") {
  $AssetsDir = Join-Path (Split-Path $PSScriptRoot -Parent) "cos-assets"
}
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null

$files = @(
  "xinjing-setup-$Ver.exe",
  "xinjing-portable-$Ver.exe",
  "xinjing-setup-$Ver.exe.blockmap",
  "xinjing-portable-$Ver.exe.blockmap",
  "latest.yml",
  "latest-portable.yml"
)

# Sources tried in order. kgithub is China-hosted and usually fast there.
function Get-Asset {
  param([string]$Name)
  $dest = Join-Path $AssetsDir $Name
  if (Test-Path $dest) {
    $sz = (Get-Item $dest).Length
    if ($sz -gt 0) { Write-Host "     (already present, size=$sz) $Name"; return $true }
  }
  $urls = @(
    "https://kgithub.com/$repo/releases/download/v$Ver/$Name",
    "https://ghproxy.net/https://github.com/$repo/releases/download/v$Ver/$Name",
    "https://github.com/$repo/releases/download/v$Ver/$Name"
  )
  foreach ($u in $urls) {
    try {
      Write-Host "     GET $u"
      Invoke-WebRequest -Uri $u -OutFile $dest -TimeoutSec 600 -ErrorAction Stop
      if ((Get-Item $dest).Length -gt 0) { return $true }
    } catch {
      Write-Host ("     failed: " + $_.Exception.Message)
    }
  }
  return $false
}

if ($UploadOnly) {
  Write-Host "==> UploadOnly mode: uploading from $AssetsDir"
} else {
  Write-Host "==> Downloading assets from GitHub Releases into $AssetsDir"
  foreach ($f in $files) {
    Write-Host "     $f"
    if (-not (Get-Asset $f)) {
      Write-Host "ERROR: could not download $f from any source."
      Write-Host "       Put the 6 files manually into $AssetsDir and re-run with -UploadOnly"
      exit 1
    }
  }
}

Write-Host "==> Downloading coscli"
$cli = Join-Path $AssetsDir "coscli.exe"
if (-not (Test-Path $cli)) {
  $cliUrls = @(
    "https://kgithub.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe",
    "https://ghproxy.net/https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe",
    "https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe",
    "https://ghproxy.net/https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows-amd64.exe",
    "https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows-amd64.exe"
  )
  $cliOk = $false
  foreach ($u in $cliUrls) {
    try {
      Write-Host "     GET $u"
      Invoke-WebRequest -Uri $u -OutFile $cli -TimeoutSec 300 -ErrorAction Stop
      if ((Get-Item $cli).Length -gt 0) { $cliOk = $true; break }
    } catch {
      Write-Host ("     failed: " + $_.Exception.Message)
    }
  }
  if (-not $cliOk) {
    Write-Host "ERROR: could not download coscli. Download it manually from"
    Write-Host "       https://github.com/tencentyun/coscli/releases (coscli-windows.exe)"
    Write-Host "       and put it in $AssetsDir, then re-run with -UploadOnly"
    exit 1
  }
} else {
  Write-Host "     (coscli.exe already present)"
}

Write-Host "==> Configuring and uploading to COS"
& $cli config add -b $bucket -r $region -a $id -s $key
foreach ($f in $files) {
  Write-Host "     uploading $f"
  & $cli cp (Join-Path $AssetsDir $f) "cos://$bucket/"
}

Write-Host "==> Done. COS latest.yml: https://$bucket.cos.$region.myqcloud.com/latest.yml"
