# DSH Stardew 游戏端扩展（源码预览）

拆除回收模型继续推进（仍只读、执行未启用）：新增DemolitionRecovery。小屋帮手背包保留原槽顺序，仅在本地引用列表中模拟原生过滤：忽略空槽；对四个精确工具类型各排除最低升级级别的一件，同级取首件；再排除第一把MeleeWeapon的ItemId=47镰刀。升级过的工具也可能被排除。逐件列出原槽/实例/ID/品质/数量/升级级别及保留或排除原因，DSH核对两份名单恰好覆盖原非空背包。`filterModelComplete=true`仅指该过滤源码模型，`filterModelVerifiedInGame/recoveredChestVerified/fullDemolitionRecoveryModelComplete=false`，没有清空、克隆、修改物品或调用原生过滤器。

查询还列出实际BeforeDemolish/performActionOnDemolition/物品遍历/销毁动画/室内移除等派发方法及token，未建模的钩子保持modeled=false。静态证据发现Stable有专用移除马匹钩子；只读遍历已加载根/当前/目标和缓存实例室内，列对应GUID的马、骑手、主人、帽子和过渡标记，不调用findHorse、不把该范围未找到当作原生全局搜索无结果。任务物品只列当前快照观察到的实例与路径，路径数不是原生遍历次数，尚未确认失物招领增量。总体`executionReady/lossModelComplete=false`保持不变。依旧未编译测试、安装、运行新查询或实机拆除。

最新拆除推进是**只读检查源码，尚未启用拆除控制**。`dsh_query_construction` 增加 `demolishBuildingGuid`，读取准确建筑存在性、列明内部/箱/持有产物/任务物品标记、实际小屋帮手名册与背包/装备、地下室分配和已加载物品、失物招领基线，以及原生demolishLock的requested/待执行回调与对应GUID。集合超限或未解析拒绝/标未知，未加载地下室不当空；`executionReady=false`、`lossModelComplete=false`。`building_demolition_preflight` 只读完成不表示已拆除，不写拆除成功经历，当前仍25查询/26控制。

静态核对显示：CarpenterMenu先检查保护房屋/最少数量，原生锁回调再检查施工、动物住户、室内玩家和已激活小屋主人；小屋确认有专用捕获闭包。查询只在真实DialogueBox、精确Game1模块/回调token/CarpenterMenu捕获来源匹配时读取其原父菜单，标记active=false，原目录/控制仍拒绝把它当活动菜单。查询不会调用资格、确认、锁、复制物品、过滤工具、地下室解析或删除处理器。

BeforeDemolish会复制Object.questItem物品到returnedDonations；普通建筑不保证其余室内物品获得回收箱。小屋demolish另会清空其帮手背包，按原生removeInitialTools过滤（包括若干类型中最低升级级别的工具），把剩余物放入新箱子，迁移特定NPC/宠物、重置地下室物品、删除帮手记录/玩家友谊边并重排地下室分配。当前只列观察范围，不把关键物品字段当完整角色备份，也不预测完整回收结果。NetWitnessedLock是在后续Update调用acquired后才清空；控制器停止不能当作已取消排队回调。损失许可、任务物品/回收箱/角色与地下室/子类钩子的完整执行收据和恢复仍待实现。

依据同SHA256/MVID的CarpenterMenu/原生捕获闭包、Building.BeforeDemolish/performActionOnDemolition、Cabin/FarmHouse、Farmer/FarmerTeam、NetWitnessedLock/NetFarmerRef/NetWorldState静态元数据/CIL，未执行目标程序集。未编译测试、安装、运行新查询或拆除游戏建筑；全部实机验收pending。后文的“换皮/涂色”等为之前阶段记录，完整目标仍未完成。

最新换皮源码新增ConstructionActions.Skin / ControlLoop.ConstructionSkin、`dsh_construction_skin` 和 `building_skin`，当前25查询/26控制。查询 `skinBuildingGuid` 只读加载的Game1.buildingData、当前准确建筑/颜色/保护字段，以及实际直接或调色内嵌外观菜单的完整SkinEntry；声明ID/BuildDays与实际已过滤可用外观分开，不调用条件/RNG、TokenParser、构造器或setter来探测。

切换通过实际前后按钮即时生效：原生把三组Default置true，H/S/L保存值不直接改变；当当前施工天数恰好等于基础BuildDays时，还会采用目标外观BuildDays或基础天数。`building_skin` 要求明确maxConstructionDays，先模拟前后两条路径中所有中间项，不只看最终皮肤。已有自定义涂色的重置须allowColorReset；旧ID缺失时打开回退基础外观须allowOpeningFallback；世界格打开会把旧式tint变白，非白色仍须allowTintReset。null明确选择基础外观。已是声明内目标外观的观察单列，不冒充本次造成了变更或完成施工。

