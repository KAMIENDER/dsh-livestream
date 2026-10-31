import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Settings } from './config.js';
import { connectionSettings } from './config.js';
import { GameMcpClient, type ToolOutcome } from './mcp.js';

export interface FarmIdentity {
  saveId: string; playerId: string; gameId: string; saveFolder: string;
  gameVersion: string; gameAssemblyVersion: string; gameBuildId: string; controlDigest: string;
}

const page = { offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const text = { type: 'string' };
const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string', minLength: 1, maxLength: 128 }, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 },
} };
const section = (...values: string[]) => ({ type: 'string', enum: values });
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): Tool => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
});

/** Explicit local contract for companion 0.3.0, not dynamically enabled tool-name prefixes. */
export const EXTENSION_TOOLS: readonly Tool[] = [
  tool('dsh_mine_travel', '在已相邻的真实矿层出口上提交一次原生操作键，并按明确模式处理原生返地面/竖井问题或已解锁电梯按钮。绑定地点实例、楼层、出口类型/摘要；等待真实新地点/楼层稳定及背包/金币/生命收据。不直接传送/造梯/改血；竖井须预留15层和45点原生掉血，未知不重做。', {
    operation: section('descend', 'leave', 'shaft', 'elevator'), position, locationKey: text, targetKey: text, targetDigest: text,
    expectedFromLevel: { type: 'integer', minimum: 1, maximum: 1000000 }, destinationLevel: { type: 'integer', minimum: 0, maximum: 120 },
    expectedHealth: { type: 'integer', minimum: 1, maximum: 1000 }, expectedMoney: { type: 'integer', minimum: 0, maximum: 2147483647 }, inventoryDigest: text,
    healthFloor: { type: 'integer', minimum: 1, maximum: 1000 }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000 },
    maxLevelAfter: { type: 'integer', minimum: 1, maximum: 1000000 }, durationMs: { type: 'integer', minimum: 3000, maximum: 45000 },
  }, ['operation', 'position', 'locationKey', 'targetKey', 'targetDigest', 'expectedFromLevel', 'expectedHealth', 'expectedMoney', 'inventoryDigest', 'healthFloor', 'maxHealthLoss', 'maxLevelAfter']),
  tool('dsh_query_night', '只读本接管最近一次换日的被动观察及游标。读取真实结算页已有金额缓存、DayEnding/DayStarted实际余额；未观察到不是零，结算金额和余额净变化不证明因果。配对observerId/afterSequence只筛选新观察，不创建结算页或重新计算价格。', {
    observerId: { type: 'string', format: 'uuid' }, afterSequence: { type: 'integer', minimum: 0, maximum: 2147483647 },
  }),
  tool('dsh_query_shipping', '读取实际大出货箱/迷你出货箱实例、原生待结算库存、最后批次与准确当前菜单。查询不创建迷你个人钱包库存；missing不作空库存。原生key/digest不是MCP Ref/revision，放入待结算不代表金币到账或已计出货统计。', { ...page, position }),
  tool('dsh_shipping', '准确原生出货UI：正常单次操作键开箱、明确ID/品质/数量放入、迷你箱取出、大箱整个实际最后批次取回与空游标关闭。整堆左键，部分每tick右键1份且左Shift未按；大箱部分出货是多个单份批次。原生结算，不手工改货物/金币/统计；未知/部分失败不重做。', {
    operation: section('open', 'deposit', 'withdraw', 'retrieve_last', 'close'), position, targetKey: text, targetDigest: text, revision: text, menuKey: text,
    sourceSlot: { type: 'integer', minimum: 0, maximum: 16383 }, itemKey: text, expectedItemId: text,
    expectedQuality: { type: 'integer', minimum: 0, maximum: 4 }, quantity: { type: 'integer', minimum: 1, maximum: 10000 },
  }, ['operation', 'position', 'targetKey', 'targetDigest', 'revision']),
  tool('dsh_query_shop', '读取当前实际原生商店实例、完整商品摘要、分页价格/库存/回调与普通出售候选；可查附近或明确位置OpenShop柜台原始动作/摘要，不生成商店/商品或调用交易回调。Native实例key与MCP saleRef不同，特殊货币/商品/回调/回购需另适配。', { ...page, itemId: text, quality: { type: 'integer', minimum: 0, maximum: 4 }, position }),
  tool('dsh_shop_ui', '准确原生商店正常柜台交互、逐行滚动、明确源槽/数量/原生单位售价出售与空游标关闭。原生负责金币/回购/统计；部分出售每tick右键1份，要求原生左Shift未按，整堆正常左键。不重卖未知/超时部分，购买仍由原MCP执行。', {
    operation: section('open', 'next_row', 'previous_row', 'sell', 'close'), revision: text, expectedShopId: text, menuKey: text,
    position, stationDigest: text, inventorySlot: { type: 'integer', minimum: 0, maximum: 255 }, itemKey: text,
    expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 }, quantity: { type: 'integer', minimum: 1, maximum: 10000 },
    expectedUnitPrice: { type: 'integer', minimum: 0, maximum: 2147483647 },
  }, ['operation', 'revision', 'expectedShopId']),
  tool('dsh_query_storage', '分页查询附近或明确位置的实际箱子/主冰箱身份、原生数量及当前真实储物菜单/锁/游标。targetKey是本机存活实例引用，不能持久重放。compatibleWithAuditedMcp只对应已核对的普通箱/大箱/主冰箱形状，实际MCP双库存投影仍须完整；特殊/共享/小冰箱等另需适配，查询不创建共享库存。', { ...page, position }),
  tool('dsh_storage_ui', '只对准确targetKey/位置/摘要和revision正常打开或关闭原生储物界面；选择实际空槽/工具槽交互，不自动存入手持物，不转移、不出货、不丢弃或手动解锁。开关前后物品数量/金币应不变，未知原生锁回调不重试。', {
    operation: section('open', 'close'), position, targetKey: text, targetDigest: text, revision: text,
  }, ['operation', 'position', 'targetKey', 'targetDigest', 'revision']),
  tool('dsh_query_crafting', '读取实际制作/烹饪页、已学配方、当前页与真实原生材料容器。只读预计算本构建倒序取料/分类替代/齐氏调味料，不预生成随机产物。世界内查附近厨房/工作台或明确position。引用重载失效，最多64容器/16384槽/128配方页。', {
    ...page, recipeName: text, position,
  }),
  tool('dsh_craft', '原生制作/烹饪操作：普通背包页、明确厨房/工作台、翻页、单次右键制作、准确游标产物入空槽和正常关闭。所有操作绑定revision；craft必须明确模式、配方key、player/containers分组的ID/品质材料预算及调味料许可。实际材料/原生统计/产物核对，未知不重做；不直接创建物品或改统计。', {
    operation: section('open_backpack', 'open_station', 'next_page', 'previous_page', 'craft', 'store', 'close'), revision: text,
    position, stationDigest: text, inventoryDigest: text, recipeKey: text, mode: section('crafting', 'cooking'),
    maxCount: { type: 'integer', minimum: 1, maximum: 1 }, allowSeasoning: { type: 'boolean', default: false },
    materialBudget: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false,
      required: ['sourceKind', 'itemId', 'quality', 'maxCount'], properties: { sourceKind: section('player', 'containers'), itemId: text,
        quality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 } } } },
    destinationSlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 }, expectedCount: { type: 'integer', minimum: 1, maximum: 999 },
  }, ['operation', 'revision']),
  tool('dsh_get_identity', '读取路径隔离的存档身份和当前控制状态摘要；用于记忆与恢复校验。'),
  tool('dsh_query_progress', '分页读取实际存档的任务、友情、已学配方、收藏、邮件、事件、成就、献祭、统计和特殊订单。任务显示文字只读缓存，不触发懒加载生成；null 表示字段不可读/未加载。', {
    ...page, section: section('overview', 'quests', 'friendships', 'recipes', 'cooking', 'collections', 'mail', 'events', 'achievements', 'community', 'stats', 'special_orders'),
  }),
  tool('dsh_query_social', '分页读取已加载 NPC 的位置、生日和当天已加载日程。好感度/送礼次数另查 progress.friendships；不推断未加载的日程。', { ...page, name: text }),
  tool('dsh_query_npc', '查询当前地点唯一NPC的位置/原生生日/关系/普通礼物候选及actor/inventory digest。stateOnly读取实际玩家对应名字的关系/任务/金币账本，不创建或假定NPC在场；查询不探测任务交付、不执行随机条件。', {
    npcName: { type: 'string', minLength: 1, maxLength: 128 }, stateOnly: { type: 'boolean' },
  }, ['npcName']),
  tool('dsh_query_quests', '分页当前真实玩家任务；实例key绑定当前实际对象，重载失效，原生ID可为空。含ItemDeliveryQuest确切目标/物品/数量，仅取缓存文字，不生成任务/随机描述，不完成或领取奖励。', {
    ...page, questId: text, targetKey: text, state: section('all', 'active', 'completed'),
  }),
  tool('dsh_query_dialogue', '只读当前原生DialogueBox的实际说话人、文本、可见选项和语义revision；未知说话人不由模型指定。与通用UI逐帧revision独立；不能从历史文本猜当前答案。'),
  tool('dsh_query_quest_ui', '读取实际每日任务板/特殊订单板/任务日志的候选、目标key与contractDigest、页码/真实列表、已选任务、奖励缓存及语义revision；含真实玩家账本。不运行懒加载描述/生成任务，未加载奖励额为null。'),
  tool('dsh_query_orders', '分页真实特殊订单的key/生成种子、期限、参与者、目标计数/原文条件及奖励字段。只读原始状态，不调用Grant、注册、完成或提交物品；不代表已解释所有订单机制。', {
    ...page, targetKey: text,
  }),
  tool('dsh_query_food', '分页当前真实背包普通食物/饮料、槽位/品质/原生基础恢复量、食物/库存摘要、原文Buff数据及当前真实生命/体力/增益。可按inventorySlot精确查询；基础量不等于最终恢复，负食用值需明确允许，未知自定义Object不调用其虚方法。', {
    ...page, inventorySlot: { type: 'integer', minimum: 0, maximum: 255 },
  }),
  tool('dsh_consume', '使用当前真实背包一份明确食物，绑定槽位/ID/品质/食物及库存摘要。遵守原生姿态、禁食挑战、恶心/饱食/饮水限制；原生持物/确认后处理器消耗1份，等待动画和原生空闲，核对实际物品/生命/体力/Buff变化，不直接加恢复值。星之果实等专用提示分开waiting；未知或中断不再吃一份。', {
    inventorySlot: { type: 'integer', minimum: 0, maximum: 255 }, expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 },
    foodDigest: text, inventoryDigest: text, maxCount: { type: 'integer', minimum: 1, maximum: 1 },
    allowNegativeEdibility: { type: 'boolean' }, maxHealthLoss: { type: 'integer', minimum: 0, maximum: 1000 }, maxEnergyLoss: { type: 'integer', minimum: 0, maximum: 5000 },
    durationMs: { type: 'integer', minimum: 1000, maximum: 20000 },
  }, ['inventorySlot', 'expectedItemId', 'expectedQuality', 'foodDigest', 'inventoryDigest']),
  tool('dsh_quest_ui', '对实际原生任务界面执行一次明确操作：正常打开日志、列表翻页/选择/返回、接每日任务/特殊订单或领准确金币奖励。按钮点击等待原生鼠标同步并重验语义revision，消耗/金币/任务核对。接取不等于完成；不生成任务或直接调用奖励/完成函数。', {
    operation: section('open_log', 'close', 'next_page', 'previous_page', 'select', 'back_to_list', 'accept_daily', 'accept_order', 'claim_money'),
    revision: text, targetKey: text, contractDigest: text, expectedReward: { type: 'integer', minimum: 1, maximum: 2147483647 },
  }, ['operation', 'revision']),
  tool('dsh_npc_action', '对当前相邻唯一醒着NPC执行一次原生交谈、普通单件礼物或明确ItemDeliveryQuest交付。绑定actor/库存摘要和实际有界堆叠，核对消耗/赠礼次数/任务；特殊交付不能冒充普通礼物，交付不含领奖。仅即时效果，不等于对话结束。', {
    npcName: { type: 'string', minLength: 1, maxLength: 128 }, operation: section('talk', 'gift', 'deliver'), actorDigest: text, inventoryDigest: text,
    inventorySlot: { type: 'integer', minimum: 0 }, expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 },
    maxOfferCount: { type: 'integer', minimum: 1, maximum: 10000 }, questId: text, targetKey: text,
  }, ['npcName', 'operation', 'actorDigest', 'inventoryDigest']),
  tool('dsh_dialogue', '执行一次当前原生对话页操作，匹配真实说话人、语义revision和全文。reveal仅原生finishTyping；advance拒绝问题；choose须当前可见选项key/全文精确唯一。没有默认答案；自动推进发生未批准消耗则未知停止。', {
    npcName: { type: 'string', minLength: 1, maxLength: 128 }, operation: section('reveal', 'advance', 'choose'), revision: text, expectedText: text,
    responseKey: text, responseText: text,
  }, ['npcName', 'operation', 'revision', 'expectedText']),
  tool('dsh_query_farm', '分页读取已加载地点及建筑室内的动物、建筑、机器状态和地图出入口。animals包含真实animalId、位置、抚摸/产物/工具/容量事实；animalId仅用于animals精确筛选。', {
    ...page, section: section('animals', 'buildings', 'machines', 'locations'), animalId: text, locationId: text,
  }),
  tool('dsh_query_catalog', '分页查询当前游戏资源中的物品、价格字段、作物、鱼、动物、建筑、NPC、礼物偏好、配方、任务和献祭等原始资料，含内容 Mod；条件字符串需解释，实际售价仍查商店。', {
    ...page, section: section('objects', 'big_craftables', 'crops', 'fruit_trees', 'weapons', 'tools', 'buildings', 'animals', 'machines', 'characters', 'locations', 'fish', 'quests', 'bundles', 'gift_tastes', 'achievements', 'festivals', 'crafting', 'cooking'), search: text,
  }),
  tool('dsh_query_mine', '读取矿层/怪物、附近Action；travel完整扫描原生矿层出口。mining另读当前普通Stone实例/耐久、真实镐/附魔功率、碎石/经验、完整库存和已存在掉落；分页半径内候选或明确position，空目标与已开采分开。只读缓存，不执行破石、造梯、生成掉落/物品或随机条件；未知类/构建/超限显式不可用。', {
    radius: { type: 'integer', minimum: 1, maximum: 12 }, miningRadius: { type: 'integer', minimum: 1, maximum: 64 }, ...page, position,
  }),
  tool('dsh_query_event', '读取事件、节日、小游戏、钓竿和钓鱼条的真实状态；仅部分字段，缺失不填猜测值。'),
  tool('dsh_query_ui', '投影当前原生菜单的可见组件、文本、状态和 revision；木匠放置界面另有可见地块。世界内返回附近可见地块供 dsh_input.target 瞄准。所有覆盖均为 partial。'),
  tool('dsh_ui_action', '在完全匹配的 UI revision 上点击当前返回的 target、滚动或按键，覆盖原生建造/献祭/任务/社交等界面。提交不等于业务成功，事后须查库存/进度。', {
    revision: text, operation: section('click', 'right_click', 'scroll', 'key'), target: text,
    key: section('Escape', 'Enter', 'Space', 'Up', 'Down', 'Left', 'Right', 'Tab', 'Delete'), delta: { type: 'integer', minimum: -480, maximum: 480 },
  }, ['revision', 'operation']),
  tool('dsh_input', '按当前游戏键位注入短时原生输入；buttons 使用语义键，keys 使用小游戏原生方向键等；合计1–3键。可用当前 UI 查询返回的 target 定位工具/交互瞄准点，等待鼠标同步后才按键。先查 revision，界面或地点变化即停；单次16–2000ms。', {
    revision: text, target: text, buttons: { type: 'array', minItems: 1, maxItems: 3, items: section('use_tool', 'action', 'cancel', 'move_up', 'move_down', 'move_left', 'move_right', 'run', 'menu', 'journal', 'map', 'toolbar_swap') },
    keys: { type: 'array', minItems: 1, maxItems: 3, items: section('Up', 'Down', 'Left', 'Right', 'Space', 'Enter', 'Escape', 'Z', 'X', 'C', 'A', 'S', 'D', 'W', 'LeftShift', 'LeftControl') },
    durationMs: { type: 'integer', minimum: 16, maximum: 2000 },
  }, ['revision']),
  tool('dsh_query_fishing', '读取实际钓竿/饵/鱼钩槽及磨损、gearDigest、库存digest、当前地点原生可钓判断和四向12格水域；分页当前地点及Default原文鱼种规则。水域不是承诺落点，规则不求值随机条件，硬编码奖励另行适配。', {
    ruleOffset: { type: 'integer', minimum: 0 }, ruleLimit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  tool('dsh_query_husbandry', '分页查询当前畜舍原生饲料槽/AutoFeed标志与已加载根地点筒仓，或明确落地产物/采集物及被动拾取资格、来源数量/品质、保守背包容量。原生品质/采集者奖励不在查询时求值；目录匹配不证明具体生产动物。', {
    ...page, section: section('house', 'ground'), position,
  }),
  tool('dsh_husbandry', '在当前相邻明确目标上执行正常玩家checkAction。feed仅用指定品质背包干草填空Trough，消耗恰好1份且不改筒仓；collect_ground仅被动spawned动物产物/采集物，核对地上消失及真实品质/数量入袋。不调用自动喂食、不写饱食度、不丢弃，未知不重放。', {
    position, operation: section('feed', 'collect_ground'), expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 },
    inventorySlot: { type: 'integer', minimum: 0, description: 'feed必须为实际干草来源槽；collect_ground由后端选择真实空/工具槽' },
    maxSourceCount: { type: 'integer', minimum: 1, maximum: 1, description: 'collect_ground必须为1。原生getOne拾取路径仅复制单件，拒绝多件地上堆叠，避免丢失余量；随机奖励另核对' },
    targetDigest: text, inventoryDigest: text,
  }, ['position', 'operation', 'expectedItemId', 'expectedQuality', 'targetDigest', 'inventoryDigest']),
  tool('dsh_fishing_gear', '对实际拥有钓竿执行原生attach或detach_first；绑定背包/渔具digest。原生装配选择槽位，结果必须匹配预期attachmentIndex并守恒全背包及工具附件总量；detach只能移除首个非空附件，返回物进入指定空槽。', {
    rodSlot: { type: 'integer', minimum: 0 }, expectedRodItemId: text, inventoryDigest: text, gearDigest: text,
    operation: section('attach', 'detach_first'), inventorySlot: { type: 'integer', minimum: 0 }, attachmentIndex: { type: 'integer', minimum: 0, maximum: 2 },
    expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 },
  }, ['rodSlot', 'expectedRodItemId', 'inventoryDigest', 'gearDigest', 'operation', 'inventorySlot', 'attachmentIndex', 'expectedItemId', 'expectedQuality', 'maxCount']),
  tool('dsh_fish', '在已确认站位执行一次最长90秒原生抛竿、咬钩、鱼条/可选宝箱及同钓竿来源菜单收取。核对渔获实际入袋、饵消耗和逐槽磨损；完成一次尝试不等于钓到鱼。满包、超时或结果未确认则未知，不重抛、不丢弃物品。', {
    position, rodSlot: { type: 'integer', minimum: 0 }, expectedRodItemId: text, inventoryDigest: text, gearDigest: text,
    expectedGear: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['index', 'itemId', 'quality'], properties: {
      index: { type: 'integer', minimum: 0, maximum: 2 }, itemId: { type: ['string', 'null'] }, quality: { type: 'integer', minimum: 0, maximum: 4 },
    } }, description: '查询返回的完整附件槽身份，包括空槽；按index排序，不能默默消费另一种饵/鱼钩' },
    direction: { type: 'integer', minimum: 0, maximum: 3 }, durationMs: { type: 'integer', minimum: 1000, maximum: 90000 }, healthFloor: { type: 'integer', minimum: 1, maximum: 1000 },
    castPowerPercent: { type: 'integer', minimum: 10, maximum: 100 }, tryTreasure: { type: 'boolean' },
    maxBaitConsumed: { type: 'integer', minimum: 0, maximum: 1 }, maxTackleWear: { type: 'integer', minimum: 0, maximum: 1, description: '每个已有鱼钩槽的单次磨损上限' },
  }, ['position', 'rodSlot', 'expectedRodItemId', 'inventoryDigest', 'gearDigest', 'direction', 'expectedGear']),
  tool('dsh_combat', '对附近怪物执行限时近战/特殊招式或反向撤退；攻击需非镰刀近战武器，超出范围即停，不自动追怪。不保证通关或安全撤离。', {
    mode: section('attack', 'special', 'retreat'), durationMs: { type: 'integer', minimum: 100, maximum: 10000 }, healthFloor: { type: 'integer', minimum: 1, maximum: 1000 },
  }),
  tool('dsh_animal', '对真实animalId执行单次原生抚摸、挤奶或剪毛。先导航到同地点相邻格；自动选择背包中已有的对应工具，核对原生工具目标与容量，并等待动物/产物数量及原生空闲状态确认。提交后未确认或中断则结果未知，不重放。', {
    mode: section('pet', 'milk', 'shear'), animalId: text, locationId: text, expectedProduceItemId: text,
    durationMs: { type: 'integer', minimum: 100, maximum: 10000 }, healthFloor: { type: 'integer', minimum: 1, maximum: 1000 },
  }, ['mode', 'animalId', 'locationId']),
  tool('dsh_query_inventory', '读取当前玩家原生背包槽位、工具实际类型和扩展inventory digest；这个digest与原MCP的inventoryRevision不是同一协议，不能混用。'),
  tool('dsh_query_machine', '读取当前地点精确地块上的机器、产物、计时、内容指纹和原生数据规则/额外材料。条件保持原文不求值；没有输入表示无法据此承诺该原料可用。', { position }, ['position']),
  tool('dsh_split_stack', '把实际背包堆叠的一部分分到已查到的空槽，使用原生getOne复制物品状态并守恒总量；不生成额外物品，不支持工具。需当前扩展digest、明确槽位/数量/物品/品质。', {
    digest: text, sourceSlot: { type: 'integer', minimum: 0 }, destinationSlot: { type: 'integer', minimum: 0 }, quantity: { type: 'integer', minimum: 1, maximum: 10000 },
    expectedItemId: text, expectedQuality: { type: 'integer', minimum: 0, maximum: 4 },
  }, ['digest', 'sourceSlot', 'destinationSlot', 'quantity', 'expectedItemId', 'expectedQuality']),
  tool('dsh_machine', '对当前相邻数据机器执行一次原生投料或收取，绑定machineDigest和inventoryDigest。投料必须使用不大于maxInputCount的实际堆叠并明确额外材料预算；不会用普通交互误放无效物品。核对实际物品变化和机器状态；投料只算开始生产。', {
    position, operation: section('load', 'collect'), expectedMachineItemId: text, machineDigest: text, inventoryDigest: text,
    allowHopperReload: { type: 'boolean', description: '默认false；原生漏斗可在收取后继续消耗其物料，此权限与玩家背包预算分开' },
    inputSlot: { type: 'integer', minimum: 0 }, inputItemId: text, inputQuality: { type: 'integer', minimum: 0, maximum: 4 }, maxInputCount: { type: 'integer', minimum: 1, maximum: 10000 },
    materialBudgets: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['itemId', 'maxCount'], properties: { itemId: text, maxCount: { type: 'integer', minimum: 1, maximum: 10000 } } } },
  }, ['position', 'operation', 'expectedMachineItemId', 'machineDigest', 'inventoryDigest']),
];

