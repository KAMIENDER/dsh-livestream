import { randomUUID } from 'node:crypto';
import { object, record, requireFact, samePosition, WorkflowIO, type ObjectValue, type Position, type WorkflowPort, type WorkflowReport } from './workflow-context.js';
import { ANIMAL_WORKFLOW, animalCare } from './workflows/animal.js';
import { MACHINE_WORKFLOW, MACHINE_STOP_WORKFLOW, machineCycle, stopMachineTracking } from './workflows/machine.js';
import { FISHING_SETUP_WORKFLOW, FISHING_CAST_WORKFLOW, fishingSetup, fishingCast } from './workflows/fishing.js';
import { ANIMAL_FEED_WORKFLOW, GROUND_COLLECT_WORKFLOW, animalFeedPrepare, groundCollect } from './workflows/husbandry.js';
import { SOCIAL_WORKFLOWS, socialWorkflow } from './workflows/social.js';
import { QUEST_WORKFLOWS, questWorkflow } from './workflows/quests.js';
import { FOOD_WORKFLOW, consumeFood } from './workflows/food.js';
import { CRAFTING_WORKFLOW, craftRecipe } from './workflows/crafting.js';
import { STORAGE_WORKFLOW, storageTransfer } from './workflows/storage.js';
import { SHOP_WORKFLOW, shopTrade } from './workflows/shop.js';
import { SHIPPING_WORKFLOW, shippingBatch } from './workflows/shipping.js';
import { MINE_WORKFLOW, mineRoute } from './workflows/mine.js';
import { MINING_WORKFLOW, mineExcavate } from './workflows/mining.js';
import { PersistenceError } from './persistence.js';
export type { WorkflowReport } from './workflow-context.js';
const PLANT_TOOLS = ['dsh_query_catalog', 'stardew_query_inventory', 'stardew_query_world', 'stardew_navigate', 'stardew_equip', 'stardew_interact', 'stardew_use_tool'];
const parameters = {
  type: 'object', additionalProperties: false, required: ['seedItemId', 'positions'],
  properties: {
    seedItemId: { type: 'string', description: '当前背包的 (O)种子ID，且在当前游戏 cropData 中有同ID记录' },
    positions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false,
      required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } } } },
    water: { type: 'boolean', default: true, description: '需要背包中现有水壶水量；不足时预检停止，不自动离开补水' },
  },
};

export function workflowCatalog(available: (name: string) => boolean): unknown {
  return { evidence: '以下为源码实现状态；没有实机验收记录。每次返回 completed 只表示该次观察满足已列出的后置条件。',
    workflows: [{ name: 'plant', title: '小规模翻地、播种、浇水', sourceStatus: 'implemented_unverified',
      parameters, requiredTools: PLANT_TOOLS, missingTools: PLANT_TOOLS.filter(name => !available(name)),
      scope: '当前已加载地点、最多8格、当前cropData可识别的物体种子；不清理障碍，不处理果树/树种/肥料/巨型作物/收获或生长等待。季节与地点限制交由游戏真实校验。',
      postconditions: ['空格翻地后查询到空耕地', '播种后同格cropId等于种子原始ID且总种子数恰好少1', '要求浇水时，同格同种作物watered为true'],
      failure: '缺前置条件、阻挡、事件菜单、低资源、预算耗尽、接口失败或观察不符立即停止；保留部分进度，无自动补偿、回滚或重放。',
    }, ...[ANIMAL_WORKFLOW, MACHINE_WORKFLOW, MACHINE_STOP_WORKFLOW, FISHING_SETUP_WORKFLOW, FISHING_CAST_WORKFLOW, ANIMAL_FEED_WORKFLOW, GROUND_COLLECT_WORKFLOW, FOOD_WORKFLOW, CRAFTING_WORKFLOW, STORAGE_WORKFLOW, SHOP_WORKFLOW, SHIPPING_WORKFLOW, MINE_WORKFLOW, MINING_WORKFLOW, ...SOCIAL_WORKFLOWS, ...QUEST_WORKFLOWS].map(workflow => ({ ...workflow, missingTools: workflow.requiredTools.filter(name => !available(name)) }))],
  };
}

