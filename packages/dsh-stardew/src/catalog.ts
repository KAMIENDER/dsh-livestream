import { EXTRA_READ, EXTRA_WRITE } from './extension.js';

/** Reviewed upstream V1 tools plus this repository's explicit companion V1 contract. */
export const READ_TOOLS: readonly string[] = [
  'stardew_query_runtime', 'stardew_query_players', 'stardew_query_world',
  'stardew_query_inventory', 'stardew_query_ui', 'stardew_inspect',
  ...EXTRA_READ,
];
export const WRITE_TOOLS: readonly string[] = [
  'stardew_say', 'stardew_emote', 'stardew_face', 'stardew_navigate',
  'stardew_interact', 'stardew_use_tool', 'stardew_equip',
  'stardew_open_menu', 'stardew_close_menu', 'stardew_transfer_inventory_item',
  'stardew_set_equipment_slot', 'stardew_move_inventory_item', 'stardew_discard_inventory_item',
  'stardew_craft_item', 'stardew_purchase_shop_item', 'stardew_activate_ui',
  'stardew_skill_water_crops', 'stardew_skill_harvest_crops', 'stardew_skill_refill_watering_can',
  ...EXTRA_WRITE,
];
export const SLEEP = 'stardew_skill_sleep_until_next_day';
export const ALLOWED = [...READ_TOOLS, ...WRITE_TOOLS, SLEEP];
export const REQUIRED = [...READ_TOOLS.filter(name => !EXTRA_READ.includes(name)), 'stardew_navigate', 'stardew_equip', 'stardew_use_tool',
  'stardew_interact', 'stardew_close_menu',
  'stardew_skill_water_crops', 'stardew_skill_harvest_crops', 'stardew_skill_refill_watering_can', SLEEP];

interface Capability {
  id: string;
  title: string;
  scope: 'primitives' | 'workflow' | 'not_implemented';
  tools: string[];
  guidance: string;
}

