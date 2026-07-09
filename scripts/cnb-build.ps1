# cnb-build.ps1 - build Windows app and upload release assets to Tencent COS
#
# Runs on CNB self-hosted Windows runner (triggered by tag_push), or locally.
# Env (CNB: injected via imports / Local: export these before running):
#   COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, LICENSE_SECRET
#
# ASCII-only comments to avoid PowerShell 5.1 GBK decode issues.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = $PSScriptRoot
$dist = Join-Path $root '..' 'dist'

# --- 1. China npm / electron mirrors (speeds up install + binary fetch) ---
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# --- 2-4. install + build + postbuild ---
Push-Location $root
try {
    npm ci
    # predist hook (codegen-secret.js) reads $env:LICENSE_SECRET -> secret.generated.js
    npm run dist -- --publish never
    node scripts/postbuild.js
} finally {
    Pop-Location
}

# --- 5. locate coscli (prefer PATH, else download) ---
$cli = $null
if (Get-Command coscli -ErrorAction SilentlyContinue) {
    $cli = (Get-Command coscli).Source
} else {
    $cli = Join-Path $env:TEMP 'coscli.exe'
    $urls = @(
        'https://ghproxy.net/https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe',
        'https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe'
    )
    $ok = $false
    foreach ($u in $urls) {
        try {
            Write-Host ("downloading coscli from $u")
            Invoke-WebRequest -Uri $u -OutFile $cli -TimeoutSec 180 -ErrorAction Stop
            $ok = $true
            break
        } catch {
            Write-Warning ("coscli download failed: $u -> " + $_.Exception.Message)
        }
    }
    if (-not $ok) {
        Write-Error 'could not obtain coscli; please install coscli and add to PATH, then rerun'
        exit 1
    }
}

# --- 6. coscli config (writes ~/.cos.yaml, used by subsequent cp) ---
& $cli config add -b $env:COS_BUCKET -r $env:COS_REGION -a $env:COS_SECRET_ID -s $env:COS_SECRET_KEY
if ($LASTEXITCODE -ne 0) { Write-Error 'coscli config add failed'; exit 1 }

# --- 7. upload the 6 release assets from dist\ to bucket root ---
$patterns = @('xinjing-setup-*.exe', 'xinjing-portable-*.exe', '*.blockmap', 'latest.yml', 'latest-portable.yml')
$files = @()
foreach ($p in $patterns) { $files += Get-ChildItem $dist -Filter $p }
$files = $files | Sort-Object FullName -Unique
if ($files.Count -eq 0) { Write-Error 'no release assets found in dist\'; exit 1 }

foreach ($f in $files) {
    Write-Host ("uploading " + $f.Name)
    & $cli cp $f.FullName ("cos://" + $env:COS_BUCKET + "/" + $f.Name)
    if ($LASTEXITCODE -ne 0) { Write-Error ("upload failed: " + $f.Name); exit 1 }
}

$domain = ("https://" + $env:COS_BUCKET + ".cos." + $env:COS_REGION + ".myqcloud.com/latest.yml")
Write-Host ("==> Done. COS latest.yml: " + $domain)