复用真实木匠/巫师入口、画笔模式/有限镜头与共享颜色校验；实际允许的直接或嵌套菜单正常打开/选择/关闭，不创建新菜单或直接写皮肤/颜色/天数。嵌套关闭时原生可重建或关闭调色父菜单，按新状态收尾；已有施工仅放行当前调色窗口的done，不放开新的调色入口。界面步骤独立完整背包/金币/资源、其他建筑结构/颜色、列明内部/住户/home网络标识/出口和已观察色板逐步核对；入口导航的拾取等沿用入口独立收据。具体主人审核、原日预算/pending/F9保留，无可复用换皮授权；修改即时生效，未知不回滚或重放。

依据同SHA256/MVID游戏DLL的BuildingSkinMenu/SkinEntry、SetSkin两重载、原生关闭回调、BuildingPaintMenu及已核对Game1.buildingData字段、GetData和IClickableMenu.exitThisMenu静态元数据/CIL，未执行目标程序集。未编译测试、安装或实机切换。基础/条件/分开建造外观、直接/嵌套/父菜单重建、三组默认色与施工规则/中间项、回退/旧式tint许可、全部保护字段、日终/预算/F9/断连/人为接管、出口通行、可靠恢复等验收全部pending。拆除、全部专用设施及完整游戏/人设/记忆/权限目标仍未完成；后续旧阶段计数为历史记录。

最新调色源码：新增ConstructionActions.Paint / ControlLoop.ConstructionPaint及 `dsh_construction_paint`，现为25查询/25控制。查询可传 `paintBuildingGuid`，读取实际三组Default/H/S/L、旧式tint、全建筑颜色、真实调色子菜单分区/滑条范围/几何及按同一原生单精度公式计算的可达整数、共享色板摘要和列明的内部/住户/出口保护摘要；不调用CanBePainted的室内解析、构造器、DataLoader、setter或私有回调。原目录/放置操作仍拒绝存在子菜单；读取父菜单及真实子菜单状态不授予跨界面输入。

`building_paint` 复用真实木匠/巫师入口、`enter_paint` 画笔模式及有限镜头，正常点击准确GUID打开原生调色子菜单。按真实分区ID默认色或完整H/S/L，滑条由实际点击/鼠标位置和原生menu.update驱动，极值允许正常拖动越过滑条的互斥右边界；精确不可达值waiting，不取近似值。默认色且滑条已同值时，只有一次明示目标分区中的最近可达微调才会触发原生回调，再设置完整终值。只核对实际颜色字段，不以屏幕渲染观感当作证据。

原生打开时会重置旧式tint为白色，非白色须明确allowTintReset；修改即时生效，done只关闭，不撤销。逐步核对全部分区、其他建筑结构/颜色、完整独立背包/金币/主角资源、列明内部/住户/出口保护字段；已打开子菜单的操作核对共享色板不变，不使用复制/保存色板或外观按钮。F9/期限/断连只释放仍属本操作的活动滑条，保留真实部分颜色，未知不重放或恢复旧色。每步原日预算/pending、具体主人审核不变，无可复用调色授权；已核对分区观察写入经历，缺口或模型计划不写成已完成事实。

依据为同一游戏DLL的CarpenterMenu、BuildingPaintMenu/BuildingPaintColor、RegionData、ColorSliderPanel/BuildingColorSlider、Game1鼠标坐标和IClickableMenu.exitThisMenu静态元数据/CIL；没有执行目标程序集。未编译测试、安装或实机调色。普通/特殊建筑与资格拒绝、三分区/默认色激活/范围/精确极值、UI缩放/原生更新和父子菜单、色板/旧式tint许可、全部保护字段、部分进度/取消退出/F9/断连/预算/人为接管等验收全部pending。换皮、拆除、完整专用设施、全字段存档保全和持久pending恢复仍未完成。后续旧阶段计数与缺口为历史快照。

最新搬移源码：`dsh_query_construction` 可给 `moveBuildingGuid`/`movePosition` 查询准确建筑、已加载内部保护字段、住户及真实目标/附加占地格地面；`dsh_construction_move` 单步使用真实 `moveButton` 与 `receiveLeftClick` 选取/放置，原生仍决定权限、Farmhouse可达性、放置合法性和出口更新。每步绑定GUID/实例、原格/目标格、全建筑/库存/金币、保护及地面摘要，8tick稳定后收据确认。该搬移阶段为25查询/24控制；最新计数见上文，仍未编译测试、安装或实机验收。

