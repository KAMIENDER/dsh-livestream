# macOS 使用说明

本分支为 `luckui/dsh-livestream` 增加 macOS 适配。当前仅完成源码修改与静态审阅，尚未编译、运行测试或验证真实直播。

## 环境

- macOS 13 或更新版本，Apple Silicon 或 Intel Mac。
- 与系统、芯片匹配的官方 OBS Studio 30+，启用内置 WebSocket 服务。
- DeepSeek Harness 网页版；Node.js 和 pnpm 使用 DSH 支持的版本。本仓库使用 `node:sqlite`，需 Node.js 22.13+；建议使用原生架构的 [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases)。
- 已配置的模型服务、B 站账号及豆包语音服务，沿用主 README 的配置方式。
- DSH 与 OBS 在同一台 Mac、同一用户下运行。OBS 需要已登录的图形桌面会话。

## 安装和首次设置

从本 fork 的适配分支获取源码：

```bash
git clone --branch feat/macos-support https://github.com/KAMIENDER/dsh-livestream.git
cd dsh-livestream
pnpm install
pnpm -C packages/dsh-livestream build
```

按主 README 将 `packages/dsh-livestream` 链接到实际使用的 DSH 主目录的插件目录，并重启 DSH。这仍是开发安装方式，仓库根目录不是可以直接安装的插件包。

1. 从 [OBS 官网](https://obsproject.com/download) 下载对应 Mac 的版本，放到 `/Applications/OBS.app` 或 `~/Applications/OBS.app`。
2. 手动打开一次 OBS，完成初始设置。在「工具 → WebSocket 服务器设置」启用服务器并保留密码认证；插件会从本机 OBS 配置读取端口和密码，无需把密码写入聊天或提交到仓库。
3. 在 DSH 的直播控制台点击「检查 OBS」。插件会使用独立的 `dsh-livestream` 配置和场景集合，加载舞台浏览器源，返回预览截图；这个按钮不推流。
4. 先用「本地彩排」确认角色、字幕、语音和视频点播。舞台声音由 OBS 浏览器源直接送入混音器，不需要桌面音频捕获或虚拟声卡。
5. 准备正式直播时，再选择「推流到 B 站」并开播；B 站要求身份验证时按控制台提示完成。

窗口捕获需要在「系统设置 → 隐私与安全性」中允许 OBS 录制屏幕与系统音频（具体名称随 macOS 版本变化）。授权后如 OBS 提示重启，请重启 OBS。

## OBS 路径和编码器

默认读取 `~/Library/Application Support/obs-studio`。OBS 安装在自定义位置，或它本身使用非默认配置目录时，可以在启动 DSH 的环境中设置：

```bash
export DSH_LIVESTREAM_OBS="/Applications/OBS.app"
export DSH_LIVESTREAM_OBS_CONFIG="$HOME/Library/Application Support/obs-studio"
export DSH_LIVESTREAM_ENCODER=auto
```

`DSH_LIVESTREAM_OBS` 也接受 `.app/Contents/MacOS/OBS` 可执行文件的完整路径。配置目录变量仅改变插件读取的位置，不会迁移 OBS 配置或改变 OBS 自己的配置目录。未设置时直接使用默认值即可。

| 编码选项 | 行为 |
| --- | --- |
| `auto`（默认） | macOS 13+ 且 DSH 使用原生 arm64 Node 时选 Apple VideoToolbox H.264；Intel / Rosetta 使用 x264。Windows 保留 NVENC。 |
| `videotoolbox` | 要求 macOS 13+ 和原生 arm64 Node，使用 Apple H.264 硬件编码及其参数。 |
| `x264` | 使用 CPU 软件编码，可用于硬件编码不可用时的手动回退。CPU 占用取决于场景和机器性能。 |
| `nvenc` | 保留 Windows 路径；macOS 会提示改用 `auto` 或 `x264`。 |

这几种配置均使用 CBR、2 秒关键帧和控制台指定的码率，默认 4500 kbps、1080p30。VideoToolbox 的 CBR 在 OBS 中要求 Apple Silicon 和 macOS 13+，所以 Intel 不直接套用这套硬件参数。

`auto` 按平台与 Node 架构选择，不会在推流失败后自动切换编码器。如果 OBS 报硬件编码器不可用，可设置 `DSH_LIVESTREAM_ENCODER=x264` 后重启 DSH，再检查 OBS。调整编码设置前应先停止推流和录制。

## 游戏窗口和声音

网页游戏画面仍由原有 `GameSource.url` 路径播放。对于原生窗口，macOS 使用 OBS 的 ScreenCaptureKit 源 `screen_capture`，同时捕获目标窗口的画面及对应应用音频，不创建 Windows 的 WASAPI 源。

游戏插件传入 `GameSource.window` 时，macOS 接受：

- OBS 窗口列表里的完整显示名，例如 `[Minecraft] Minecraft 1.21`。
- 唯一的完整窗口标题，例如 `Minecraft 1.21`。
- 数字窗口 ID 的字符串；这个 ID 可能在窗口或应用重开后变化，应重新获取。

插件从 OBS 当前返回的窗口列表解析 ID，不做模糊匹配。有多个同名窗口或找不到窗口时会报错，窗口源保持禁用；不会选择第一个窗口或退回全屏捕获。请先打开目标窗口并完成 OBS 的录屏授权。

HUD 布局和音量控制沿用原来的舞台逻辑。本次修改覆盖直播插件的捕获入口；外部 `dsh-game` 插件及具体游戏自身的 macOS 兼容性需要分别确认。Windows 的 `标题:窗口类:程序` 标识不直接用于 Mac。

## 可选的视频听写

已有的 Whisper worker 能使用 CPU，Mac 无需安装 NVIDIA CUDA 包。可单独准备 Python 环境：

```bash
python3 -m venv .asr-venv
.asr-venv/bin/python -m pip install faster-whisper
```

在插件设置中填写 `.asr-venv/bin/python` 的**绝对路径**，CPU 模型可先选 `small`。当前 worker 没有 Metal / MPS 推理实现；这个功能只在视频没有字幕时用于听写，不影响豆包语音合成。

## 待实机确认

以下项目尚未执行，不应把源码适配理解为已通过运行验收：

- 原生 Apple Silicon 与 Intel / Rosetta 的安装及 OBS 启动。
- WebSocket 认证、首次创建配置、已有配置的编码参数更新。
- 浏览器源的角色动画、字幕、TTS 音频、视频点播及自动压低音量。
- 游戏窗口选择、录屏授权、应用音频、HUD 对齐和窗口重开后的重新选择。
- 一次实际开播 / 下播及编码负载、声音同步、网络丢帧。
- Windows 的既有 OBS / NVENC / 窗口 / WASAPI 路径回归。

`tools/deploy-server.sh`、`tools/start-guard.sh`、`tools/restart-dsh.sh` 是原作者的 Windows 运维脚本，本次未改为 Mac 部署工具。Linux 无桌面部署与服务器 / Mac 分离运行也不在本次适配范围内。

## 接口依据

- [OBS macOS Screen Capture](https://obsproject.com/kb/macos-screen-capture-source)
- [OBS WebSocket 协议](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md)
- [OBS ScreenCaptureKit 实现](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-capture/mac-sck-video-capture.m)
- [OBS VideoToolbox 编码器实现](https://github.com/obsproject/obs-studio/blob/master/plugins/mac-videotoolbox/encoder.c)