const CAPABILITIES: readonly Capability[] = [
  {
    id: 'observe', title: '观察世界与角色', scope: 'primitives', tools: [...READ_TOOLS],
    guidance: '先查运行状态、背包与附近地图。扩展提供任务、好感度、日程、动物、建筑、机器、矿层、资源百科与部分事件状态，均有分页或已加载地点限制。没有列出不代表不存在；null 表示未知。Ref 与 Revision 必须来自最新查询。',
  },
  {
    id: 'farming', title: '作物与农具', scope: 'workflow',
    tools: ['stardew_skill_water_crops', 'stardew_skill_harvest_crops', 'stardew_skill_refill_watering_can', 'stardew_equip', 'stardew_interact', 'stardew_use_tool'],
    guidance: '浇水、收获、补水已有上游批量 Skill。workflows 可查本仓库 plant 源码流程：当前地点最多8格，逐步翻地、播种、浇水，核对种子消耗和作物ID，失败保留部分进度。需要扩展cropData精确ID；不清障或自动补水。完整播种流程未实机验证。',
  },
  {
    id: 'gathering', title: '移动与采集', scope: 'primitives',
    tools: ['stardew_face', 'stardew_navigate', 'stardew_equip', 'stardew_use_tool', 'stardew_interact'],
    guidance: '根据真实目标选择斧头、镐或镰刀，走到可操作位置后使用工具，再查目标与背包。支持镐不代表支持矿洞战斗，不把危险区域当作已适配玩法。',
  },
  {
    id: 'husbandry_feed_ground', title: '饲料槽备草与落地产物收取', scope: 'workflow',
    tools: ['dsh_query_husbandry', 'dsh_husbandry', 'stardew_navigate', 'stardew_query_inventory'],
    guidance: 'workflows查animal_feed_prepare和ground_collect。前者用指定品质的背包干草给明确空Trough备料，核对每槽单份消耗、草槽和筒仓不变；填槽不是已吃饱。后者拾取明确普通单件spawned动物产物/采集物，保留原生品质/采集者奖励并核对入袋；目录匹配不是具体动物来源证明。多件堆叠、筒仓取草、牧草放牧、动物实际进食及完整经营仍需后续流程，全部源码未实机验收。',
  },
  {
    id: 'inventory', title: '背包、箱子与装备', scope: 'primitives',
    tools: ['stardew_open_menu', 'stardew_query_inventory', 'dsh_query_inventory', 'dsh_split_stack', 'dsh_query_storage', 'dsh_storage_ui', 'stardew_query_ui', 'stardew_transfer_inventory_item', 'stardew_set_equipment_slot', 'stardew_move_inventory_item', 'stardew_discard_inventory_item'],
    guidance: 'workflows查storage_transfer：准确普通箱/大箱/已解锁主冰箱实例、位置与类型，1–16个明确方向/源槽/ID/品质/数量，正常打开/关闭并沿用原MCP守恒计划器；双完整库存/UI版本、Native数量与金币独立核对，未知或回滚不明停止。工具需明确允许、等级和实际MCP物品Ref，不自动存走工具、换箱、交换、丢弃或出货。小冰箱/共享/祝尼魔/漏斗/出货箱/自定义类、扩展包容量和全部自主仓储规划另需适配，源码未验收。完整索引的空槽省略item与null等价；缺槽不能补为空。Native实例key/digest与原MCP Ref/revision不是同一协议，不能混用。',
  },
  {
    id: 'food_recovery', title: '背包食用、饮用与原生恢复', scope: 'workflow',
    tools: ['dsh_query_food', 'dsh_consume', 'stardew_query_inventory'],
    guidance: 'workflows查consume_food，明确当前背包ID/品质，每次1份。保留原生禁食/恶心/饱食/饮水/姿态限制，等待动画结束并独立核对真实消耗、生命/体力上限、金币和Buff观察。基础恢复量不作成功承诺，负食用值须明确允许与损失预算；可低资源补给但不重领日动作。星之果实专用提示waiting，不重吃或强关。只有源码未验收，自动补给规划/购食/专用提示与完整战斗生存仍待做。',
  },
  {
    id: 'crafting', title: '原生制作与烹饪批次', scope: 'workflow',
    tools: ['dsh_query_crafting', 'dsh_craft', 'stardew_query_inventory', 'stardew_navigate', 'stardew_craft_item'],
    guidance: 'workflows查craft_recipe：普通背包页或相邻真实厨房/工作台，已学配方1–25次；player/containers分组的ID/品质累计材料预算，齐氏调味料另明确允许和预留。逐次原生右键、真实取料/配方或烹饪记录、产物游标至空槽并与MCP全背包及原生容器新快照核对；未知不再制作。预留日动作供入袋/关闭，不自动买料/腾包、解锁配方或适配所有专用界面；源码未实机验收。旧stardew_craft_item仍只支持普通制作，不代表烹饪。',
  },
  {
    id: 'shopping', title: '普通商店金币实物买卖', scope: 'workflow',
    tools: ['dsh_query_shop', 'dsh_shop_ui', 'stardew_navigate', 'stardew_query_ui', 'stardew_query_inventory', 'stardew_purchase_shop_item'],
    guidance: 'workflows查shop_trade：绑定真实ShopId及当前菜单实例，或当前地点准确OpenShop柜台正常导航/交互；1–16笔明确ID/品质/数量、购买单位上限或出售单位下限，累计购买支出和最低保留金币。卖货不扩张支出额度。原生按营业/店主/方向条件开店和结算售货，MCP执行普通实物购买；新完整背包、Native数量/金币/库存/UI收据核对，未知/部分失败不重卖重买。仍具体主人审核，源码未验收；特殊货币、兑换物、配方/特殊品、回购、回调、自定义类、专用开店问题和持久恢复仍缺，商店售货不是出货箱。',
  },
  {
    id: 'shipping', title: '出货待结算与原生取回', scope: 'workflow',
    tools: ['dsh_query_shipping', 'dsh_shipping', 'stardew_query_inventory', 'stardew_navigate'],
    guidance: 'workflows查shipping_batch：固定真实大出货建筑或迷你箱实例/位置/类型，1–16步准确源槽/ID/品质/数量；单次原生操作键开箱，整堆左键、部分每tick右键1份并拒绝左Shift。大箱部分存入形成多个单份批次，只能取回整个实际最后批次，取回后不提升更早批次；迷你箱独立后备库存/锁、原生菜单替换和压缩只跟踪原物品。新MCP背包与Native待结算侧对称核对，金币不变；待出货不是已到账或已计统计。具体主人审核，源码未验收；特殊物品/未知容器、全夜结算归因和持久恢复仍缺，不冒充普通箱MCP Ref。',
  },
  {
    id: 'night_observation', title: '夜间结算页与余额的独立观察', scope: 'workflow',
    tools: ['dsh_query_night', SLEEP],
    guidance: 'end_day会在一次正常睡眠前后读只读游标。绑定同一观察器、接管、实际存档/玩家/构建和相邻日期，核对真实结算缓存全部分项、分类合计及晨间MCP余额，再写日报和独立经历。结算显示金额不冒充金币到账因果；睡前、DayEnding及DayStarted余额分开，差额未归因。未观察到、旧游标、重启、超限或构建变化只记不可用，不是零收入，也不重复睡觉。只有源码，未安装验收。',
  },
  {
    id: 'social', title: '普通交谈、赠礼和物品求助交付', scope: 'workflow',
    tools: ['dsh_query_npc', 'dsh_query_quests', 'dsh_query_dialogue', 'dsh_npc_action', 'dsh_dialogue', 'dsh_split_stack', 'stardew_navigate', 'stardew_query_inventory'],
    guidance: 'say只是游戏聊天。workflows查npc_talk/gift/deliver/dialogue：实际NPC和当前关系/原生礼物候选；普通单件礼物核对消耗和赠礼次数，ItemDeliveryQuest交付核对精确任务和数量，不直接改关系/完成标记。最多读32步普通对话，问题/事件waiting，不重送；答案需真实全文和可见选项具体审核。原收据只限本连接最近waiting续读；婚恋特殊物品、剧情/其他任务订单、领奖及持久社交恢复仍缺，全部未实机验收。',
  },
  {
    id: 'quest_boards_rewards', title: '任务板接取与日志金币领奖', scope: 'workflow',
    tools: ['dsh_query_quest_ui', 'dsh_query_orders', 'dsh_quest_ui', 'dsh_query_quests', 'stardew_query_inventory'],
    guidance: 'workflows查quest_accept_daily/special_order_accept/quest_claim_money。真实板候选key和合同指纹绑定接取，正常日志定位准确已完成任务/订单并核对金币入账/奖励状态，再返回列表清理与关闭。每日任务可无原生ID，实例key由后端绑定真实对象，不能跨重载复用。接取不等于执行任务，金币领奖不等于捐物/所有订单奖励；条件完整解释、路线和全部任务流程仍缺，具体主人审核，源码未实机验收。',
  },
  {
    id: 'sleep', title: '睡眠与有限跨天经营', scope: 'workflow', tools: [SLEEP],
    guidance: '只能通过 end_day 调用睡眠。完整确认后留下日报；未达到本次天数上限时用 next_day 开始下一天。game_start 重复调用不延长本次预算。',
  },
  {
    id: 'fishing', title: '普通钓鱼与渔具流程', scope: 'workflow', tools: ['dsh_query_fishing', 'dsh_fishing_gear', 'dsh_query_event', 'dsh_fish'],
    guidance: '先查询真实钓竿/附件/水域及分页地点/Default鱼种原文规则；fishing_setup守恒装卸完整配置，fishing_cast在明确站位执行一次最长90秒尝试，核对普通渔获/垃圾/宝箱原生菜单入袋和饵/逐槽磨损。caught与escaped/invalid_cast分开；满包和未知结果保留现场，不重抛、不丢弃。鱼种条件完整求值、硬编码特殊奖励、节日钓鱼及满包后的自主腾挪仍需独立流程，尚未实机验收。',
  },
  {
    id: 'mine_excavation', title: '普通矿石与有限敲石找梯', scope: 'workflow',
    tools: ['dsh_query_mine', 'stardew_query_world', 'stardew_query_inventory', 'stardew_navigate', 'stardew_equip', 'stardew_use_tool'],
    guidance: 'workflows查mine_excavate：固定真实镐和起始层，在明确石头或同层普通Stone中按有限石头/挥镐/观察体力生命预算开采。复用最新MCP实体Ref单次零蓄力动作；耐久下降、破碎/统计、物品入袋和原生掉落分开核对，不生成掉落/预测RNG。find_exit看见现有下梯/竖井即可结束，未自行下层；需杀怪、缺候选/预算或落袋等待未完成都waiting。后续转层用mine_route。巨石资源团、怪物伪装、战斗整合/远处全图找梯、满包整理与持久恢复仍缺；只有源码未验收，仍具体主人审核。',
  },
  {
    id: 'mine_travel', title: '真实矿梯、电梯、竖井与返地面', scope: 'workflow', tools: ['dsh_query_mine', 'dsh_mine_travel', 'stardew_navigate', 'stardew_query_inventory'],
    guidance: 'workflows查mine_route：已在原生矿层中，完整扫描真实图块出口，普通矿梯优先；下行最多8次，电梯只选已解锁实际按钮，返地面核对Mine/SkullCave。竖井明确允许且每次预留15层/45点原生掉血。绑定地点实例/出口/原日预算，正常导航与单次原生输入/明确原生UI，核对实际新层/金币/背包/生命；未知不重做，缺梯waiting。不造梯、传送或改血，不冒充开采、杀怪/全矿探索；入口大厅/火山、无梯找梯、采矿战斗整合、晚间/低资源完整返家及持久恢复仍缺，只有源码未验收。',
  },
  {
    id: 'combat', title: '武器战斗与矿洞', scope: 'primitives', tools: ['dsh_query_mine', 'dsh_combat', 'dsh_input', 'stardew_navigate'],
    guidance: '扩展提供当前怪物/矿层、附近地图动作与完整原生出口扫描，以及最多10秒近战、特殊招式或反向撤退。已有矿梯/电梯/明确竖井转层用mine_route，缺梯不能当完成探索。攻击只作用于附近目标，不自动追怪；矿石采集、找梯、武器完整控制与返程仍需接入并组合，不能保证通层或安全撤离。尚未实机验收。',
  },
  {
    id: 'special_menus', title: '建造、献祭、节日与其他原生界面', scope: 'primitives', tools: ['dsh_query_ui', 'dsh_ui_action', 'dsh_query_event', 'dsh_input'],
    guidance: '扩展投影当前菜单可见组件、部分状态和 UI Revision；木匠放置模式另返回可见地块。按实际 Ref 调原生点击、滚动、按键，小游戏可用限时原生输入。覆盖标为 partial；未投影的控件不能猜，业务成功须查实际进度和资源。尚未实机验收。',
  },
  {
    id: 'farm_systems', title: '动物、建筑、机器与出货', scope: 'primitives', tools: ['dsh_query_farm', 'dsh_query_husbandry', 'dsh_query_catalog', 'dsh_query_progress', 'dsh_animal', 'dsh_husbandry', 'dsh_query_ui', 'dsh_ui_action', 'dsh_input'],
    guidance: 'animals返回真实ID、照料、产物、工具和容量事实；animal_care按ID抚摸及挤奶/剪毛。另有animal_feed_prepare填槽备草、ground_collect核对单件地上蛋/松露等入袋；不是已完成动物实际进食、筒仓取草、牧草放牧、购买、繁殖或售卖。普通数据机器另用machine_cycle，其他建筑/特殊生产/出货仍需专项流程，通用输入不等于完整流程已验证。',
  },
  {
    id: 'machine_production', title: '普通数据机器完整一轮生产', scope: 'workflow',
    tools: ['dsh_query_machine', 'dsh_query_inventory', 'dsh_split_stack', 'dsh_machine', 'stardew_navigate'],
    guidance: 'workflows查machine_cycle参数；投料只确认开始，waiting持久保存，production分页查待办；以原jobId续接，内容指纹匹配并确认入袋才完成。原料/额外材料预算固定，漏斗自动补料须单独显式允许。孵化器、专用界面、陈酿或硬编码特殊生产器仍需独立适配；全部源码未实机验收。',
  },
  {
    id: 'long_term', title: '存档记忆、任务依赖与恢复', scope: 'primitives', tools: ['dsh_get_identity'],
    guidance: 'memory/task/schedule管理模型历史与估算依赖；experiences单独保存后端已核对的玩法结果及日终观察，按存档隔离、跨会话分页读，新会话自动载入少量近期历史，不保存旧Ref供重放。人物库同步有原人物目标和去重/遗忘收据，失败待送不重做动作。production保存机器周期阶段；game_recovery查本会话runId，game_resume仍需现场身份/构建/日期/控制摘要一致，不重置预算。全部源码未验收，完整长期规划与可靠恢复仍缺。',
  },
];

/** Availability is discovered live; scope describes code coverage, never successful gameplay. */
export function capabilityCatalog(available: (name: string) => boolean, id?: string): string {
  const selected = id ? CAPABILITIES.filter(item => item.id === id) : CAPABILITIES;
  if (!selected.length) return `未知玩法。可用分类：${CAPABILITIES.map(item => item.id).join('、')}。`;
  return JSON.stringify({
    evidence: '接口存在仅说明可调用；完整玩法仍需游戏实机验证。',
    approvedTools: ALLOWED.filter(available),
    missingTools: ALLOWED.filter(name => !available(name)),
    capabilities: selected.map(item => ({
      ...item,
      availableTools: item.tools.filter(available),
      missingTools: item.tools.filter(name => !available(name)),
    })),
  });
}
