# DSH Stardew 游戏端扩展（源码预览）

这个独立 SMAPI Mod 补充原 StardewValley-MCP 未提供的状态与控制，不替换原 Mod、寻路、物品 Ref 或睡眠 Skill。**截至2026-10-31新增动物、背包分拆、机器、钓鱼、社交/任务、食用、原生制作/烹饪、普通储物、商店买卖和出货待结算流程仍只有源码，没有编译、安装或实机验证；现有客户端使用以前的构建。当前扩展源码版本0.3.0。**

## 接入范围与边界

| 接口 | 源码实现 | 仍需组合或验证 |
| --- | --- | --- |
| `dsh_query_progress` | 任务、好感度与送礼次数、技能、已学配方、收藏、邮件、事件、成就、部分献祭及特殊订单状态，按 section 分页 | 不可读字段为 null；复杂对象有深度/数量限制，非完整存档导出 |
| `dsh_query_social` | 已加载 NPC 位置、生日、当天已加载日程 | 不等于所有 NPC 的全年路线；送礼/婚恋需原生交互及状态核对 |
| `dsh_query_npc` / `dsh_query_quests` | 当前唯一NPC位置/关系/普通礼物候选与原生偏好码、仅玩家账本查询；真实任务和普通ItemDeliveryQuest的明确目标/物品/数量 | 未见过/未加载NPC不创建；显示文本仅缓存，不生成任务或触发懒加载描述RNG；不穷尽特殊订单或领奖 |
| `dsh_npc_action` | 普通交谈、单件礼物或确切ItemDeliveryQuest原生处理器；绑定实际NPC/库存digest，消耗与赠礼次数/完成状态收据 | 特殊物品/目标专属交付/任务订单不冒充普通礼物，不直接写关系或完成标记；即时效果不是对话流程结束 |
| `dsh_query_dialogue` / `dsh_dialogue` | 实际说话人、当前全文/可见选项/语义revision；一次原生揭示/普通页推进或精确答案点击，等待UI鼠标同步 | 自动推进拒绝问题与剧情事件；答案需完整key/文本。没有默认选项，自动推进异常消耗返回unknown；不持久保存旧UI引用 |
| `dsh_query_quest_ui` / `dsh_query_orders` | 当前真实任务板/日志、唯一候选与合同指纹、页码/已选任务和账本；订单期限/参与者/原文目标计数与奖励字段 | 普通任务实例key绑定实际对象，重载失效；不调用懒加载描述、生成任务/求值所有条件，缓存金币未加载为null |
| `dsh_query_food` / `dsh_consume` | 实际背包食物/饮料、基础恢复、当前状态/Buff及原文数据；原生持物/确认后处理器只消耗一份，等待动画并核对物品/资源结果 | 保留禁食挑战、恶心/饱食/饮水/姿态限制，不直接恢复或写Buff；低资源补给仍占预算。负食用值明确许可/损失预留，未知不重吃；星之果实专用提示waiting，自定义Object另适配 |
| `dsh_query_crafting` / `dsh_craft` | 实际已学配方/页面/容器来源及只读取料计划，普通背包制作页、厨房/工作台交互、翻页、原生单次右键制作、游标产物入空槽和正常关闭 | 准确ID/品质/来源累计预算、调味料许可和原生计数/产物核对；不自行创建/消费/加统计，不预览随机产物。满包腾挪、全部解锁/专用制作/持久恢复及实机验收仍缺 |
| `dsh_query_storage` / `dsh_storage_ui` | 当前地点附近或明确位置普通箱/大箱/主冰箱的存活实例、摘要、数量及当前空游标/锁/后备库存；准确目标正常打开/关闭且数量/金币不变 | Native不转移物品，DSH沿用MCP的实际双库存原子转移。小冰箱/共享/祝尼魔/漏斗/出货箱/家具/自定义类、超限UI/扩展背包、全仓规划和持久恢复另需适配；未知锁回调不重试或手动释放 |
| `dsh_query_shop` / `dsh_shop_ui` | 当前真实商店/商品实例、分页价格/库存/特殊语义与普通出售候选、已加载OpenShop柜台；正常交互/逐行滚动、准确整堆或逐份出售、空游标关闭 | 原生负责营业条件、物品/金币、回购与收入统计，不手工结算；购买复用原MCP。部分出售≤999份、每tick一次且原生左Shift未按，整堆≤10000；未知部分不重卖。全货币/兑换/特殊品/回调/工具升级/出货与持久恢复仍缺 |
| `dsh_query_shipping` / `dsh_shipping` | 实际大出货建筑/迷你箱、完整待结算库存与最后批次、准确原生菜单/回调/后备库存；正常单次操作键开箱、原生放入/迷你取出/整个最后批次取回与关闭 | 不手工加金币、统计或删物，不造MCP容器Ref；部分大箱存入是多个单份批次，取回后不提升旧批次。迷你菜单重建/槽压缩只跟踪原物品；特殊物、全夜到账归因和持久恢复仍缺，未验收 |
| `dsh_quest_ui` | 正常开/关日志或已打开板，原生列表翻页/选择/返回、接受每日求助/明确特殊订单、领取准确金币；消耗与金币/任务后置核对 | 不直接加金币/写完成/调用Grant；接取不是执行任务，金币不是全部奖励。与真实鼠标同步，未知停止不重放；日志原生清理destroy条目也按变更记录 |
| `dsh_query_farm` | 已加载地点及建筑室内的动物、建筑、机器、地图出入口；可按地点/动物ID筛选，包含照料/产物/工具/容量事实 | 不把所有动物经营等同于单次抚摸/挤奶/剪毛 |
| `dsh_query_catalog` | 运行中游戏的物品、作物、鱼、动物、建筑、NPC、礼物偏好、配方、任务、献祭等资源，含内容 Mod | 原始条件/配方字符串仍需解释；基础价格不等于当前实际售价 |
| `dsh_query_mine` | 当前矿层、怪物、附近地图 Action/TouchAction | 不会创建梯子、传送或保证能找到所有出口；通层需导航、采矿、战斗、补给组合 |
| `dsh_query_event` | 节日、事件、小游戏、钓竿及 BobberBar 的部分实时状态 | 不是所有节日和小游戏的专门攻略/自动通关器 |
| `dsh_query_ui` / `dsh_ui_action` | 投影当前原生菜单组件、文本、部分描述，绑定 revision 调原生点击/滚动/按键；点击前定位游戏光标并等待当前/上一帧鼠标状态同步；木匠放置模式返回可见地块 | `partial` 覆盖；组件 visible 与视口相交不保证当前确实绘制，缓存控件由原生处理器再次判断。交易、献祭、建造、升级需事后读资源和进度确认 |
| `dsh_input` | 按当前键位注入语义键，也可注入小游戏原生方向键/Space/X等，合计1–3键、16–2000ms；target 可选当前返回的可见世界地块，先同步光标再按键 | 世界内返回主角附近6格内、视口可见的地块；不证明可达或可交互。可用于工具瞄准、交互和小游戏，不是所有玩法已完成的证明 |
| `dsh_query_fishing` | 真实钓竿/附件/磨损/可装来源、背包与渔具digest、原生可钓判断与四向12格水域；分页当前地点/Default鱼种规则 | 水域不承诺落点；条件只报告原文，不触发随机条件求值，不穷尽硬编码特殊奖励 |
| `dsh_fishing_gear` | 原生attach及首个非空附件卸下，原返回物回到真实背包槽；校验预期物品/品质/数量上限/槽及全量守恒 | 不生成或克隆渔具；高级双槽的完整配置在DSH侧编排，需足够空槽；未知结果不重放 |
| `dsh_fish` | 绑定站位、实际拥有钓竿、完整附件身份与digest，一次最长90秒蓄力/抛竿/咬钩/鱼条/可选宝箱；同钓竿来源菜单逐件收取、原生渔获/库存/饵与磨损收据 | 不设成功条、不生成鱼；脱钩/无效尝试不是钓获。等待宝箱动画和原生空闲，满包保留菜单；超时/取消/未知结果只停止输入，不重抛或强关菜单 |
| `dsh_combat` | 最长10秒的附近近战、特殊招式或反向撤退，生命/场景/工具变化停止 | 不追怪、不保证清层或安全脱离；远程/弹弓战斗没有专门控制器，可通过原生工具输入另行适配 |
| `dsh_animal` | 按真实ID原生抚摸/挤奶/剪毛；验证原生工具选中的动物，产物/品质/饼干翻倍数量、背包容量及动作结束 | 不含饲喂、收蛋/松露、繁殖、迁移、购买/出售；动作已提交但没完整确认时返回unknown |
| `dsh_query_husbandry` / `dsh_husbandry` | 查询当前原生Trough、AutoFeed、居民、已加载根地点筒仓和被动地上物；正常玩家checkAction填槽或拾取，核对背包/地块/筒仓收据及原生品质/采集者增量 | 填槽只是备料；不强制动物吃草、不提取筒仓、不调用自动喂食、不改饱食度。只取普通单件spawned动物目录产物/forage，非任务/机器；成堆源拒绝getOne丢余量路径，满包或阻挡停止 |
| `dsh_query_inventory` / `dsh_split_stack` | 查询原生槽位与扩展digest；用原生getOne作守恒分拆，目标必须空槽，验证全背包数量变化为零 | 扩展digest不是MCP inventoryRevision；不支持工具拆分、容器转移或伪造物品 |
| `dsh_query_machine` / `dsh_machine` | 当前地点普通数据机器的内容指纹、计时、原始规则、额外材料；调用目标机器自身的原生投料/收取方法，记录实际增减 | 投料只算开始；孵化器、专用InteractMethod和特殊生产器需独立适配；随机重算产物保留实际收据，不提前承诺结果 |
| `dsh_get_identity` | 存档路径、游戏 ID、主角 ID 隔离的 saveId；位置/金币/生命/体力/库存/工具/上次落盘存档摘要 | 控制摘要不是整个活动世界的序列化。持久控制要求已经正常保存过的农场 |

