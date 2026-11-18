# dsh-prompt-inject installer (Windows PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome D:\dsh -Profile web
#
# Copies package\ into <DshHome>\profiles\<Profile>\node_modules\dsh-prompt-inject
# and appends one insert row to that profile's cordis.patch.yml (skipped when the
# row or a bundle declaration already exists). Restart dsh web afterwards.
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' })
)

$ErrorActionPreference = 'Stop'

$src = Join-Path $PSScriptRoot 'package'
if (-not (Test-Path $src)) { throw "缺少 package 目录：$src" }
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir（用 -Profile 指定）" }
$target = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-prompt-inject'
$patch = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $target -Recurse -Force
Write-Host "已安装到 $target"

$hasRow = (Test-Path $patch) -and (Select-String -Path $patch -Pattern 'name:\s*dsh-prompt-inject' -Quiet)
$hasBundle = (Test-Path (Join-Path $profileDir 'package.json')) -and
             (Select-String -Path (Join-Path $profileDir 'package.json') -Pattern 'dsh-prompt-inject' -Quiet)

if ($hasRow) {
  Write-Host "cordis.patch.yml 已声明 dsh-prompt-inject，跳过挂载行"
} elseif ($hasBundle) {
  Write-Host "该 profile 已通过 bundle 通道声明本插件，未写入手工挂载行（二者只能选一）"
} else {
  if (Test-Path $patch) {
    $backup = "$patch.bak-prompt-inject-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item $patch $backup
  }
  $lines = @('', '# dsh-prompt-inject (installed by install.ps1)', '- insert:',
             '    - id: prompt-inject', '      name: dsh-prompt-inject')
  Add-Content -Path $patch -Value $lines -Encoding UTF8
  Write-Host "已在 $patch 追加挂载行"
}

Write-Host ""
Write-Host "完成。请完整退出并重启 dsh web，然后在「设置 → 提示词注入」里配置规则。"
Write-Host "配置数据：$DshHome\prompt-inject\config.json"