// WorldProjector reports either an actual TerrainFeature type or the Back layer's Type property.
// Keep this deliberately narrow: an unfamiliar mod terrain is not automatically clearable soil.
const emptySoil = (ground: ObjectValue) => ground.diggable === true && ground.occupied === false && ground.passable === true && ground.pathfindingBlocked !== true
  && ['', 'Dirt'].includes(ground.terrainKind);

/** No caller-supplied tools or scripts: adding another workflow requires an explicit implementation. */
export async function runWorkflow(name: string, text: string, port: WorkflowPort): Promise<WorkflowReport> {
  const report: WorkflowReport = { id: randomUUID(), workflow: name, startedAt: new Date().toISOString(), status: 'stopped', observed: [],
    note: '游戏观察只说明该次子流程，已有状态和未成熟产物单独记为跳过；不代表整套玩法完成。部分执行不回滚，现场变更后重新查询，不盲目重放。' };
  try {
    requireFact(text.length <= 8000, '流程参数过长。');
    const args: unknown = JSON.parse(text);
    if (name === MINING_WORKFLOW.name) {
      report.status = await mineExcavate(args, new WorkflowIO(port, report)); return report;
    }
    if (name === MINE_WORKFLOW.name) {
      report.status = await mineRoute(args, new WorkflowIO(port, report)); return report;
    }
    if (name === SHIPPING_WORKFLOW.name) {
      report.status = await shippingBatch(args, new WorkflowIO(port, report)); return report;
    }
    if (name === SHOP_WORKFLOW.name) {
      report.status = await shopTrade(args, new WorkflowIO(port, report)); return report;
    }
    if (name === STORAGE_WORKFLOW.name) {
      report.status = await storageTransfer(args, new WorkflowIO(port, report)); return report;
    }
    if (name === CRAFTING_WORKFLOW.name) {
      report.status = await craftRecipe(args, new WorkflowIO(port, report)); return report;
    }
    if (name === FOOD_WORKFLOW.name) {
      report.status = await consumeFood(args, new WorkflowIO(port, report)); return report;
    }
    if (QUEST_WORKFLOWS.some(workflow => workflow.name === name)) {
      report.status = await questWorkflow(name, args, new WorkflowIO(port, report));
      return report;
    }
    if (SOCIAL_WORKFLOWS.some(workflow => workflow.name === name)) {
      report.status = await socialWorkflow(name, args, new WorkflowIO(port, report));
      return report;
    }
    if (name === ANIMAL_FEED_WORKFLOW.name || name === GROUND_COLLECT_WORKFLOW.name) {
      const io = new WorkflowIO(port, report);
      if (name === ANIMAL_FEED_WORKFLOW.name) await animalFeedPrepare(args, io);
      else await groundCollect(args, io);
      report.status = 'completed'; return report;
    }
    if (name === FISHING_SETUP_WORKFLOW.name || name === FISHING_CAST_WORKFLOW.name) {
      const io = new WorkflowIO(port, report);
      if (name === FISHING_SETUP_WORKFLOW.name) await fishingSetup(args, io);
      else await fishingCast(args, io);
      report.status = 'completed'; return report;
    }
    if (name === ANIMAL_WORKFLOW.name) {
      await animalCare(args, new WorkflowIO(port, report));
      report.status = 'completed'; return report;
    }
    if (name === MACHINE_WORKFLOW.name) {
      report.status = await machineCycle(args, new WorkflowIO(port, report));
      return report;
    }
    if (name === MACHINE_STOP_WORKFLOW.name) {
      stopMachineTracking(args, new WorkflowIO(port, report));
      report.status = 'completed'; return report;
    }
    requireFact(name === 'plant', '没有这个已实现流程；用 workflows 查看明确目录。');
    requireFact(object(args) && Object.keys(args).every(key => ['seedItemId', 'positions', 'water'].includes(key)), '参数必须是 workflows 声明的 JSON 对象。');
    requireFact(typeof args.seedItemId === 'string' && /^\(O\)[^\s\x00-\x1f]{1,128}$/.test(args.seedItemId), 'seedItemId 必须是背包实际返回的物体种子ID。');
    requireFact(args.water === undefined || typeof args.water === 'boolean', 'water 必须为布尔值。');
    requireFact(Array.isArray(args.positions) && args.positions.length > 0 && args.positions.length <= 8, '每批必须有1–8个明确地块。');
    const positions: Position[] = args.positions.map((p: unknown) => {
      requireFact(object(p) && Object.keys(p).every(key => ['locationId', 'x', 'y'].includes(key))
        && typeof p.locationId === 'string' && p.locationId.length > 0 && p.locationId.length <= 128
        && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x <= 10000 && p.y <= 10000, '地块必须来自实际查询的位置。');
      return { locationId: p.locationId, x: p.x, y: p.y };
    });
    requireFact(new Set(positions.map(p => `${p.locationId}:${p.x}:${p.y}`)).size === positions.length, '同一批不能重复地块。');
    const seedId = args.seedItemId;
    const rawSeed = seedId.slice(3);
    const water = args.water !== false;
    const missing = PLANT_TOOLS.filter(tool => !port.available(tool));
    requireFact(!missing.length, `缺少流程接口：${missing.join('、')}。没有执行游戏变更。`);

    const call = async (tool: string, params: Record<string, unknown>): Promise<ObjectValue> => {
      const result = await port.call(tool, params);
      requireFact(result.status === 'succeeded' && object(result.output), `${tool} 未完成：${result.error?.code ?? result.status}。${result.error?.message ?? ''}没有自动重放。`);
      return result.output;
    };
    const inventory = async (): Promise<ObjectValue> => {
      const value = (await call('stardew_query_inventory', { playerInventory: {} })).snapshot;
      requireFact(object(value) && /^[a-f0-9]{64}$/.test(value.inventoryRevision) && Array.isArray(value.slots), '背包快照不完整。');
      return value;
    };
    const amount = (inv: ObjectValue): number => inv.slots.reduce((sum: number, slot: ObjectValue) => {
      if (slot.item?.qualifiedItemId !== seedId) return sum;
      requireFact(Number.isInteger(slot.item.stack) && slot.item.stack >= 0, '种子数量未知。');
      return sum + slot.item.stack;
    }, 0);
    const equip = async (predicate: (item: ObjectValue) => boolean): Promise<void> => {
      const inv = await inventory();
      const slot = inv.slots.find((slot: ObjectValue) => object(slot.item) && predicate(slot.item));
      requireFact(slot?.item?.ref && typeof slot.item.ref.value === 'string', '没有找到具有当前Ref的所需物品，未猜测槽位。');
      await call('stardew_equip', { itemRef: slot.item.ref, inventoryRevision: inv.inventoryRevision });
    };
    const tile = async (position: Position): Promise<{ ground: ObjectValue; crop?: ObjectValue; soil?: ObjectValue }> => {
      const value = (await call('stardew_query_world', { area: { ...position, width: 1, height: 1 },
        includeCharacters: true, includeEntities: true, includeTiles: true, maxEntities: 64, maxCharacters: 64 })).snapshot;
      requireFact(object(value) && Array.isArray(value.tiles) && Array.isArray(value.entities) && Array.isArray(value.characters)
        && value.entitiesTruncated === false && value.charactersTruncated === false, '地块或占用信息不完整，未操作。');
      requireFact(value.tiles.length === 1 && samePosition(value.tiles[0]?.position, position), '目标不在实际地图返回中。');
      requireFact(!value.characters.some((c: ObjectValue) => samePosition(c.position, position)), '目标格有角色或动物，未操作。');
      const entities = value.entities.filter((e: ObjectValue) => samePosition(e.position, position));
      requireFact(entities.every((e: ObjectValue) => e.kind === 'hoe_dirt' || e.kind === 'crop'), '目标格有物体、建筑或其他地形，未清理。');
      const ground = value.tiles[0];
      requireFact(ground.water === false, '目标是水面或水面信息未知。');
      const crop = entities.find((e: ObjectValue) => object(e.crop))?.crop;
      const soil = entities.find((e: ObjectValue) => object(e.hoeDirt))?.hoeDirt;
      return { ground, crop, soil };
    };
    const ready = (): void => {
      const s = port.current();
      requireFact(s.player.canMove && !s.ui.menuOpen, '当前有菜单、事件或主角不可操作，流程停止。');
      requireFact(positions.every(p => p.locationId === s.player.position.locationId), '仅在当前地点播种，不跨地图追随旧坐标。');
      requireFact(s.timeOfDay < 2200 && s.player.energy >= 30 && s.player.health >= 20, '已到收尾条件，流程停止，请回家睡觉。');
    };
    const initial = await inventory();
    ready();
    requireFact(positions.every(p => Math.abs(p.x - port.current().player.position.x) + Math.abs(p.y - port.current().player.position.y) <= 24), '地块超出本批局部范围，请先导航并重新查询。');
    const data = await call('dsh_query_catalog', { section: 'crops', search: rawSeed, limit: 100, offset: 0 });
    // Full row contents are advisory. The exact asset key, not fuzzy search text or an item's name,
    // establishes that the held object is a crop seed. Native game logic decides planting eligibility.
    requireFact(Array.isArray(data.items) && data.items.some((row: ObjectValue) => row.key === rawSeed), '当前cropData页没有这个种子的精确ID；未把任意物品作为种子。');
    requireFact(amount(initial) >= positions.length, '现有种子不足以完成这批，没有提交变更。');
    requireFact(initial.slots.some((s: ObjectValue) => s.item?.toolKind === 'hoe'), '缺少锄头，没有提交变更。');
    if (water) requireFact(initial.slots.some((s: ObjectValue) => s.item?.toolKind === 'watering_can'
      && (s.item.bottomless === true || Number.isInteger(s.item.waterRemaining) && s.item.waterRemaining >= positions.length)), '现有水壶水量不足，请先补水再规划；没有提交变更。');
    for (const position of positions) {
      const before = await tile(position);
      requireFact(!before.crop, '预检发现已有作物，未覆盖或收获，请重新选择空耕地。');
      requireFact(before.soil || emptySoil(before.ground), '没有确认空耕地或无占用的可锄地块。');
      record(report, 'preflight', { position, ground: before.ground, soil: before.soil });
    }
    for (const position of positions) {
      ready();
      await call('stardew_navigate', { position, arrival: 'adjacent' });
      ready();
      const standing = port.current().player.position;
      requireFact(standing.locationId === position.locationId && Math.abs(standing.x - position.x) + Math.abs(standing.y - position.y) === 1, '导航后未确认在相邻格，未提交农具或交互。');
      let state = await tile(position);
      requireFact(!state.crop, '地块已变化，有现存作物，停止。');
      if (!state.soil) {
        requireFact(emptySoil(state.ground), '目标已不再是无占用的可锄地块。');
        await equip(item => item.toolKind === 'hoe');
        await call('stardew_use_tool', { position, chargeLevel: 0 });
        state = await tile(position);
        requireFact(state.soil && !state.crop, '翻地后未确认空耕地，停止，不再挥锄。');
        record(report, 'tilled', { position, soil: state.soil });
      }
      await equip(item => item.qualifiedItemId === seedId && item.stack > 0);
      const beforeCount = amount(await inventory());
      await call('stardew_interact', { position });
      state = await tile(position);
      const afterCount = amount(await inventory());
      record(report, 'plant_observation', { position, crop: state.crop ?? null, seedItemId: seedId, beforeCount, afterCount });
      requireFact(state.crop?.cropId === rawSeed && state.crop.dead === false && afterCount === beforeCount - 1, '种植后作物ID与种子消耗未同时得到确认，停止；不能再次播种猜结果。');
      if (water && state.crop.watered !== true) {
        await equip(item => item.toolKind === 'watering_can' && (item.bottomless === true || Number.isInteger(item.waterRemaining) && item.waterRemaining > 0));
        await call('stardew_use_tool', { position, chargeLevel: 0 });
        state = await tile(position);
        requireFact(state.crop?.cropId === rawSeed && state.crop.dead === false && state.crop.watered === true, '浇水后没有确认同格同种作物湿润，停止，不自动重复。');
      }
      record(report, 'tile_completed', { position, crop: state.crop, waterRequired: water, remainingSeeds: afterCount });
    }
    report.status = 'completed';
  } catch (error) {
    report.reason = error instanceof Error ? error.message : '流程中断，未自动重放。';
    if (error instanceof PersistenceError) {
      try { await port.persistenceFailed?.(); }
      catch { report.reason += ' 接管检查点也未能完整保存；已停止后续变更。'; }
    }
  } finally {
    report.endedAt = new Date().toISOString();
  }
  return report;
}