信息分页每页最多100项；部分嵌套结构最多128项、深度3层。UI 最多投影512个普通组件，另有当前木匠放置地块。缺字段或未返回对象不等于零、否定或不存在。原生游戏仍决定操作条件、金币材料消耗和实际结果。

`machine_cycle`在DSH侧持久保存完整一轮流程：投料后waiting，实际内容匹配、成熟并入袋后才completed。原料堆叠限制和额外材料预算约束玩家背包；原生漏斗可能在收取后异步继续消耗其物料，所以默认要求单独明确`allowHopperReload`。条件字符串不在只读查询时求值，避免把带随机性的规则求值伪装成纯事实读取。

0.2.0曾增加钓鱼身份/耗材约束；当前0.3.0进一步绑定真实任务实例key及任务界面/金币收据，DSH侧严格匹配0.3.0，防止旧端忽略新字段。线包格式仍为`dsh.stardew.extension.v1`。后续食用、制作/烹饪、储物和商店接口按实际发现启用，当前源码为23个查询、18个控制。依据REA静态读取本机相关类型的方法/可见性/CIL；没有加载目标代码或运行这些流程。

## 安装方式（尚未执行）

依据本机游戏 `1.6.15.24356`、SMAPI `4.5.2` 编写，最低要求 SMAPI4.5.2 的 `IInputHelper.Press`。项目直接引用自己安装的游戏程序集，不打包或分发游戏文件。

