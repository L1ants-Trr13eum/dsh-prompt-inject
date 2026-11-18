#!/usr/bin/env bash
# dsh-prompt-inject installer (Linux/macOS, or Git-Bash on Windows).
#
#   ./install.sh                      # ~/.dsh + profile "desktop"
#   DSH_HOME=/x DSH_PROFILE=web ./install.sh
#
# Copies package/ into <DSH_HOME>/profiles/<profile>/node_modules/dsh-prompt-inject
# and appends one insert row to that profile's cordis.patch.yml (skipped when the
# row or a bundle declaration already exists). Restart dsh web afterwards.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/package"
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
DSH_PROFILE=${DSH_PROFILE:-desktop}
PROFILE_DIR="$DSH_HOME/profiles/$DSH_PROFILE"
TARGET="$PROFILE_DIR/node_modules/dsh-prompt-inject"
PATCH="$PROFILE_DIR/cordis.patch.yml"

[ -d "$SRC" ] || { echo "缺少 package/ 目录：$SRC" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "找不到 profile 目录：$PROFILE_DIR（用 DSH_PROFILE 指定）" >&2; exit 1; }

mkdir -p "$PROFILE_DIR/node_modules"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -R "$SRC/." "$TARGET/"
echo "已安装到 $TARGET"

if grep -q "name: *dsh-prompt-inject" "$PATCH" 2>/dev/null; then
  echo "cordis.patch.yml 已声明 dsh-prompt-inject，跳过挂载行"
elif grep -q "dsh-prompt-inject" "$PROFILE_DIR/package.json" 2>/dev/null; then
  echo "该 profile 已通过 bundle 通道声明本插件，未写入手工挂载行（二者只能选一）"
else
  [ -f "$PATCH" ] && cp "$PATCH" "$PATCH.bak-prompt-inject-$(date +%Y%m%d-%H%M%S)"
  {
    echo ""
    echo "# dsh-prompt-inject (installed by install.sh)"
    echo "- insert:"
    echo "    - id: prompt-inject"
    echo "      name: dsh-prompt-inject"
  } >> "$PATCH"
  echo "已在 $PATCH 追加挂载行"
fi

echo ""
echo "完成。请完整退出并重启 dsh web，然后在 设置 → 提示词注入 里配置规则。"
echo "配置数据：$DSH_HOME/prompt-inject/config.json"
