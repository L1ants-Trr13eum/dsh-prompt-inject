#!/usr/bin/env bash
# Removes the package and the insert block this installer added. Other rows are untouched.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
DSH_PROFILE=${DSH_PROFILE:-desktop}
PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
TARGET="$PROFILE_DIR/node_modules/dsh-prompt-inject"
PATCH="$PROFILE_DIR/cordis.patch.yml"

rm -rf "$TARGET"
echo "已删除 $TARGET"

if [ -f "$PATCH" ] && grep -q "# dsh-prompt-inject (installed by install.sh)" "$PATCH"; then
  cp "$PATCH" "$PATCH.bak-prompt-inject-uninstall-$(date +%Y%m%d-%H%M%S)"
  awk '
    /# dsh-prompt-inject \(installed by install\.sh\)/ { skip = 4; next }
    skip > 0 { skip--; next }
    { print }
  ' "$PATCH" > "$PATCH.tmp" && mv "$PATCH.tmp" "$PATCH"
  echo "已移除挂载行（备份保留：$PATCH.bak-prompt-inject-uninstall-*）"
else
  echo "未找到由本安装脚本写入的挂载行；如是手工添加的，请自行删除"
fi
echo "配置数据 <DSH_HOME>/prompt-inject/config.json 已保留。重启 dsh web 后生效。"