原生拿起后不能点取消放弃：取消仅在没有手持建筑时有效。`building_move` 要求明确 `onBlocked=hold|return_origin`；后者仅对已知拒绝/镜头上限，使用同一已拿起建筑的正常原位放置一次，原日预算与资源收尾限制仍保留，未到目标记waiting。F9/未知结果不自动放回，不直接改 `isMoving`、建筑坐标、动物home或出口，不重放。`groundPolicy=preserve` 要求受影响格无对象/地形；`native_clear` 明确许可原生在实际目标/附加格删除对象/地形，并完整列出逐格前后状态，不能将其报告成零地面变化。

保护摘要完整枚举有界建筑存储、内部对象/家具/本地箱/现有冰箱、持有产物/就绪与住户身份/home/基本经营字段；比较准确对象引用、ID/品质/份数等列明字段，**不是每个物品全字段或整个室外世界的序列化**。共享/全局储物、缺失住户/内部或超限拒绝；收据核对内部既有出口按原生门偏移更新、其他出口不变；这不等于已实测新出口可通行。普通/魔法/特殊建筑、Farmhouse、带箱/机器/家具/动物建筑、占地清理/阻挡、缩放/镜头、原位恢复/拒绝、日终/预算/F9/断连/人为接管、完整独立收据及跨进程恢复的验收全部pending。后文旧章节是阶段记录，最新源码补充不改变已安装版本。

2026-10-31新增有限射击、原生木匠菜单建造/升级及持久建筑复查源码，详见本文后续章节；源码、已安装版本和实际可玩验证是三个独立状态。

