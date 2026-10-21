# dsh-livestream

DeepSeek Harness（DSH）的直播插件：让 DSH 里的 agent 在 B 站直播间当主播。默认角色是「大肥鱼」。

演示视频：《大肥鱼直播计划》（B 站，链接待补）

## 能做什么

- **直播间**：一个网页舞台（OBS 用浏览器源推流），有角色动画、字幕、弹幕列表、礼物特效、终端和「今天吃了几碗饭」（这场用掉的 token 换算成米饭）。
- **接住直播间里的事**：弹幕、礼物、SC、上舰、进场、关注，由插件按轻重缓急一件一件交给她，她自己决定怎么回。
- **自己的声音**：豆包语音合成，字幕按发音逐字走；说话时换表情。
- **工具**：看观众主页、给观众发私信、搜 B 站视频、看视频字幕、在直播间里放视频、停视频。她每调用一次工具，舞台终端里都记一行，观众看得到她做了什么。
- **记得常客**：本场和以前来过的观众、他们说过的话。
- **开播**：控制台里一键开播（B 站开播接口 + 本机 OBS 推流），下播前她先道别，舞台出谢幕画面。也可以只在本地彩排、不推流。

## 需要

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

## 许可

- 代码：MIT（见 `LICENSE`）。
- 大肥鱼的动画片段（`packages/dsh-livestream/assets/characters/dafeiyu/`）：CC BY-NC-SA 4.0，是社区作品的衍生作品，署名和来源见那个目录里的 `LICENSE.md`。非商业使用；商业用途请自备角色素材，或向原作者申请许可。
