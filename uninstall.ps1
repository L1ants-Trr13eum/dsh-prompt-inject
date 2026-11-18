# Removes the package and the insert block install.ps1 added. Other rows are untouched.
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$Profile = $(if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' })
)
$ErrorActionPreference = 'Stop'
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$target = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-prompt-inject'
$patch = Join-Path $profileDir 'cordis.patch.yml'

if (Test-Path $target) { Remove-Item $target -Recurse -Force; Write-Host "已删除 $target" }

if ((Test-Path $patch) -and (Select-String -Path $patch -Pattern '# dsh-prompt-inject \(installed by install\.ps1\)' -Quiet)) {
  $backup = "$patch.bak-prompt-inject-uninstall-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $patch $backup
  $kept = @()
  $skip = 0
  foreach ($line in (Get-Content -Path $patch)) {
    if ($skip -gt 0) { $skip--; continue }
    if ($line -match '# dsh-prompt-inject \(installed by install\.ps1\)') { $skip = 3; continue }
    $kept += $line
  }
  Set-Content -Path $patch -Value $kept -Encoding UTF8
  Write-Host "已移除挂载行（备份：$backup）"
} else {
  Write-Host "未找到由本安装脚本写入的挂载行；如是手工添加的，请自行删除"
}
Write-Host "配置数据 <DshHome>/prompt-inject/config.json 已保留。重启 dsh web 后生效。"
