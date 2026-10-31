# 自主选择游戏与开发接入

当前有两个本地预览包：星露谷驱动，以及 [dsh-game-director](../packages/dsh-game-director/README.md) 游戏导演。导演提供选择游戏、派发源码开发、收集报告和启动已配置游戏会话的代码；早期版本已在本机构建并加载。现已通过独立 MCP 客户端确认真实存档读取及一次转向还原；导演派发和 DSH 自主游玩仍未验证。后续的星露谷连续经营、目录与日报改动仅更新源码，详见[玩法扩展记录](stardew-gameplay.md)。

## 三个边界

1. **游戏驱动**：`packages/dsh-stardew/src/game.ts` 的 `GameDriver`，提供 `start / observe / act / stop`，以及可操作、完成状态。星露谷运行规则位于 `stardew.ts`，固定预算位于 `run-options.ts`，批准工具与玩法覆盖位于 `catalog.ts`。
2. **工具连接**：`mcp.ts` 负责 MCP 连接、工具发现、调用、关闭和未知结果表达。游戏特有的配置读取位于 `config.ts`，不会进入模型上下文。
3. **DSH 与直播**：`agent.ts` 注册工具，`cordis.patch.yml` 提供玩法目标，直播插件接收文字进度和指定窗口画面。

新增游戏可以复用上述结构，优先使用游戏已有的 Mod/API/MCP 接口。完成语义必须由各游戏自己定义：星露谷的一天完成，不能套用为卡牌游戏的一局胜利。

## 以后让 DSH 自己接游戏的流程

```mermaid
flowchart LR
  A[选择想玩的游戏] --> B{已有可用接入}
  B -->|有| C[检查本机游戏与接口]
  B -->|没有| D[开发预设查询官方文档与现有项目]
  D --> E[编写驱动与接入说明]
  E --> F[验证读取与实际动作]
  F --> C
  C --> G[玩法预设自主游玩]
```

“想玩什么”可以由模型根据观众偏好、游戏时长、已安装游戏和可用接口决定。“开发接入”需要一个具备文件读写、终端和文档查询能力的开发预设，现有游戏预设只注册游戏操作工具。

游戏预设继续只操作游戏。新导演包通过 DSH 的 `subagents.startActivation` 选择独立的 `dsh-game-developer` 预设，把缺失接入变成源码开发任务；结果收录为开发者报告。新增源码不会自动安装或变成已验证可玩。

开发任务显式选择配置的 DeepSeek 路由：先读真实游戏或 Mod 源码；拿不到源码时，通过已安装的 REA CLI 静态检查本机程序，记录证据与接入点，再编写桥接。REA 输出不等于原始源码，也不证明游戏动作已经生效。

## 接入状态不能只靠模型自报

建议游戏库记录下列证据阶段，并关联代码版本、平台、游戏/Mod 版本及观察时间：

| 阶段 | 能证明什么 |
| --- | --- |
| source | 已生成并审阅源码 |
| loadable | 已安装并能成功加载 |
| observed | 实际读到当前游戏状态 |
| acted | 一次有界动作得到实际状态变化确认 |
| playable | 完成该游戏定义的一段闭环，例如星露谷正常经营并睡到次日 |

早期 DSH 星露谷预设已达到本机 `loadable` 阶段；配套 SMAPI/MCP 桥接已通过独立 MCP 客户端确认 `observed` 和 `acted`，包括当前存档查询、转向以及还原后的查询。尚未由 DSH 会话完成一天闭环，不能标为 `playable`。后续连续经营扩展仍为 `source`，没有编译或测试。

游戏文本、弹幕和工具返回值只作为运行数据，不能自动变成开发指令。新驱动中的外部程序、依赖和系统要求要明确记录；现有游戏控制会话不能自己扩大为任意 shell 执行。

## 星露谷样例的取舍

2026-10-30 新增可选游戏端扩展 `mods/DshStardew`：当原桥接缺少信息或控制时，在独立 Mod 中提供版本明确的本机协议，DSH 在 `extension.ts` 组合两种连接，保留原寻路与睡眠。新工具显式列入批准目录，不按前缀自动放开。信息读取在游戏线程分页执行，实时输入控制器有时限、身份和取消约束；原生菜单投影标记 partial，不把通用输入视为每个玩法已完成。`persistence.ts` 按真实存档隔离长期记忆，并以变更前检查点防止恢复时重复动作。新扩展和恢复功能均处于 source 阶段，尚未构建或验收。

- 采用能够控制主角的 `luy-0/StardewValley-MCP`；同伴 NPC 控制项目不满足本次独立经营的目标。
- 复用工具 Schema 与睡眠 Skill，在 DSH 层加上计划、调用顺序、游戏日边界及结果核对。
- 单独的 `dsh-stardew` 包便于继续扩展，也避免把星露谷控制依赖加入每位直播插件用户的进程。
- 当前只对接本机游戏。连续经营有固定预算、每日检查点和本次日志，不提供跨会话自动恢复；服务器游戏、可靠长期存档目标仍待实现。自动开发新驱动已有导演包的源码实现，运行效果仍需验证。

上游参考：[公开 MCP 契约](https://github.com/luy-0/StardewValley-MCP/blob/main/spec/mcp/README.md)、[原生交互驱动](https://github.com/luy-0/StardewValley-MCP/blob/main/mod/src/StardewValleyMcp.Mod/Game/Actions/InteractionDriver.cs)、[睡眠流程](https://github.com/luy-0/StardewValley-MCP/blob/main/skill/examples/stardew-sleep-until-next-day/scripts/run.py)。
