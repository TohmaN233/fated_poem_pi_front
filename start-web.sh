#!/usr/bin/env bash
# 独立 Web 前端启动脚本 —— 前端仓库 + 外部游戏包目录
set -euo pipefail

if ! command -v pi &>/dev/null; then
  echo "错误: pi 未安装，请先安装 pi coding agent" >&2
  exit 1
fi
if ! command -v node &>/dev/null; then
  echo "错误: 缺少 Node.js 20+" >&2
  exit 1
fi

FRONTEND_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
cd "$FRONTEND_DIR"

resolve_dir() {
  local p="$1"
  [ -n "$p" ] || return 1
  if [ -d "$p" ]; then
    (cd "$p" && pwd -P)
    return 0
  fi
  return 1
}

GAME_DIR=""
if [ -n "${DEST_POET_GAME_DIR:-}" ]; then
  GAME_DIR="$(resolve_dir "$DEST_POET_GAME_DIR")" || {
    echo "错误: DEST_POET_GAME_DIR 指向的目录不存在: $DEST_POET_GAME_DIR" >&2
    exit 1
  }
else
  for candidate in \
    "$FRONTEND_DIR/../fated-poem-dusk-song" \
    "$FRONTEND_DIR/../fated_poem_dusk_song" \
    "$FRONTEND_DIR/../package"; do
    if GAME_DIR="$(resolve_dir "$candidate")"; then
      break
    fi
  done
fi

if [ -z "$GAME_DIR" ]; then
  cat >&2 <<MSG
错误: 未找到游戏包目录。
请把游戏仓库放在本仓库相邻目录，或显式指定：
  DEST_POET_GAME_DIR=/absolute/path/to/fated-poem-dusk-song ./start-web.sh
MSG
  exit 1
fi

for required in \
  "$GAME_DIR/package.json" \
  "$GAME_DIR/extensions/extension.ts" \
  "$GAME_DIR/engine/core/state.ts"; do
  if [ ! -e "$required" ]; then
    echo "错误: 游戏包目录不完整，缺少: $required" >&2
    echo "当前 GAME_DIR=$GAME_DIR" >&2
    exit 1
  fi
done

CARD_TITLE="命定之诗与黄昏之歌"
echo "启动《${CARD_TITLE}》独立 Web 前端..."
echo "前端目录: $FRONTEND_DIR"
echo "游戏目录: $GAME_DIR"

# 游戏包运行依赖仍在游戏目录内安装；本前端不携带游戏代码/依赖。
if [ ! -d "$GAME_DIR/node_modules/rfc6902" ]; then
  if ! command -v npm &>/dev/null; then
    echo "错误: 缺少 npm，无法安装游戏包运行依赖。" >&2
    exit 1
  fi
  echo "首次运行：安装游戏包运行依赖（npm ci --omit=dev）..."
  (cd "$GAME_DIR" && { if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi; })
fi

mkdir -p "$FRONTEND_DIR/user" "$GAME_DIR/sessions" "$GAME_DIR/.pi/agent" "$GAME_DIR/.fated_poem_pi_frontend"

# 将前端仓库携带的桥接扩展复制到游戏目录下的本地隐藏目录。
# 这样桥接扩展能以 ../engine、../data 等相对路径读取游戏包内容，
# 但源码仍由前端仓库维护，且不会把游戏内容提交到前端仓库。
BRIDGE_EXTENSION="$GAME_DIR/.fated_poem_pi_frontend/web-bridge.ts"
cp "$FRONTEND_DIR/bridge/web-bridge.ts" "$BRIDGE_EXTENSION"

if [ ! -f "$GAME_DIR/.pi/agent/auth.json" ] && [ -f "$HOME/.pi/agent/auth.json" ]; then
  cp "$HOME/.pi/agent/auth.json" "$GAME_DIR/.pi/agent/auth.json"
  echo "✓ 已复制认证信息到游戏目录的隔离环境"
fi

if [ ! -f "$GAME_DIR/.pi/agent/models.json" ] && [ -f "$HOME/.pi/agent/models.json" ]; then
  cp "$HOME/.pi/agent/models.json" "$GAME_DIR/.pi/agent/models.json"
  echo "✓ 已复制模型配置到游戏目录的隔离环境"
fi

if [ ! -f "$GAME_DIR/.pi/agent/settings.json" ]; then
  cat > "$GAME_DIR/.pi/agent/settings.json" <<-'JSON'
{
  "theme": "dark"
}
JSON
  echo "✓ 已创建游戏目录隔离配置 (.pi/agent/settings.json)"
fi

SETTINGS_PATH="$GAME_DIR/.pi/agent/settings.json" node - <<'NODE'
const fs = require('fs');
const path = process.env.SETTINGS_PATH;
const dev = process.env.DEST_POET_DEV === '1';
let settings = {};
try { if (fs.existsSync(path)) settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
settings.theme ??= 'dark';
settings.subagents ??= {};
settings.subagents.disableBuiltins = !dev;
fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
NODE

export DEST_POET_FRONTEND_ROOT="$FRONTEND_DIR"
export DEST_POET_GAME_DIR="$GAME_DIR"
export DEST_POET_GAME_EXTENSION="${DEST_POET_GAME_EXTENSION:-$GAME_DIR/extensions/extension.ts}"
export DEST_POET_WEB_BRIDGE_EXTENSION="$BRIDGE_EXTENSION"
export PI_CODING_AGENT_DIR="$GAME_DIR/.pi/agent"
export DEST_POET_WEB_PORT="${DEST_POET_WEB_PORT:-8787}"
export DEST_POET_WEB_HOST="${DEST_POET_WEB_HOST:-}"

if command -v curl &>/dev/null; then
  if curl -fsS "http://127.0.0.1:${DEST_POET_WEB_PORT}/api/health" >/dev/null 2>&1; then
    echo "✓ Web 前端已在运行： http://localhost:${DEST_POET_WEB_PORT}"
    echo "  健康检查： http://localhost:${DEST_POET_WEB_PORT}/api/health"
    exit 0
  fi
fi

node web/server/index.mjs