这个独立 SMAPI Mod 补充原 StardewValley-MCP 未提供的状态与控制，不替换原 Mod、寻路、物品 Ref 或睡眠 Skill。**截至2026-10-31新增动物、背包分拆、机器、钓鱼、社交/任务、食用、原生制作/烹饪、普通储物、商店买卖、出货待结算、矿层转场/普通采矿、固定目标近战、弹弓装卸弹/有限原生射击、木匠菜单自动入口/建造/升级/搬移/涂色/换皮及复查流程仍只有源码，没有编译、安装或实机验证；现有客户端使用以前的构建。当前扩展源码版本0.3.0，25查询/26控制；后文旧阶段计数是当时快照。**

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
| `dsh_query_mine` | 当前矿层/附近Action，travel完整原生矿层出口，mining普通Stone/镐/掉落，combat完整至多128个当前怪物实例与近战武器/冷却/资源 | 不会创建梯子、传送、触发伤害或预测RNG；超限/未知构建明确不可用，通层需导航、采矿、战斗、补给组合 |
| `dsh_query_event` | 节日、事件、小游戏、钓竿及 BobberBar 的部分实时状态 | 不是所有节日和小游戏的专门攻略/自动通关器 |
| `dsh_query_ui` / `dsh_ui_action` | 投影当前原生菜单组件、文本、部分描述，绑定 revision 调原生点击/滚动/按键；点击前定位游戏光标并等待当前/上一帧鼠标状态同步；木匠放置模式返回可见地块 | `partial` 覆盖；组件 visible 与视口相交不保证当前确实绘制，缓存控件由原生处理器再次判断。交易、献祭、建造、升级需事后读资源和进度确认 |
| `dsh_input` | 按当前键位注入语义键，也可注入小游戏原生方向键/Space/X等，合计1–3键、16–2000ms；target 可选当前返回的可见世界地块，先同步光标再按键 | 世界内返回主角附近6格内、视口可见的地块；不证明可达或可交互。可用于工具瞄准、交互和小游戏，不是所有玩法已完成的证明 |
| `dsh_query_fishing` | 真实钓竿/附件/磨损/可装来源、背包与渔具digest、原生可钓判断与四向12格水域；分页当前地点/Default鱼种规则 | 水域不承诺落点；条件只报告原文，不触发随机条件求值，不穷尽硬编码特殊奖励 |
| `dsh_fishing_gear` | 原生attach及首个非空附件卸下，原返回物回到真实背包槽；校验预期物品/品质/数量上限/槽及全量守恒 | 不生成或克隆渔具；高级双槽的完整配置在DSH侧编排，需足够空槽；未知结果不重放 |
| `dsh_fish` | 绑定站位、实际拥有钓竿、完整附件身份与digest，一次最长90秒蓄力/抛竿/咬钩/鱼条/可选宝箱；同钓竿来源菜单逐件收取、原生渔获/库存/饵与磨损收据 | 不设成功条、不生成鱼；脱钩/无效尝试不是钓获。等待宝箱动画和原生空闲，满包保留菜单；超时/取消/未知结果只停止输入，不重抛或强关菜单 |
| `dsh_melee` | 固定原生怪物/生命周期计数与已装备非镰刀近战武器，单次公开普攻/特殊、8帧空闲、损失预算与完整收据；原生死亡事件/最终移除或木乃伊独立终态规则 | 接受动作、普通倒地、具体死亡、伤害/拾取归因与清层分开；范围攻击可影响周围目标/地形，孤立消失/血量/统计/动画均不证明死亡，未知不补打 |
| `dsh_query_slingshot` / `dsh_slingshot_ammo` | 实际原生弹弓/单弹药槽/候选、真实旧式瞄准设置/当前蓄力、全工具附件；原生一次装入/合并/替换/整堆卸下，完整数量守恒 | 加载排除任务/自定义物品，已附原生物品可完整卸下；爆炸弹装入需明确许可。装弹不是发射、弹药消耗或命中；有限射击另用dsh_slingshot_shot，完整战斗与实机验收仍缺 |
| `dsh_slingshot_shot` | 固定目标/生命周期与现有弹弓/弹药，实际旧式或新版瞄准、原生蓄力/公开一次释放、唯一新弹丸/所有者/准确耗弹与飞行结束、完整资源/目标收据 | 消失不证明碰撞/命中/爆炸；取消先原生结束蓄力，未知不重发。爆炸弹发射明确许可，完整战术/避障/持久恢复及实机验收仍缺 |
| `dsh_query_construction` / `dsh_construction` | 实际木匠菜单图纸/原生材料/价格、加载地点建筑GUID/占地/计时；正常目录、放置、原生边缘镜头、新建/升级、取消/关闭与完整收据 | current复用已开菜单，counter自动入口另用dsh_construction_entry；施工开始不等于建成，不赶工/改计时。跨地图入口路线、搬移/涂色/拆除、所有房屋设施和持久中断续接仍缺 |
| `dsh_construction_entry` | 当前地点真实Carpenter柜台/WizardBook正常交互；原生Construct、准确构造地点/分页、揭示或离开，全文/响应/语义版本和原生缓存/回调来源核对 | 不直接开菜单或改解锁，不选收费升级/购买或未知问题；原生营业/施工/墨水条件保留，资源/建筑不变才确认，未知不重放 |
| `dsh_combat` | 旧基础控制，每帧选择最近怪物，限时普攻/特殊或反向移动 | 无完整战斗收据；提交后结束/中断返回unknown，不用作可靠重复战斗，优先固定目标流程；弹弓仍待适配 |
| `dsh_animal` | 按真实ID原生抚摸/挤奶/剪毛；验证原生工具选中的动物，产物/品质/饼干翻倍数量、背包容量及动作结束 | 不含饲喂、收蛋/松露、繁殖、迁移、购买/出售；动作已提交但没完整确认时返回unknown |
| `dsh_query_husbandry` / `dsh_husbandry` | 查询当前原生Trough、AutoFeed、居民、已加载根地点筒仓和被动地上物；正常玩家checkAction填槽或拾取，核对背包/地块/筒仓收据及原生品质/采集者增量 | 填槽只是备料；不强制动物吃草、不提取筒仓、不调用自动喂食、不改饱食度。只取普通单件spawned动物目录产物/forage，非任务/机器；成堆源拒绝getOne丢余量路径，满包或阻挡停止 |
| `dsh_query_inventory` / `dsh_split_stack` | 查询原生槽位与扩展digest；用原生getOne作守恒分拆，目标必须空槽，验证全背包数量变化为零 | 扩展digest不是MCP inventoryRevision；不支持工具拆分、容器转移或伪造物品 |
| `dsh_query_machine` / `dsh_machine` | 当前地点普通数据机器的内容指纹、计时、原始规则、额外材料；调用目标机器自身的原生投料/收取方法，记录实际增减 | 投料只算开始；孵化器、专用InteractMethod和特殊生产器需独立适配；随机重算产物保留实际收据，不提前承诺结果 |
| `dsh_get_identity` | 存档路径、游戏 ID、主角 ID 隔离的 saveId；位置/金币/生命/体力/库存/工具/上次落盘存档摘要 | 控制摘要不是整个活动世界的序列化。持久控制要求已经正常保存过的农场 |

