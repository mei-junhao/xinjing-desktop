# publish-cos.ps1 — 心镜 Tauri 版本构建并发布到腾讯云 COS
#
# 用法：
#   .\publish-cos.ps1              # 构建并上传当前版本
#   .\publish-cos.ps1 -SkipBuild   # 跳过构建，仅上传已有产物
#
# 命名规则：xinjing tauri{版本号}
#   Windows: "xinjing tauri1.0.0.exe"
#   macOS:   "xinjing tauri1.0.0.app.tar.gz" + ".sig"
#   更新清单: latest.json
#
# COS 桶：xinjing-1258396727 (cos.ap-nanjing.myqcloud.com)
# 更新目录：tauri-updates/

param(
  [switch]$SkipBuild,
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

# 读取版本号
$tauriConf = Get-Content "d:\xinjing-electron\xinjing-tauri\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
if (-not $Version) { $Version = $tauriConf.version }
$baseName = "xinjing tauri$Version"
$cosBucket = "xinjing-1258396727"
$cosRegion = "ap-nanjing"
$cosBase = "https://$cosBucket.cos.$cosRegion.myqcloud.com/tauri-updates"
$localDist = "d:\xinjing-electron\xinjing-tauri\src-tauri\target\release\bundle"

Write-Host "===== 心镜 Tauri 发布脚本 =====" -ForegroundColor Cyan
Write-Host "版本号: $Version"
Write-Host "命名前缀: $baseName"
Write-Host "COS 目录: $cosBase"
Write-Host ""

# ---- 1. 构建应用 ----
if (-not $SkipBuild) {
  Write-Host "[1/4] 构建 Tauri 应用..." -ForegroundColor Yellow
  $env:PATH = "C:\Users\Administrator\.cargo\bin;$env:PATH"
  $env:LICENSE_SECRET = $env:LICENSE_SECRET
  $env:APP_PROXY_KEY = $env:APP_PROXY_KEY

  Push-Location "d:\xinjing-electron\xinjing-tauri\src-tauri"
  & cargo tauri build 2>&1
  $buildExit = $LASTEXITCODE
  Pop-Location

  if ($buildExit -ne 0) {
    Write-Host "构建失败 (exit $buildExit)" -ForegroundColor Red
    exit 1
  }
  Write-Host "构建完成" -ForegroundColor Green
} else {
  Write-Host "[1/4] 跳过构建" -ForegroundColor Yellow
}

# ---- 2. 收集构建产物 ----
Write-Host "[2/4] 收集构建产物..." -ForegroundColor Yellow

$artifacts = @()

# Windows NSIS
$nsisDir = Join-Path $localDist "nsis"
if (Test-Path $nsisDir) {
  $setupExe = Get-ChildItem $nsisDir -Filter "*.exe" | Select-Object -First 1
  if ($setupExe) {
    $destName = "$baseName.exe"
    $artifacts += @{ src = $setupExe.FullName; dest = $destName; type = "windows-setup" }
    Write-Host "  Windows NSIS: $($setupExe.Name) -> $destName"
  }
}

# Windows MSI（如果生成了）
$msiDir = Join-Path $localDist "msi"
if (Test-Path $msiDir) {
  $msiFile = Get-ChildItem $msiDir -Filter "*.msi" | Select-Object -First 1
  if ($msiFile) {
    $destName = "$baseName.msi"
    $artifacts += @{ src = $msiFile.FullName; dest = $destName; type = "windows-msi" }
    Write-Host "  Windows MSI: $($msiFile.Name) -> $destName"
  }
}

# macOS（如有）
$tgzDir = Join-Path $localDist "macos"
if (Test-Path $tgzDir) {
  $tgzFile = Get-ChildItem $tgzDir -Filter "*.tar.gz" | Select-Object -First 1
  if ($tgzFile) {
    $destName = "$baseName.app.tar.gz"
    $artifacts += @{ src = $tgzFile.FullName; dest = $destName; type = "macos-tgz" }
    # 签名文件
    $sigFile = Get-ChildItem $tgzDir -Filter "*.sig" | Select-Object -First 1
    if ($sigFile) {
      $artifacts += @{ src = $sigFile.FullName; dest = "$destName.sig"; type = "macos-sig" }
    }
  }
}

if ($artifacts.Count -eq 0) {
  Write-Host "未找到构建产物" -ForegroundColor Red
  exit 1
}

# ---- 3. 上传到 COS ----
Write-Host "[3/4] 上传到 COS..." -ForegroundColor Yellow

# 使用 coscmd 或 cosclient
# 如果安装了 coscmd：
$useCoscmd = $false
try { $coscmdVersion = & coscmd --version 2>&1; if ($LASTEXITCODE -eq 0) { $useCoscmd = $true } } catch {}

# 或者使用腾讯云 CLI tccli
$useTccli = $false
try { $tccliVersion = & tccli --version 2>&1; if ($LASTEXITCODE -eq 0) { $useTccli = $true } } catch {}

# Windows NSIS 签名文件（Tauri 生成）
$nsisSigFile = Join-Path $nsisDir "$($setupExe.BaseName)-setup.exe.sig"
$hasWindowsSig = Test-Path $nsisSigFile

$uploadedUrls = @{}

foreach ($art in $artifacts) {
  $destPath = "tauri-updates/$($art.dest)"
  Write-Host "  上传: $($art.src) -> $destPath"

  if ($useCoscmd) {
    & coscmd upload "$($art.src)" "$destPath" 2>&1 | Out-Null
  } elseif ($useTccli) {
    & tccli cos put-object --Bucket $cosBucket --Region $cosRegion --Key "$destPath" --Body "$($art.src)" 2>&1 | Out-Null
  } else {
    # 使用 REST API 直接上传（需要 SecretId/SecretKey）
    Write-Host "  coscmd/tccli 未安装，请手动上传或安装后重试" -ForegroundColor Red
    Write-Host "  文件位置: $($art.src)"
    Write-Host "  COS 路径: $destPath"
  }

  $url = "$cosBase/$($art.dest)"
  $url = $url -replace ' ', '%20'
  $uploadedUrls[$art.type] = $url
}

# ---- 4. 生成 latest.json 更新清单 ----
Write-Host "[4/4] 生成 latest.json..." -ForegroundColor Yellow

$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

$latestJson = @{
  version = $Version
  notes = "心镜 XinJing Tauri v$Version"
  pub_date = $pubDate
  platforms = @{}
}

# Windows x86_64
if ($uploadedUrls.ContainsKey("windows-setup")) {
  $winUrl = $uploadedUrls["windows-setup"]
  $winSig = ""
  if ($hasWindowsSig) {
    $winSigContent = Get-Content $nsisSigFile -Raw
    $winSig = $winSigContent.Trim()
  }
  $latestJson.platforms["windows-x86_64"] = @{
    signature = $winSig
    url = $winUrl
  }
  Write-Host "  Windows: $winUrl"
}

# macOS aarch64 + x86_64
if ($uploadedUrls.ContainsKey("macos-tgz")) {
  $macUrl = $uploadedUrls["macos-tgz"]
  $macSig = ""
  if ($uploadedUrls.ContainsKey("macos-sig")) {
    # 读取签名文件内容
    $sigFile = Join-Path $tgzDir (Get-ChildItem $tgzDir -Filter "*.sig" | Select-Object -First 1).Name
    $macSig = (Get-Content $sigFile -Raw).Trim()
  }
  $latestJson.platforms["darwin-aarch64"] = @{
    signature = $macSig
    url = $macUrl
  }
  $latestJson.platforms["darwin-x86_64"] = @{
    signature = $macSig
    url = $macUrl
  }
  Write-Host "  macOS: $macUrl"
}

$jsonStr = $latestJson | ConvertTo-Json -Depth 5
$latestPath = "d:\xinjing-electron\xinjing-tauri\latest.json"
$jsonStr | Out-File -FilePath $latestPath -Encoding utf8 -NoNewline
Write-Host "  本地生成: $latestPath"

# 上传 latest.json
if ($useCoscmd) {
  & coscmd upload $latestPath "tauri-updates/latest.json" 2>&1 | Out-Null
} elseif ($useTccli) {
  & tccli cos put-object --Bucket $cosBucket --Region $cosRegion --Key "tauri-updates/latest.json" --Body $latestPath 2>&1 | Out-Null
} else {
  Write-Host "  请手动上传 latest.json 到 COS: tauri-updates/latest.json"
}

Write-Host ""
Write-Host "===== 发布完成 =====" -ForegroundColor Green
Write-Host "更新清单 URL: $cosBase/latest.json"
Write-Host "版本: $Version"
Write-Host ""
Write-Host "产物列表:"
foreach ($art in $artifacts) {
  Write-Host "  - $($art.dest): $($uploadedUrls[$art.type])"
}