export const EXTRA_READ: readonly string[] = ['dsh_get_identity', 'dsh_query_progress', 'dsh_query_social', 'dsh_query_farm', 'dsh_query_catalog', 'dsh_query_mine', 'dsh_query_event', 'dsh_query_ui', 'dsh_query_inventory', 'dsh_query_machine', 'dsh_query_fishing', 'dsh_query_husbandry', 'dsh_query_npc', 'dsh_query_quests', 'dsh_query_dialogue', 'dsh_query_quest_ui', 'dsh_query_orders', 'dsh_query_food', 'dsh_query_crafting', 'dsh_query_storage', 'dsh_query_shop', 'dsh_query_shipping', 'dsh_query_night'];
export const EXTRA_WRITE: readonly string[] = ['dsh_ui_action', 'dsh_input', 'dsh_fish', 'dsh_combat', 'dsh_animal', 'dsh_split_stack', 'dsh_machine', 'dsh_fishing_gear', 'dsh_husbandry', 'dsh_npc_action', 'dsh_dialogue', 'dsh_quest_ui', 'dsh_consume', 'dsh_craft', 'dsh_storage_ui', 'dsh_shop_ui', 'dsh_shipping', 'dsh_mine_travel'];
const PROTOCOL = 'dsh.stardew.extension.v1';