信息分页每页最多100项；部分嵌套结构最多128项、深度3层。UI 最多投影512个普通组件，另有当前木匠放置地块。缺字段或未返回对象不等于零、否定或不存在。原生游戏仍决定操作条件、金币材料消耗和实际结果。

`machine_cycle`在DSH侧持久保存完整一轮流程：投料后waiting，实际内容匹配、成熟并入袋后才completed。原料堆叠限制和额外材料预算约束玩家背包；原生漏斗可能在收取后异步继续消耗其物料，所以默认要求单独明确`allowHopperReload`。条件字符串不在只读查询时求值，避免把带随机性的规则求值伪装成纯事实读取。

0.2.0曾增加钓鱼身份/耗材约束；当前0.3.0进一步绑定真实任务实例key及任务界面/金币收据，DSH侧严格匹配0.3.0，防止旧端忽略新字段。线包格式仍为`dsh.stardew.extension.v1`。后续食用、制作/烹饪、储物、商店、矿层、近战及弹弓装弹接口按实际发现启用，当前源码为24个查询、20个控制。依据REA静态读取本机相关类型的方法/可见性/CIL；没有加载目标代码或运行这些流程。

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

新增MiningFacts并接入`dsh_query_mine.mining`，当时不新增写接口，为23查询/18控制。只对已核对构建的原生MineShaft读取普通Object.IsBreakableStone、真实岩石实例/耐久、镐升级/原生附魔/功率、碎石和经验、完整库存与原有Debris缓存；大资源团只用于排除重叠目标。候选分页/明确位置分开，物体16384、资源团256、掉落2048/每实例2048块有完整性上限。未知自定义物品/附魔或超限拒绝，不调用Pickaxe.DoFunction、checkStoneForItems、collect、InitializeItem或Debris.item惰性getter来伪造观察。

原生Pickaxe一次减耐久max(1,升级+1)+additionalPower，破碎后才经原生OnStoneDestroyed生成随机掉落/矿梯并更新碎石；DSH流程复用已安装协议及固定上游UseToolHandler/ToolUseDriver的单次真实动作和原生实体Ref，不复制这些副作用。只静态读取本机Pickaxe/Debris/ResourceClump/Stats/Chunk及既有Object/GameLocation/MineShaft元数据/CIL，未执行目标代码、构建测试、安装或游戏动作。普通石头源码不是巨石/战斗/全层探索已适配。

## 固定目标近战（源码预览，未验收）

新增`dsh_query_mine.combat`和`dsh_melee`，当前23查询/19控制。依照同一游戏DLL的元数据/CIL：`MeleeWeapon.leftClick(Farmer)`为公开普通近战入口，`animateSpecialMove(Farmer)`为公开特殊招式入口，内部自行检查原生冷却并派发事件。没有反射调用私有beginSpecialMove/protected specialCooldown，没有直接调用damageMonster、写怪物血量、重置冷却或制造掉落。

combat完整读取至多128个当前Monster实例、256槽内实际原生MeleeWeapon及其类型常量对应家族/属性/原生附魔/冷却、全背包数量和主角资源。实例key不因同名或同槽物品被替换而复用，也不能跨重载使用；特殊冷却不计入装备身份摘要。原生范围攻击可能同时影响其他怪物和地形，固定目标只约束选择与瞄准，不保证唯一受伤对象。

一次dsh_melee绑定存档/日期/地点/怪物/生命周期计数/武器、背包摘要和预期生命/金币，在当前范围内只调用一次入口；补查输入派发依赖的桥上/只能步行、泳衣/游泳、农场事件/对话/聊天/小游戏姿态，不以公开入口绕过限制。接纳状态和连续8tick空闲分开观察，生命下降按可读tick累计，恢复不返额度。保存此前怪物的对象引用，移除目标也保留前后血量/在场性与生命周期；后来出现的怪物单列。死亡规则见下文，伤害与拾取归因仍不宣称已证明。

旧dsh_combat仍是逐帧改选最近目标的基础控制。本次修正为上述公开入口，并标记所有已提交动作；没有完整收据时结束/中断返回unknown，不能当作成功后持续追打。新流程、原始近战工具均保留具体主人审核，没有可复用战斗范围。源码未编译测试、安装、操作游戏或创建实际批准/经历；需分别验收四个原生近战家族的普攻/特殊、冷却、原生多段/范围效果、怪物受击无敌、受伤/恢复、目标移除/复活、替换/停止/F9/租约/超时及重复requestId。弹弓与完整战斗生存未完成。

