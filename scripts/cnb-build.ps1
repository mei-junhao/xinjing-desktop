# cnb-build.ps1 - build Windows app and upload release assets to Tencent COS
#
# Run this LOCALLY on your Windows machine (one-command release).
# NOTE: CNB self-hosted build nodes are Linux/Docker only (no native Windows),
#       so CNB cannot build this Electron Windows app in CI. Local build is the way.
# Env (optional; defaults hardcoded below, env overrides):
#   COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION, LICENSE_SECRET
# LICENSE_SECRET also auto-read from ../.license-secret if env not set.
#
# ASCII-only comments to avoid PowerShell 5.1 GBK decode issues.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- defaults (hardcoded for one-command local run; env overrides) ---
if (-not $env:COS_SECRET_ID)  { $env:COS_SECRET_ID  = 'COS_SECRET_ID_REMOVED' }
if (-not $env:COS_SECRET_KEY) { $env:COS_SECRET_KEY = 'COS_SECRET_KEY_REMOVED' }
if (-not $env:COS_BUCKET)     { $env:COS_BUCKET     = 'xinjing-1439314927' }
if (-not $env:COS_REGION)     { $env:COS_REGION     = 'ap-guangzhou' }
if (-not $env:LICENSE_SECRET) {
    $ls = Join-Path (Split-Path $PSScriptRoot -Parent) '.license-secret'
    if (Test-Path $ls) { $env:LICENSE_SECRET = (Get-Content $ls -Raw).Trim() }
}

$scriptDir = $PSScriptRoot
$proj = Split-Path $scriptDir -Parent
$dist = Join-Path $proj 'dist'

# --- 1. China npm / electron mirrors (speeds up install + binary fetch) ---
npm config set registry https://registry.npmmirror.com
$env:ELECTRON_MIRROR = 'https://cdn.npmmirror.com/binaries/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

# --- 0. auto bump version (patch) so every upload is a NEW release ---
# (auto-update only triggers when the server version is higher than local)
# 设环境变量 XJ_NO_BUMP=1 可跳过自动 bump，精确发布当前 package.json 里的版本号
#   （例如已手动设为 1.0.9 时，避免脚本又 +1 变成 1.0.10）
if ($env:XJ_NO_BUMP) {
  $curVer = (Get-Content (Join-Path $proj 'package.json') | ConvertFrom-Json).version
  Write-Host ("XJ_NO_BUMP set -> keeping current version " + $curVer)
} else {
  $env:XJ_PROJ = $proj
  node -e "const fs=require('fs');const p=process.env.XJ_PROJ+'/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));const v=j.version.split('.');v[2]=String((+v[2])+1);j.version=v.join('.');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');console.log('bumped version ->',j.version);"
}
# 立即生成构建期版本文件（version.generated.js），与 package.json 同步；
# npm run dist 的 predist 钩子也会再生成一次，此处为防御性确保文件已存在。
Push-Location $proj
node scripts/codegen-version.js
Pop-Location

# --- 2-4. clean rebuild (dist MUST match the bumped version) + postbuild ---
# always remove old dist so electron-builder emits the new versioned assets
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
Push-Location $proj
try {
    npm install --legacy-peer-deps
    # predist hook (codegen-secret.js) reads $env:LICENSE_SECRET -> secret.generated.js
    npm run dist -- --publish never
    # (re)generate latest.yml / blockmap / latest-portable.yml from dist
    node scripts/postbuild.js
} finally {
    Pop-Location
}

# --- 5. locate coscli (PATH > manual coscli.exe beside script > auto-download) ---
$cli = $null
if (Get-Command coscli -ErrorAction SilentlyContinue) {
    $cli = (Get-Command coscli).Source
    Write-Host ("using coscli from PATH: $cli")
} else {
    $localCli = Join-Path $scriptDir 'coscli.exe'
    if (Test-Path $localCli) {
        $cli = $localCli
        Write-Host ("using coscli.exe next to script: $cli")
    } else {
        $cli = Join-Path $env:TEMP 'coscli.exe'
        # resolve latest windows-amd64 asset URL dynamically
        $resolvedUrl = $null
        try {
            $api = Invoke-RestMethod -Uri 'https://api.github.com/repos/tencentyun/coscli/releases/latest' -TimeoutSec 30 -ErrorAction Stop
            $asset = $api.assets | Where-Object { $_.name -like '*windows-amd64.exe' } | Select-Object -First 1
            if ($asset) { $resolvedUrl = $asset.browser_download_url }
        } catch { Write-Warning ("GitHub API unreachable: " + $_.Exception.Message) }
        if (-not $resolvedUrl) {
            try {
                $api = Invoke-RestMethod -Uri 'https://ghproxy.net/https://api.github.com/repos/tencentyun/coscli/releases/latest' -TimeoutSec 30 -ErrorAction Stop
                $asset = $api.assets | Where-Object { $_.name -like '*windows-amd64.exe' } | Select-Object -First 1
                if ($asset) { $resolvedUrl = $asset.browser_download_url }
            } catch { Write-Warning ("ghproxy API unreachable: " + $_.Exception.Message) }
        }
        if (-not $resolvedUrl) {
            $resolvedUrl = 'https://github.com/tencentyun/coscli/releases/download/v1.0.8/coscli-v1.0.8-windows-amd64.exe'
            Write-Warning 'could not resolve latest; using hardcoded v1.0.8 URL'
        }
        # Tencent's own China CDN (NOT github) - most reliable in China:
        $tencentCdn = 'https://cosbrowser.cloud.tencent.com/software/coscli/coscli-windows-amd64.exe'
        $kgithub = $resolvedUrl -replace '^https://github.com/', 'https://kgithub.com/'
        $downloadUrls = @($tencentCdn, $kgithub, $resolvedUrl, 'https://ghproxy.net/' + $resolvedUrl)
        $ok = $false
        foreach ($u in $downloadUrls) {
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
            Write-Error 'could not obtain coscli automatically. Manual fix (100% reliable): download coscli from Tencent China CDN: https://cosbrowser.cloud.tencent.com/software/coscli/coscli-windows-amd64.exe , rename to coscli.exe, place it in D:\xinjing-electron\scripts\, then rerun this script.'
            exit 1
        }
    }
}

# --- 6. write coscli config file directly (avoids interactive init wizard) ---
# coscli shows a first-run interactive "Input Your Mode:" prompt when
# ~/.cos.yaml is missing; running `config set/add` triggers that prompt and
# hangs the script. Writing the file directly is the non-interactive path.
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

# --- 7. upload the 6 release assets from dist\ to bucket root ---
$patterns = @('xinjing-setup-*.exe', 'xinjing-portable-*.exe', '*.blockmap', 'latest.yml', 'latest-portable.yml')
$files = @()
foreach ($p in $patterns) { $files += Get-ChildItem $dist -Filter $p }
$files = $files | Sort-Object FullName -Unique
if ($files.Count -eq 0) { Write-Error 'no release assets found in dist\'; exit 1 }

foreach ($f in $files) {
    Write-Host ("uploading " + $f.Name)
    & $cli cp $f.FullName ("cos://" + $env:COS_BUCKET + "/" + $f.Name) --acl public-read
    if ($LASTEXITCODE -ne 0) { Write-Error ("upload failed: " + $f.Name); exit 1 }
}

$domain = ("https://" + $env:COS_BUCKET + ".cos." + $env:COS_REGION + ".myqcloud.com/latest.yml")
Write-Host ("==> Done. COS latest.yml: " + $domain)
