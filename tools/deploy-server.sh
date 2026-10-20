#!/usr/bin/env bash
# 开发用：把插件部署到直播服务器（Windows，DSH 跑在登录的桌面会话里，计划任务 dsh-livestream）。
#   bash tools/deploy-server.sh            构建 → 打包 → 拷过去 → 换插件 → 重启服务器上的 DSH
#   bash tools/deploy-server.sh --no-build 不重新构建，直接拷现在的 lib
# 服务器上的布局：D:\dsh-livestream\{.runtime, packages\dsh-livestream, .dsh-home, tools\pnpm, start-dsh.cmd, run-hidden.vbs, stop-dsh.ps1}
# 只换插件包，不碰服务器上的 .dsh-home（密钥、设置、记忆）。
set -euo pipefail
HOST="${DSH_SERVER:-user@your-server}"
cd "$(dirname "$0")/../packages/dsh-livestream"
export PATH="$(cd ../../tools/node && pwd):$PATH"
if [ "${1:-}" != "--no-build" ]; then node build.mjs; fi
TMP="$(mktemp -d)"
tar -czf "$TMP/plugin.tgz" package.json cordis.patch.yml lib assets stage
scp -q -o BatchMode=yes "$TMP/plugin.tgz" "$HOST:D:/dsh-livestream/plugin.tgz"
rm -rf "$TMP"
ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File D:\\dsh-livestream\\stop-dsh.ps1 & cd /d D:\\dsh-livestream && rmdir /s /q packages\\dsh-livestream && mkdir packages\\dsh-livestream && tar -xzf plugin.tgz -C packages\\dsh-livestream && del plugin.tgz && schtasks /Run /TN dsh-livestream >nul && echo deployed"