生命周期读取固定在Monster基类原有deathAnimEvent字段及NetEvent0.Counter，只读本机准确类型/构建的实际值；没有调用Fire/Poll/Clear、修改计数或订阅回调。已静态核对Fire先Counter+1再正常Poll，Poll不清Counter；普通规则要求同实例计数恰好+1、非正血量、最终移出当前完整角色列表、原生MonstersKilled增加和完整动作/资源收据同时成立。计数缺失/下降/回绕不能当新生命，未知机制无规则便不确认。附带怪物也逐实例记录；已确认死亡数量超过全局新增击杀数则整个收据未知。

准确原生Mummy的普通倒地会把Health恢复为MaxHealth、设reviveTimer并触发死亡动画，仍在场，不能据动画记死亡。其终态分支可以不增加死亡动画计数，因此另按已静态核对takeDamage/onMonsterKilled的非正血量、原实例最终移除、复活字段可读与击杀新增确认；普通倒地单列targetCollapsedForRevival，拒绝继续攻击倒地对象或续用旧生命周期请求。该规则只覆盖准确原生Mummy，不推广到自定义继承类、未识别复活/变形。特定目标死亡也不是伤害原因、整场遭遇/全层已清或战利品来源证明。所有新规则仍未实机验收。

## 弹弓信息与原生装卸弹（源码预览，未验收）

新增SlingshotActions、dsh_query_slingshot与dsh_slingshot_ammo。完整捕获最多256背包槽、每工具16附件/总4096附件，引用不可重复、物品来自当前游戏程序集；未知或超限显式不可用。实际弹弓本类、单弹药槽、原生附魔、实际弹药实例/品质/数量、原生基础伤害、旧式瞄准选项及当前蓄力只读；基础伤害不含最终随机/武器/增益计算。候选资格按已静态核对的八个原生ID或非大物体的-5/-79/-75类别，不按名称猜，不调用protected canThisBeAttached。原生GetAmmoDamage仅有ID分支，查询不调用发射/碰撞/伤害或随机函数。

装入使用已拥有的整堆来源且不超过明确maxCount，过大需先分拆；原生Tool.attach自己合并、保留余量或替换原弹药，原返回物入真实背包。卸下只取准确整堆及真实空目的槽；原生已附任务物品也可原样卸回，加载候选不包含任务或外部程序集物品。允许原生对象子类，移动实际引用保留其颜色/附加数据；不通过重建同ID物品丢失状态。爆炸弹装入单独allowExplosive=true，不表示允许发射。

共享AttachmentInventory从现有渔具代码抽取总量、所有权与无主引用找回逻辑，钓鱼调用点改用同一实现。来源先暂离背包再执行一次原生attach，避免同一引用同时留在背包与附件；异常时只找回仍未归属库存的实际引用，不恢复旧数量、不复制或重放。后置核对全背包+所有工具附件守恒、其他附件不变、实际装入/卸下数量、地点/资源和当前工具归属。已有弹药的装入需预留一个空恢复槽，原生无变化可明确返回等待；不把部分未知当成功。

原始工具和DSH流程都保留具体主人审核，无可复用战斗范围。未编译测试、安装/更新客户端、装卸弹、发射或创建实际批准/经历。空槽/同弹合并/满堆余量/换弹/整堆卸下、原生不同品质/子类与颜色数据、爆炸弹许可、满包/引用异常/中断及渔具共享逻辑回归全部待验收。旧式/新版瞄准、原生蓄力/释放、射弹产生/飞行/碰撞和命中/伤害/击杀归因仍需专用完整射击流程。

## 原生弹弓射击（新增源码，未验收）

新增SlingshotActions.Shooting和ControlLoop.Slingshot、dsh_slingshot_shot。当前0.3.0源码为24查询/21控制，只有实际工具发现包含新接口时才可用。dsh_query_slingshot新增shooting：实际完整有界弹丸列表（256上限）、公开NetCharacterRef.Get(location)解析的真实所有者、原生速度/位置/destroyMe，以及姿态和真实鼠标瞄准可用性。不能使用BasicProjectile.GetPlayerWhoFiredMe作为所有权证据，因为它在无法解析时回退到Game1.player。