需要以后构建并安装时：

```bash
dotnet build mods/DshStardew/DshStardew.csproj -c Release -p:GamePath="/实际游戏目录/Contents/MacOS"
```

退出游戏后，将输出目录 `bin/Release/net6.0/` 中的 `DshStardew.dll` 和 `manifest.json` 放进游戏的 `Mods/DSHStardew/`。保留原 `Mods/StardewValleyMCP/`。Windows/Linux 的 `GamePath` 指向实际含 `Stardew Valley.dll` 的目录。

首次启动生成 `Mods/DSHStardew/config.json`：端口默认24643，32字节随机令牌自动生成，只监听127.0.0.1。DSH 本机读取此文件，不把令牌返回模型；不要贴出该文件内容。

随后还需要构建本仓库 `packages/dsh-stardew` 并重启 DSH。扩展配置可留空自动从原 MCP Mod 的相邻目录发现；非默认位置填写 DSH 插件设置 `extensionConfig`。

新农场先通过正常睡眠保存一次；扩展拒绝为未落盘农场创建持久记忆/恢复身份。没有安装本扩展时，DSH 继续只开放原 MCP 能力；显式配置了扩展但连接失败时，拒绝以不完整校验继续接管。

## 协议与生命周期

- `POST http://127.0.0.1:<port>/v1`，`Authorization: Bearer <本机令牌>`。不支持跨域浏览器授权、重定向、远程地址或任意方法执行。
- 请求字段 `id`、`runId`、`clientId` 均为 UUID，另有 `tool`、`args`、`expectedSaveId`、`timeoutMs`；请求最多64KiB。排队请求和控制器都有服务器期限，超过调用期限的请求不再执行。响应包含 `protocol=dsh.stardew.extension.v1`、对应 `requestId` 和 `tool`、`status` 以及 `output/error`。
- `dsh_capabilities` 读固定版本及工具名；`dsh_begin` 获取单客户端租约和当前存档身份。公开操作均验证客户端、存档和单人主机状态。
- DSH 每30秒通过 `dsh_heartbeat` 续租；客户端崩溃后2分钟租约过期。`dsh_end`、回标题、游戏窗口按F9立即停止扩展输入、释放租约。暂停失焦选项在租约开始时临时关闭，释放时恢复原值。
- HTTP线程仅解析、认证、排队；游戏读取、原生方法及按键注入在 UpdateTicking 中执行。一次只运行一个实时控制器，拒绝与其他扩展变更并行。
- 同一租约最多4096条变更记录，重复请求 ID 只返回原任务；不同参数复用 ID 被拒绝。写入后的异常保守返回 unknown，客户端停止后续变更。响应丢失不重试，不因 HTTP 超时判定动作未执行。
- 停止输入不等于关闭钓鱼动画、菜单或暂停游戏；需要查询并处理真实现场。租约只协调本扩展，不阻止用户手动操作或其他独立 Mod 控制游戏。