export class StardewBridge {
  private core = new GameMcpClient();
  private endpoint = '';
  private secret = '';
  private extra = new Map<string, Tool>();
  private clientId = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lifetime = new AbortController();
  identity: FarmIdentity | null = null;

  constructor(private runId: string) {}

  async connect(settings: Settings, signal: AbortSignal): Promise<void> {
    const connection = connectionSettings(settings);
    await this.core.connect(connection.command, connection.env, signal);
    const explicit = settings.extensionConfig?.trim();
    const configPath = explicit ? explicit.startsWith('~/') ? join(homedir(), explicit.slice(2)) : explicit
      : join(dirname(dirname(connection.configPath)), 'DSHStardew', 'config.json');
    if (!existsSync(configPath)) {
      if (explicit) throw new Error('找不到指定的 DSHStardew 扩展配置。');
      return;
    }
    let config: { Port?: unknown; SharedSecretBase64?: unknown };
    try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch { throw new Error('无法读取 DSHStardew 扩展配置。'); }
    const port = Number(config.Port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof config.SharedSecretBase64 !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(config.SharedSecretBase64) || Buffer.from(config.SharedSecretBase64, 'base64').length < 32) throw new Error('DSHStardew 扩展配置无效。');
    this.endpoint = `http://127.0.0.1:${port}/v1`;
    this.secret = config.SharedSecretBase64;
    const capabilities = await this.request('dsh_capabilities', {}, signal, 10_000);
    if (capabilities.status !== 'succeeded' || capabilities.output?.version !== '0.3.0' || capabilities.output?.protocol !== PROTOCOL
      || !Array.isArray(capabilities.output.tools) || !capabilities.output.tools.includes('dsh_get_identity')) throw new Error('游戏端扩展版本不匹配或无法连接；没有退回较少校验的操作方式。');
    for (const definition of EXTENSION_TOOLS) if (capabilities.output.tools.includes(definition.name)) this.extra.set(definition.name, definition);
    const begun = await this.request('dsh_begin', {}, signal, 10_000);
    this.identity = this.readIdentity(begun);
    // Core sleep may take 180s; renew the independent extension lease without issuing game input.
    this.heartbeat = setInterval(() => { void this.request('dsh_heartbeat', {}, this.lifetime.signal, 10_000); }, 30_000);
    this.heartbeat.unref();
  }