单次控制固定存档/日/主角/地点/怪物实例及生命周期（另明确expectedMummyCollapsed阶段，复活即使不增加事件计数也不能复用旧批准）、已装备准确原生弹弓/附魔、现有弹药实例/品质/数量、全背包/附件摘要和生命/金币。正常限制姿态、生命下限、累计观察损失、射程与位移。原生弹丸也会对非怪物NPC执行getHitByPlayer，因此当前怪物流程在地点内有非怪物角色时不发射，发射后出现则结果未知，未授权友伤或删除已发弹丸。保持真实useLegacySlingshotFiring，不改游戏设置/输入字段；正常屏幕坐标投影后等待新旧鼠标与只读原生aimPos匹配。现代瞄准朝目标；旧式按已核对的40像素高度偏移和反方向渐进拉弓，原生tickUpdate在第5次拖动后才接受足够鼠标运动，不能一次跳到终点后静等。

只在真实蓄力满、原生GetBackArmDistance>4及canPlaySound门已打开时，经公开onRelease一次释放。Farmer.EndUsingTool专门排除弹弓，不能冒充释放入口。随后同一UpdateTicking内、下一次世界更新前同步捕获唯一新BasicProjectile，校对真实所有者、准确弹药ID、原生字段和耗弹1份；保存实际弹丸引用，等待移除/destroyMe和连续8tick空闲，再核对完整背包变化、其他附件、资源及怪物状态。爆炸弹由原生collisionBehavior回调处理，PerformFire传入的explode字段仍为false，故字段与爆炸效果不能混用。原始请求必须明确allowExplosive才允许发射爆炸弹。

取消/超时/接管释放在本次仍拥有的蓄力上调用公开finish（非发射的原生事件）后停止模拟按住；不能自动重发。若正常释放已经返回，后来的用户新蓄力不被当作本次可取消的蓄力。已发弹丸不删除、不倒退弹药或角色状态，结果不完整一律unknown。目标普通终态和准确木乃伊规则复用MeleeActions的只读生命周期；弹丸结束、血量变化、倒地待复活和死亡分开，均不证明这发造成伤害/掉落、碰撞类型、实际命中/爆炸、清层或安全撤退。新控制仍具体主人审核，无可复用战斗范围。

依据为同SHA256 8937c582cad1c1127017944778c4102467bf299aea44869491f28ab0ec84cd73 / MVID e2d77e0c-417e-41ec-b5ab-ab6e915ce317的Slingshot、Farmer、Game1、BasicProjectile/Projectile及NetCharacterRef静态元数据/CIL，没有执行目标程序集。未编译测试、安装/更新客户端或实际发射。两种瞄准/缩放/镜头、移动目标、各原生弹弓/弹药、最后一份耗弹、瞬时近距离碰撞、无命中/反弹/爆炸弹、木乃伊、所有停止时机与断连/期限、人为接管/新输入、完整库存/附件和生命收据的实机验收全部pending。完整碰撞/命中归因、动态避障/战术、低资源返家及持久中断恢复仍待完成。

## 原生木匠菜单新建/升级及施工复查（新增源码，未验收）

新增ConstructionActions/ControlLoop.Construction、dsh_query_construction/dsh_construction，当前0.3.0源码25查询/22控制。查询只读取实际已打开的CarpenterMenu、已过滤的Blueprints/所选Blueprint、已创建的ingredients模板和加载地点建筑；读取已静态核对的纯字段图纸价格/天数，不执行构造器、条件RNG、建造、扣款或完工函数。完整捕获256图纸/建筑、128材料和256背包槽，未知/重复/超限不伪装完整。建筑id原生Guid转持久buildingGuid；菜单、图纸及buildingKey只对应当前对象，不能跨重载执行。

原生单步支持前后图纸、进入放置、鼠标边缘平移、明确格新建或准确GUID升级、取消和关闭；只调用真实菜单receiveLeftClick，由游戏自行取得buildingLock、tryToBuild、ConsumeResources、升级计时、施工登记和返回动画。没有直接调用这些助手、修改建筑/金币/材料/计时、赶工、强制解锁或退款。放置校对当前和旧鼠标的实际世界格及UI坐标，避开取消控件和原生自动边缘平移区，镜头通过正常光标边缘更新；结束/停止仅移开仍由本次持有的边缘光标，不直接改viewport。等待原生回调/返回和8tick稳定才核对结果；提交后未知/期限/断连不再点一次。

原生材料使用Inventory.ReduceId的已有物品索引，索引顺序不是背包槽位顺序契约。预检对每个实际ID/品质要求预算覆盖min(该品质拥有量、该ID总需求)，而非猜一个品质分配；普通任务/自定义材料排除。实际提交后逐ID总扣料必须等于原生模板，逐品质不超批准，金币恰好少原生报价，其他建筑及生命/精力不变。升级绑定原建筑GUID/UpgradeFrom/占地与空闲状态，原生决定实际造型，不把图纸皮肤报价等同于已应用升级造型。

