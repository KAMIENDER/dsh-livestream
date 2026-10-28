<p align="center">
  <img src="docs/hero.jpg" alt="大肥鱼直播计划" width="100%">
</p>

<h1 align="center">dsh-livestream</h1>

<p align="center">
  <b>DeepSeek Harness 的直播插件：让 DSH 里的 agent 在 B 站直播间当主播。</b><br>
  默认角色是「大肥鱼」。她自己看弹幕、谢礼物、点播视频、给观众写私信，用自己的声音说话。
</p>

<p align="center">
  <a href="LICENSE"><img alt="code: MIT" src="https://img.shields.io/badge/code-MIT-3f7cf0"></a>
  <a href="packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md"><img alt="大肥鱼素材: CC BY-NC-SA 4.0" src="https://img.shields.io/badge/大肥鱼素材-CC%20BY--NC--SA%204.0-e0763c"></a>
  <img alt="DeepSeek Harness 插件" src="https://img.shields.io/badge/DeepSeek%20Harness-插件-283270">
  <img alt="Bilibili 直播" src="https://img.shields.io/badge/Bilibili-直播-fb7299">
</p>

<p align="center">演示视频：<a href="https://www.bilibili.com/video/BV1xpn66GExn/">《大肥鱼你来B站直播嘛！大肥鱼彩排、Claudia被记仇？》</a>（B 站）</p>

---

## 是真的在直播

<p align="center"><img src="docs/live-proof.jpg" alt="左边本机 DSH 里的她，右边 B 站直播间里的她" width="100%"></p>

左边是本机 DSH 控制台里的她，右边是 B 站直播间里观众看到的她：同一个她，B 站那边晚几秒。插件调 B 站开播接口、驱动本机 OBS 推流，弹幕和礼物从 B 站直播间的消息服务实时收进来。

## 她会做什么

<table>
<tr>
<td width="38%" align="center"><img src="docs/expressions.gif" alt="边说话边换表情" width="100%"></td>
<td>

**自己的声音、自己的表情**
豆包语音合成，字幕按发音一个字一个字亮；她在话里写个 `[shocked]`、`[shy]`，念到那里就换表情。换表情时挑姿势最像的那一帧切，不叠影。

**接住直播间里的事**
弹幕、礼物、SC、上舰、进场、关注，插件按轻重缓急一件一件交给她，她自己决定怎么回。人多的时候先回舰长和老粉，冷场了她会自己找话说。

**记得人**
这一场和以前来过的观众、他们说过的话，她都记得；常来的人会被认出来。

</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/video.jpg" alt="在直播间里放 B 站视频" width="100%"></td>
<td width="50%"><img src="docs/ending.jpg" alt="下播谢幕" width="100%"></td>
</tr>
<tr>
<td><b>点播视频</b>：观众想看什么，她自己去 B 站搜、在直播间里放，她说话时视频自动调小声；还能看主页、写私信。每次用工具，舞台终端里都记一行「调用 …」，观众看得到她做了什么。</td>
<td><b>开播和下播</b>：控制台一键开播，下播前她先道别，舞台出谢幕画面（播了多久、几条弹幕、吃了几粒米、谢谢的人）。右上角的饭碗是这场用掉的 token 换算成的米饭。</td>
</tr>
</table>

## 控制台

<p align="center"><img src="docs/console.jpg" alt="DSH 里的直播控制台" width="100%"></p>

在 DSH 侧边栏打开「直播」：看舞台预览、换皮肤、开播下播、跟她说话、模拟观众（不开播也能彩排）。

## 需要

- Windows，或 macOS 13+（Apple Silicon / Intel；[Mac 安装与配置](docs/macos.md)）
- DeepSeek Harness（网页版）
- OBS Studio 30 以上（开 WebSocket）
- B 站账号的 cookie（开播需要实名认证过的账号）
- 豆包语音（火山引擎）的 API Key / App ID / Access Key

## 安装（开发方式）

```bash
pnpm install
pnpm -C packages/dsh-livestream build
```

把 `packages/dsh-livestream` 链接到 DSH 主目录的插件目录（例如 `$DSH_HOME/profiles/web/node_modules/dsh-livestream`），重启 DSH。

密钥写在 DSH 主目录的 `.env`：

```
BILIBILI_COOKIE=...
DOUBAO_TTS_API_KEY=...
DOUBAO_TTS_APP_ID=...
DOUBAO_TTS_ACCESS_KEY=...
```

然后在 DSH 侧边栏打开「直播」：填房间号，选「本地彩排」或「推流到 B 站」，开播。

### macOS 适配状态

本分支增加了 macOS 的 OBS 路径发现、应用启动、配置读取、H.264 编码选择和游戏窗口捕获。
Apple Silicon + 原生 arm64 Node 默认使用 VideoToolbox；Intel / Rosetta 默认使用 x264。
Windows 默认保留 NVENC 和原有窗口 / WASAPI 音频捕获。

目前完成的是源码适配，尚未编译、运行测试或验证真实推流；安装步骤和待实机确认项见 [macOS 使用说明](docs/macos.md)。

## 许可

- **代码**：MIT（见 [`LICENSE`](LICENSE)）。
- **大肥鱼的动画片段**（`packages/dsh-livestream/assets/characters/dafeiyu/`）：CC BY-NC-SA 4.0，是社区作品的衍生作品，署名和来源见那个目录里的 [`LICENSE.md`](packages/dsh-livestream/assets/characters/dafeiyu/LICENSE.md)。只能非商业使用；商业用途请自备角色素材，或向原作者申请许可。
- `docs/` 里的截图来自演示视频的录制，其中 B 站视频的画面做了模糊处理。