  private readIdentity(outcome: ToolOutcome): FarmIdentity {
    const identity = outcome.output as FarmIdentity | undefined;
    if (outcome.status !== 'succeeded' || !identity || !/^[a-f0-9]{64}$/.test(identity.saveId) || !/^[a-f0-9]{64}$/.test(identity.controlDigest)
      || !/^-?\d{1,20}$/.test(identity.playerId) || typeof identity.gameVersion !== 'string'
      || !/^\d+(?:\.\d+){1,3}$/.test(identity.gameAssemblyVersion)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(identity.gameBuildId)) throw new Error('无法确认游戏端扩展的存档和构建身份；新建农场请先正常保存一次。');
    return identity;
  }

  async refreshIdentity(signal: AbortSignal): Promise<FarmIdentity | null> {
    if (!this.identity) return null;
    const next = this.readIdentity(await this.request('dsh_get_identity', {}, signal, 10_000));
    if (next.saveId !== this.identity.saveId || next.playerId !== this.identity.playerId || next.gameBuildId !== this.identity.gameBuildId
      || next.gameAssemblyVersion !== this.identity.gameAssemblyVersion || next.gameVersion !== this.identity.gameVersion) throw new Error('存档或游戏构建身份已变化，停止接管。');
    this.identity = next;
    return next;
  }