施工视图通过Game1.currentLocation/viewingLocation切换，不等同角色自行走到农场；查询明确分别给出actorPosition、查看场景与viewingLocation，客户端只在真实原生查看状态下核对这些位置。新建确认唯一新GUID和准确类型/皮肤/位置，升级确认同GUID的upgradeName/原生计时或即时终态；开始施工只标constructionStarted，只有正确目标类型且施工/升级计时均为0才constructionReady。跨天/重载应按持久GUID重新读当前字段，旧临时引用和历史计时不作为当前事实。

静态依据为本机同SHA256 8937c582cad1c1127017944778c4102467bf299aea44869491f28ab0ec84cd73 / MVID e2d77e0c-417e-41ec-b5ab-ab6e915ce317的CarpenterMenu/BlueprintEntry、Building、Inventory.ReduceId和Game1位置/查看字段元数据/CIL，未执行目标程序集。所有新增部分未编译测试、安装/更新客户端或实机建造。目录/皮肤、普通/魔法新建与升级、品质预算/不足资源/阻挡/边缘镜头/缩放、延迟锁/取消/断连/人为干预、返回对话、原生跨天完工/重载GUID和独立收据验收全部pending。入口自动处理、移动/拆除/涂色、全部房屋设施、占地可达规划与持久中断恢复仍待完成。

## 真实木匠/巫师书自动入口（新增源码，未验收）

新增ConstructionActions.Entry/ControlLoop.ConstructionEntry和dsh_construction_entry，当前0.3.0源码25查询/23控制。dsh_query_construction.entry读取当前地点已存在的Buildings层Carpenter/WizardBook动作、明确位置/摘要/占用和当前原生服务问题/构造地点选择；entryPosition可读取当前地点的明确入口，不加载其他地图或把旧入口移到新场景。Robin要求柜台南侧相邻格，WizardBook正常相邻格；原生仍检查Robin是否在柜台附近、房屋/建筑施工，以及hasPickedUpMagicInk/hasMagicInk条件。查询不调用这些业务入口来探测。

open复用WorldInteraction，选择真实空槽/工具槽、面对真实目标，在新旧鼠标一致后发送一次正常操作键，不调用carpenters/ShowConstructOptions或构造CarpenterMenu。服务问题必须是原生lastQuestionKey=carpenter、无覆盖afterQuestion并存在Construct/Leave，只允许Construct或Leave。多地点问题必须是pagedResponse、无覆盖afterQuestion，现有_OnPagedResponse为当前地点对象的准确原生<ShowConstructOptions>b__448_0、同一模块，且现有_PagedResponses/页码/条目上限/构造者字段完整；只读取，不替换或调用私有回调。只允许准确目标地点、nextPage/previousPage或cancel，原生单地点自动选择照常观察。

问题框、全文、真实响应、原生回调/缓存与语义版本绑定；自然打字/选项可见性不改成新语义版本，提交前另核对ready/choicesReady、实际组件几何和新旧鼠标。未知来源、不同建造者、收费房屋/社区升级、装修/商店选项及任意其他问题均拒绝。每步完整背包/金币、主角资源与目标地点建筑不变，8tick稳定才确认；营业/解锁/施工限制导致的反馈单列不可用，不把反馈或商店当已进入构造菜单。原生日常反馈可保留现场；不自动点击未知界面。中断/断连/提交后未知不重放。

DSH的counter分支额外要求dsh_construction_entry与stardew_navigate，current保留原有依赖。两条分支均保留原日动作/pending、具体主人审核和无可复用建造授权；低资源/日终仅可离开已核对问题，不再新开入口。静态依据为同一SHA/MVID的GameLocation.performAction/carpenters/answerDialogueAction、ShowConstructOptions/ShowPagedResponses/_ShowPagedResponses、构造回调、Game1问题框和现有WorldInteraction源码；没有执行目标程序集。WizardHouse元数据另确认不覆盖这些入口方法。未编译测试、安装/更新客户端或实际交互；营业/缺席/施工/墨水两路径、单/多地点/合并末页/翻页/取消、可见性/打字/缩放、占用/导航/人为干预和未知回调的实机验收全部pending。跨地图入口路线、搬移/涂色/拆除、全部房屋设施和持久中断续接等总目标仍未完成。