DSH 端完整参数声明在 [`extension.ts`](../../packages/dsh-stardew/src/extension.ts)，控制预算、日志及检查点在 [`stardew.ts`](../../packages/dsh-stardew/src/stardew.ts) 和 [`persistence.ts`](../../packages/dsh-stardew/src/persistence.ts)。

## 依据与后续验收

- 原桥接固定提交 `9d81eb50270c539bea52b3068029b890ef2243f0` 的 ToolUseDriver 和 UiRuntimeProjector：保留原能力与边界。
- [SMAPI4.5.2 IInputHelper](https://github.com/Pathoschild/SMAPI/blob/4.5.2/src/SMAPI/IInputHelper.cs)：Press 的单输入 tick 语义；[IGameLoopEvents](https://github.com/Pathoschild/SMAPI/blob/4.5.2/src/SMAPI/Events/IGameLoopEvents.cs) 的 UpdateTicking。
- REA 对本机游戏程序集的静态成员/CIL 证据在忽略目录 `.runtime/analysis/`。FishingRod/BobberBar/MeleeWeapon、Farmer、菜单/任务/配方、NPC/动物/建筑、Game1、CarpenterMenu/JunimoNoteMenu 分组读取，避免把大范围读取的资源上限截断当作完整证据。BobberBar.receiveLeftClick 本机方法体为空，所以鱼条控制使用真实输入而非假定菜单点击有效。
- 同一证据显示木匠操作读取 getOldMouseX/Y，按 UI/世界缩放转换并等待鼠标同步后再调用原生处理器。武器 beginSpecialMove/specialCooldown 不是公开 API，因此特殊招式使用原生 action 输入，让游戏处理冷却与交互规则。
- 2026-10-31追加静态证据：`FarmAnimal.pet/CanGetProduceWithTool/GetHarvestBoundingBox`、`Utility.GetBestHarvestableFarmAnimal`、`MilkPail/Shears.beginUsing/DoFunction`及饼干数量分支；`Object.GetMachineData/performObjectDropInAction/checkForAction/AttemptAutoLoad`和实际MachineData定义。文件位于`.runtime/analysis/machine-animal-members-flat.json`、`machine-native-api-flat.json`和`machine-data-members-flat.json`。没有加载或执行目标程序集。
- 同日普通社交证据：`NPC.checkAction/tryToReceiveActiveObject`及任务/订单probe路径，`Friendship`、`Quest/ItemDeliveryQuest.OnItemOfferedToNpc`、`Dialogue/DialogueBox`实际可见性/CIL。证据`.runtime/analysis/social-quest-dialogue-native-20261031`、`social-quest-dialogue-flat.json`以及既有NPC/Farmer静态分组；`finishTyping`仅设当前字符索引，问题只在可见选项上显式选择。未运行目标代码。
- 同日任务板/领奖证据：`QuestLog/Billboard/SpecialOrdersBoard`原生接受/领奖/返回处理器、`Quests.IQuest`、`FarmerTeam.AddSpecialOrder`、`SpecialOrder`、`Objectives.OrderObjective`和奖励类，分别在`.runtime/analysis/quest-board-rewards-*`、`quest-interface-objectives-*`、`quest-team-objectives-*`。每日任务构造器并未保证非空原生ID，故引用绑定实际对象；日志金币点击同时入账和清理领取标记，不能单独调用OnMoneyRewardClaimed。未执行这些方法。
- 同日食用证据：既有Farmer/Game1/Object/GameLocation静态组的`showCarrying/eatHeldObject/eatObject/doneEating`、Eat_Yes、原生基础恢复和外层禁食/姿态限制；`.runtime/analysis/food-buffs-mine-*`、`food-object-data-*`及`food-animation-effects-*`核对实际BuffManager/Buff、MineShaft、ObjectData/ObjectBuffData、FarmerSprite和BuffEffects。普通食用false override、单件减少、星之果实自动开始/上限+34以及特殊提示分支均来自本机CIL，绑定实际MVID。本轮REA分析不加载或执行目标程序集；Mod源码只调用已核对的公开原生处理器，反射仅用于读取字段/属性。

尚需以后逐项验收：钓鱼成功/脱钩/宝箱/满包、各近战武器/技能冷却/撤退受阻、矿洞出口、不同 UI 缩放下的木匠放置、献祭/升级/售卖/动物/婚恋任务流程、每类节日小游戏，以及停止、断线、换档、跨日和检查点恢复。当前代码不能据此标为“全玩法可玩”。

同日制作/烹饪静态证据：既有`stardew-ui-members-flat.json`的`CraftingRecipe`、`fishing-location-inventory-flat.json`的`GameLocation/InventoryMenu`，新增`crafting-page-workbench-*`与`crafting-sources-kitchen-*`的`CraftingPage/Workbench/ItemRegistry/Inventory/FarmHouse`。核对公开原生左右键、类别/野种匹配、倒序取料、调味料、实际配方/烹饪计数、原生厨房/工作台锁和173冰箱格分支。右键固定一次；该路径按明确x/y处理，避免人为移鼠标触发hover的随机产物预览。REA不加载/执行目标程序集，源码只调用已核对公开原生处理器，反射仅只读；无编译测试或实机验收。

上游固定提交的[CraftItemRuntimeAdapter](https://github.com/luy-0/StardewValley-MCP/blob/9d81eb50270c539bea52b3068029b890ef2243f0/mod/src/StardewValleyMcp.Mod/Capabilities/Actions/CraftItemRuntimeAdapter.cs)明确排除烹饪页，故新流程使用实际原生页面而不把旧制作接口当烹饪。容器捕获64个/16384槽，128配方页/4096配方，超限或未知原生类显式停止；native锁回调取消、全部专用制作/解锁和持久中断恢复仍待适配。

同日储物静态证据：`.runtime/analysis/storage-chest-mutex-native-20261031`及`storage-chest-mutex-flat.json`核对实际Chest/NetMutex公开成员；沿用已核对GameLocation的GetFridge/GetFridgePosition/checkAction。绑定同一游戏MVID，仅读取本地Chest.Items，不调用共享库存GetOrCreate。正常空槽/工具槽交互及exitThisMenu不转移物品，前后库存/金币不变才确认；异步锁回调超时/取消可能未结束，不自动重试。

DSH存取批次复用上游固定提交的[转移适配器](https://github.com/luy-0/StardewValley-MCP/blob/9d81eb50270c539bea52b3068029b890ef2243f0/mod/src/StardewValleyMcp.Mod/Capabilities/Actions/InventoryTransferRuntimeAdapter.cs)和[菜单投影](https://github.com/luy-0/StardewValley-MCP/blob/9d81eb50270c539bea52b3068029b890ef2243f0/mod/src/StardewValleyMcp.Mod/Projection/ItemGrabMenuProjector.cs)：准确Chest类、普通/BigChest、真实锁、空游标和完整双库存。原生main fridge支持；world chest带fridge标记的小冰箱排除。UI总格数128上限，扩展背包截断不当完整。双侧新库存、Native数量与金币核对，失败只有双方未变可证明才作为已拒绝；未知不重放。此源码未构建、安装、存取或验收。

同日商店证据位于`.runtime/analysis/shop-native-20261031`、`shop-flat.json`和`shop-cil.txt`：REA静态核对实际ShopMenu字段、Initialize、highlightItemToSell、原生左右键、滚动/关闭和金币结算；沿用GameLocation的OpenShop分支与InventoryMenu.rightClick。原生初始化把出售过滤器绑定到同一ShopMenu；右键在原生旧键盘LeftShift按下时会半堆取物，因此精确部分出售每tick重新拒绝此状态。售价用原生Object.sellToStorePrice乘实际商店float比例后取整，原生自己执行资源/回购/统计变化。没有加载或执行目标程序集。

购买复用上游固定提交的[ShopPurchaseRuntimeAdapter](https://github.com/luy-0/StardewValley-MCP/blob/9d81eb50270c539bea52b3068029b890ef2243f0/mod/src/StardewValleyMcp.Mod/Capabilities/Actions/ShopPurchaseRuntimeAdapter.cs)：只支持普通金币Object实物，排除交易物/动作/回调、配方/特殊品/回购和自动消费。新查询不克隆商品、不生成商店或执行交易回调；商品完整摘要上限4096、分页100、MCP可见行上限16。DSH批次绑定菜单/准确商品行，逐笔核对全背包、金币、限购/售罄并守住累计支出，失败/未知不自动重下。新增21查询/16控制仍0.3.0，未编译测试、安装或实际交易，全部验收pending。

同日出货与输入沿证据：`.runtime/analysis/shipping-building-settlement-native-20261031`及`shipping-building-settlement-flat.json`读取实际ShippingBin/ShippingMenu，既有Farm、Chest、ItemGrabMenu/InventoryMenu与Game1读取原生出货/取回和`didPlayerJustRightClick`；整理在`shipping-cil.txt`、`shipping-building-cil.txt`。`native-action-input-api-20261031`核对SMAPI4.5.2 IInputHelper.IsDown/Press。只静态读取，游戏DLL SHA-256再次匹配既有8937c582…cd73，没有加载执行目标代码。

世界开箱/工作站/柜台/出货入口修正为`WorldInteraction`：真实空槽/工具槽、面对相邻目标，按世界/UI缩放同步鼠标新旧快照，配置操作键已按住则等待；只发一次输入沿。相机缓动可在提交前重投影同一地块，人物/目标改变停止，提交后不重发。不手动调用doAction、设菜单或强写输入状态来绕过原生判定。页内制作点击仍不移鼠标预览；停止后的原生锁回调仍可能待处理，不能重试当回滚。

主出货建筑回调与实际Farm待结算库存绑定，只允许整个最后批次取回；部分放入按原生每份一批。迷你箱使用实际本地/已存在个人钱包库存，查询不GetOrCreate；原生正常打开可创建钱包，只有零物品变化且新库存为空才确认。原生菜单替换/clearNulls后跟踪准确原实例，完整双方数量守恒及金币不变才确认。完整捕获16384槽、迷你容量128、玩家可见256，仍受2MB响应上限；超限或未知类拒绝。原生ShippingMenu.parseItems会合并并更新统计，不在查询中调用，不把待结算当已到账。当前23查询/18控制、仍0.3.0，未编译测试、安装、出货或验收。

## 夜间结算被动观察（新增源码，未验收）

新增只读`dsh_query_night`，当前23查询/18控制，仍0.3.0按实际发现启用。监听SMAPI真实DayEnding、MenuChanged、DayStarted，并在主线程补观察当前菜单。只读取正常ShippingMenu已经计算的categoryTotals/categoryItems/itemValues/singleItemValues缓存，不构造界面、不调用parseItems/售价/任务回调、不修改金钱或统计。原生迭代器在新日期设置后计算出货价格、执行特殊订单回调，再修改钱包；显示页是另一套缓存，不从总额相等推断因果。

只接受已静态核对MVID `e2d77e0c-417e-41ec-b5ab-ab6e915ce317`、原生准确菜单/普通Object、最多64行、每堆1–10000件；所有行乘积、分类分区和总合完整一致。不同/多重菜单、缓存变化、未知物品、溢出/超限、未观察到均不可用，不补零。观察绑定真实run/client/save/player/build和相邻日期，只有当前接管最近一夜的临时缓存，停止/标题/租期失效清空。查询游标不创建或重置观察。

心跳单独允许世界尚未就绪时续原租约，仍核对现有主人、client、实际同存档与单机主机；不放开任何世界读写，不在标题重建租约。DSH正常睡眠先落盘，再读取新序号和独立晨间余额，另存日报/人物经历。缺失观察不会重睡。没有构建测试、安装、更新客户端或实际夜间收支；零出货、升级/保存页、跨季/新年、失联/重启、特殊订单/其他收入归因及全部实机验收仍待做。

## 原生矿层出口和转场（新增源码，未验收）

`dsh_query_mine.travel`补全准确原生MineShaft地图的出口扫描；旧nearbyMapActions仍只是附近文字属性。仅在已静态核对MVID `e2d77e0c-417e-41ec-b5ab-ab6e915ce317`中，按Buildings层且tile-sheet ID为mine识别173下梯、115返地面、174竖井、112电梯。完整捕获最多256×256地图和256出口；物品/地形/角色占用或额外Action/TouchAction标为受阻，未知构建/类型/超限显式不可用，不把附近未见当无梯，也不调用造梯/随机生成方法。

新增`dsh_mine_travel`后当前23查询/18控制，仍0.3.0按实际发现启用。绑定实际地点/地图实例、起始层、出口类型/摘要和当前完整库存/生命/金币，正常相邻空槽或非武器工作工具槽、单次配置操作键。返地面/竖井只点该尝试打开的ExitMine_Leave或Shaft_Jump；电梯先检查真实最低层进度，再点当前原生菜单中唯一可见的准确楼层按钮。菜单实例/全文/几何及鼠标快照复核，无私有回调或直接warp/enterMine调用。

竖井原生随机下落1–15层（靠近220层可能缩短）、扣最多45点血；必须明确容许最坏15层与45点血且掉后仍高于生命下限。只调用正常问题选择；实际下落层数、目的层和原生Mines_Fallen/Mines_FallenFar提示核对，提示仅在无自定义回调时正常关闭。逐个可读游戏tick累计生命下降，回血不返还预算；计量只覆盖观察到的变化，不假装掌握不可读帧的所有伤害。

矿层控制器允许预期地点变化，等待8个稳定观察tick及可操作世界，独立核对新层/原生完整库存、金币不变、无物品减少、体力不降与生命预算。正常途中拾取可为正增量，单列偶然拾取，不冒充挖矿产出或杀怪。超时、停止或结果未知不重试，也不承诺撤销已被游戏接受的输入/转场。仅静态读实际MineShaft/checkAction/enterMineShaft/afterFall、GameLocation问题分支/地图读取及MineElevatorMenu CIL，没有执行目标代码、构建测试、安装或游戏动作。

## 普通矿石只读事实（源码预览，未验收）

新增MiningFacts并接入`dsh_query_mine.mining`，不新增写接口，仍23查询/18控制。只对已核对构建的原生MineShaft读取普通Object.IsBreakableStone、真实岩石实例/耐久、镐升级/原生附魔/功率、碎石和经验、完整库存与原有Debris缓存；大资源团只用于排除重叠目标。候选分页/明确位置分开，物体16384、资源团256、掉落2048/每实例2048块有完整性上限。未知自定义物品/附魔或超限拒绝，不调用Pickaxe.DoFunction、checkStoneForItems、collect、InitializeItem或Debris.item惰性getter来伪造观察。

原生Pickaxe一次减耐久max(1,升级+1)+additionalPower，破碎后才经原生OnStoneDestroyed生成随机掉落/矿梯并更新碎石；DSH流程复用已安装协议及固定上游UseToolHandler/ToolUseDriver的单次真实动作和原生实体Ref，不复制这些副作用。只静态读取本机Pickaxe/Debris/ResourceClump/Stats/Chunk及既有Object/GameLocation/MineShaft元数据/CIL，未执行目标代码、构建测试、安装或游戏动作。普通石头源码不是巨石/战斗/全层探索已适配。
