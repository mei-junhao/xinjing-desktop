# 心镜 XinJing — 发布资产同步到腾讯云 COS（本机运行，管理员 PowerShell）
# 用途：每次发版后，把 GitHub Releases 上的安装包 / 更新文件同步到 COS，
#       使国内用户自动更新走国内链路（CI 内跨洋上传会卡死，故改本机执行）。
param(
  [string]$Ver = "1.0.4"
)

$repo   = "mei-junhao/xinjing-desktop"
$bucket = "xinjing-1439314927"
$region = "ap-guangzhou"
# 下方密钥仅在你的本机使用，不会进入仓库。
$id     = "COS_SECRET_ID_REMOVED"
$key    = "COS_SECRET_KEY_REMOVED"

$tmp = Join-Path $env:TEMP "xinjing-sync"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$files = @(
  "xinjing-setup-$Ver.exe",
  "xinjing-portable-$Ver.exe",
  "xinjing-setup-$Ver.exe.blockmap",
  "xinjing-portable-$Ver.exe.blockmap",
  "latest.yml",
  "latest-portable.yml"
)

Write-Host "==> 从 GitHub Releases 下载资产（ghproxy 加速）"
foreach ($f in $files) {
  $url = "https://ghproxy.net/https://github.com/$repo/releases/download/v$Ver/$f"
  Write-Host "     $f"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp $f)
}

Write-Host "==> 下载 coscli（ghproxy 加速）"
$cli = Join-Path $tmp "coscli.exe"
Invoke-WebRequest -Uri "https://ghproxy.net/https://github.com/tencentyun/coscli/releases/latest/download/coscli-windows.exe" -OutFile $cli

Write-Host "==> 配置并上传到 COS"
& $cli config add -b $bucket -r $region -a $id -s $key
foreach ($f in $files) {
  Write-Host "     上传 $f"
  & $cli cp (Join-Path $tmp $f) "cos://$bucket/"
}

Write-Host "==> 完成。COS 上的 latest.yml: https://$bucket.cos.$region.myqcloud.com/latest.yml"