  tool(name: string): Tool | undefined { return this.extra.get(name) ?? this.core.tool(name); }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal, timeout?: number): Promise<ToolOutcome> {
    return this.extra.has(name) ? this.request(name, args, signal, Math.min(timeout ?? 100_000, 100_000)) : this.core.call(name, args, signal, timeout);
  }

  private async request(name: string, args: Record<string, unknown>, signal: AbortSignal, timeout: number): Promise<ToolOutcome> {
    const requestId = randomUUID();
    try {
      const body = JSON.stringify({ id: requestId, runId: this.runId, clientId: this.clientId, expectedSaveId: this.identity?.saveId, timeoutMs: timeout, tool: name, args });
      if (Buffer.byteLength(body) > 65536) return { status: 'failed', error: { code: 'arguments_too_large' } };
      const response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
      if (!response.ok || !response.body) throw new Error('extension_http_error');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2_000_000) { await reader.cancel(); throw new Error('extension_response_too_large'); }
        chunks.push(chunk.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (result.protocol !== PROTOCOL || result.requestId !== requestId || result.tool !== name || !['succeeded', 'failed', 'unknown'].includes(result.status)) throw new Error('extension_invalid_envelope');
      return { status: result.status, output: result.output, error: result.error };
    } catch {
      // A timed-out HTTP call may already have changed the game. Never retry it or copy its credentials into an error.
      return { status: 'unknown', error: { code: 'extension_interrupted', message: '扩展调用中断或返回无效，动作结果未知；不要重复提交。' } };
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null; this.lifetime.abort();
    if (this.endpoint) await this.request('dsh_end', {}, AbortSignal.timeout(3000), 3000);
    this.extra.clear(); this.secret = ''; this.endpoint = ''; this.identity = null;
    await this.core.close();
  }
}
