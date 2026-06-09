# fated_poem_pi_前端

《命定之诗与黄昏之歌》pi 游戏包的独立 Web 前端。

本仓库只包含浏览器 UI、Web server 与桥接适配层；不包含游戏世界设定、角色数据、存档、长期记忆库或个人认证信息。游戏内容请使用原游戏仓库/发布包。

## 运行要求

- Unix-like 系统（Linux/macOS 优先）
- Node.js 20+
- npm（用于给外部游戏包安装运行依赖）
- 已安装 `pi` coding agent
- 本仓库旁边或指定路径存在游戏包目录

## 目录放置方式

推荐把本仓库和游戏包放在同一父目录下：

```text
workdir/
  fated_poem_pi_前端/
  fated-poem-dusk-song/       # 原游戏仓库/发布包
```

默认会依次尝试查找：

- `../fated-poem-dusk-song`
- `../fated_poem_dusk_song`
- `../package`

也可以显式指定：

```bash
DEST_POET_GAME_DIR=/absolute/path/to/fated-poem-dusk-song ./start-web.sh
```

## 启动

```bash
./start-web.sh
# 默认访问 http://localhost:8787
```

首次运行时，脚本会：

1. 检查外部游戏包目录是否完整；
2. 在游戏包目录内安装运行依赖（如缺失）；
3. 在游戏包目录内创建本地 `.pi/agent/`、`sessions/` 与 `.fated_poem_pi_frontend/`；
4. 将本仓库的桥接扩展复制到游戏目录的 `.fated_poem_pi_frontend/web-bridge.ts`；
5. 启动本仓库的 Web UI，并让 `pi` 在外部游戏包目录中运行。

## 可选环境变量

```bash
DEST_POET_GAME_DIR=/path/to/game-package
DEST_POET_WEB_PORT=8787
DEST_POET_WEB_HOST=127.0.0.1
DEST_POET_DEV=1
MEMPALACE_RPG_MCP=/absolute/path/mempalace-rpg-mcp
MEMPALACE_RPG_PALACE=off
```

参见 `.env.example`。
