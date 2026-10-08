# upload-to-cos.ps1 - upload release assets from a local dir to the Tencent COS
# auto-update bucket root. NO rebuild, NO version bump.
#
# The CI builds the Windows app and publishes a GitHub Release, but the app's
# electron-updater reads from the COS generic provider (main.js setFeedURL),
# so every release must mirror the 6 assets into the bucket for existing users
# to receive the update. This script does exactly that.
#
# Usage (PowerShell):
#   .\scripts\upload-to-cos.ps1 -Source D:\path\to\release-assets
#   # or set $env:COS_SECRET_ID / $env:COS_SECRET_KEY, or rely on scripts\.cos-secret.ps1
param(
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) 'dist')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Source)) { Write-Error "Source dir not found: $Source"; exit 1 }

# --- load COS creds: env overrides, else gitignored scripts/.cos-secret.ps1 ---
# PowerShell 5.1 dot-source of .cos-secret.ps1 is unreliable in some envs,
# so we parse the file directly if env vars are not already set.
$cosSecretFile = Join-Path $PSScriptRoot '.cos-secret.ps1'
function ParseCosSecret($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $bom = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 'utf8' } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { 'unicode' } else { 'default' }
  $raw = Get-Content $path -Raw -Encoding $bom
  $idPat = '\$env:COS_SECRET_ID\s*=\s*''?([^'']+)'; $keyPat = '\$env:COS_SECRET_KEY\s*=\s*''?([^'']+)'
  $im = [regex]::Match($raw, $idPat); $km = [regex]::Match($raw, $keyPat)
  if ($im.Success) { $env:COS_SECRET_ID = $im.Groups[1].Value.Trim() }
  if ($km.Success) { $env:COS_SECRET_KEY = $km.Groups[1].Value.Trim() }
}
if ((-not $env:COS_SECRET_ID -or -not $env:COS_SECRET_KEY) -and (Test-Path $cosSecretFile)) { ParseCosSecret $cosSecretFile }
if (-not $env:COS_BUCKET) { $env:COS_BUCKET = 'xinjing-1439314927' }
if (-not $env:COS_REGION) { $env:COS_REGION = 'ap-guangzhou' }
if (-not $env:COS_SECRET_ID -or -not $env:COS_SECRET_KEY) {
  Write-Error "COS credentials missing: set COS_SECRET_ID / COS_SECRET_KEY env vars, or fill scripts\.cos-secret.ps1 (gitignored)."
  exit 1
}

# --- locate coscli (PATH > scripts\coscli.exe) ---
$cli = $null
if (Get-Command coscli -ErrorAction SilentlyContinue) { $cli = (Get-Command coscli).Source }
else {
  $localCli = Join-Path $PSScriptRoot 'coscli.exe'
  if (Test-Path $localCli) { $cli = $localCli }
}
if (-not $cli) { Write-Error 'coscli not found (expected on PATH or scripts\coscli.exe).'; exit 1 }

# --- write cos.yaml non-interactively ---
$cosHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$cosYamlPath = Join-Path $cosHome '.cos.yaml'
$cosYaml = "cos:`n" +
           "  base:`n" +
           "    secretid: ""$env:COS_SECRET_ID""`n" +
           "    secretkey: ""$env:COS_SECRET_KEY""`n" +
           "  buckets:`n" +
           "    - name: $env:COS_BUCKET`n" +
           "      alias: $env:COS_BUCKET`n" +
           "      region: $env:COS_REGION`n"
[System.IO.File]::WriteAllText($cosYamlPath, $cosYaml, [System.Text.UTF8Encoding]::new($false))
Write-Host ("wrote coscli config: $cosYamlPath")

# --- the 6 assets that must live at bucket root ---
$patterns = @('xinjing-setup-*.exe', 'xinjing-portable-*.exe', '*.blockmap', 'latest.yml', 'latest-portable.yml')
$files = @()
foreach ($p in $patterns) { $files += Get-ChildItem $Source -Filter $p -ErrorAction SilentlyContinue }
$files = $files | Sort-Object FullName -Unique
if ($files.Count -eq 0) { Write-Error "no release assets found in $Source"; exit 1 }

foreach ($f in $files) {
  Write-Host ("uploading " + $f.Name)
  & $cli cp $f.FullName ("cos://" + $env:COS_BUCKET + "/" + $f.Name) --acl public-read
  if ($LASTEXITCODE -ne 0) { Write-Error ("upload failed: " + $f.Name); exit 1 }
}

$domain = ("https://" + $env:COS_BUCKET + ".cos." + $env:COS_REGION + ".myqcloud.com/latest.yml")
Write-Host ("==> Done. COS latest.yml: " + $domain)
