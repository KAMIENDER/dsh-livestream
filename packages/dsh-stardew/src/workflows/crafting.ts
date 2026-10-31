import { object, positionOf, requireFact, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { verifyInventoryChanges } from './inventory-receipt.js';

const budget = { type: 'array', minItems: 1, maxItems: 128, items: { type: 'object', additionalProperties: false,
  required: ['sourceKind', 'itemId', 'quality', 'maxCount'], properties: { sourceKind: { type: 'string', enum: ['player', 'containers'] },
    itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 }, maxCount: { type: 'integer', minimum: 1, maximum: 10000 } } } };
export const CRAFTING_WORKFLOW = {
  name: 'craft_recipe', title: '原生制作/烹饪、材料预算及产物入袋', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_crafting', 'dsh_craft', 'stardew_query_inventory', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false, required: ['mode', 'recipeName', 'materialBudget'], properties: {
    mode: { type: 'string', enum: ['crafting', 'cooking'] }, recipeName: { type: 'string', description: '实际原生已学配方key，不能用翻译显示名替代' },
    count: { type: 'integer', minimum: 1, maximum: 25, default: 1, description: '制作次数；每次可产出多件' },
    entry: { type: 'string', enum: ['backpack', 'station', 'current'], default: 'current' },
    position: { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: { locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' } }, description: 'station必须为当前地点真实厨房/工作台位置，先导航相邻再正常交互' },
    materialBudget: budget, allowSeasoning: { type: 'boolean', default: false }, closeAfter: { type: 'boolean', default: true },
  } },
  scope: '原生普通背包制作页、当前地点厨房/工作台或已打开页面；1–25次，按player/containers分组的完整ID/品质累计预算。containers明确允许该页真实锁定的冰箱/工作台材料，连接后固定容器集合；齐氏调味料另须允许及预算，不能暗中禁用原生规则。预留空槽与剩余日动作，不自动腾包或购买材料。',
  postconditions: ['按本机构建原生倒序/分类/野种规则预检取料，材料ID/品质/来源及累计数量不超预算',
    '原生右键每次只制作一次，任务/配方/烹饪记录由原生更新；核对准确消耗及实际随机产物',
    '游标产物单独正常放入空槽，新MCP全背包和原生容器快照核对；批次入袋并按要求正常关闭才完成'],
};
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const key = (row: ObjectValue) => JSON.stringify([row.sourceKind, row.itemId, row.quality]);
function losses(value: unknown): ObjectValue[] {
  requireFact(Array.isArray(value) && value.length <= 16384 && value.every(row => object(row) && typeof row.sourceId === 'string'
    && ['player', 'containers'].includes(row.sourceKind) && typeof row.itemId === 'string' && whole(row.quality, 0, 4) && whole(row.amount, 1, 10000)), '缺少完整原生取料分配。');
  return value;
}
function sourceSet(query: ObjectValue): string {
  requireFact(Array.isArray(query.sources) && query.sources.length > 0 && query.sources.every((source: any) => object(source) && typeof source.sourceId === 'string'
    && ['player', 'containers'].includes(source.sourceKind) && /^[a-f0-9]{64}$/.test(source.digest) && Array.isArray(source.items)), '原生材料来源集合不完整。');
  return JSON.stringify(query.sources.map((source: ObjectValue) => [source.sourceId, source.sourceKind]));
}
function matchPlayer(query: ObjectValue, inventory: ObjectValue): void {
  const player = query.sources.find((source: ObjectValue) => source.sourceId === 'player' && source.sourceKind === 'player');
  requireFact(player && Array.isArray(player.items), '缺少实际玩家来源。');
  const actual = new Map<string, number>();
  for (const slot of inventory.slots) if (slot.item) {
    const id = JSON.stringify([slot.item.qualifiedItemId, slot.item.quality ?? 0]); actual.set(id, (actual.get(id) ?? 0) + slot.item.stack);
  }
  const native = new Map<string, number>();
  for (const row of player.items) {
    requireFact(typeof row.itemId === 'string' && whole(row.quality, 0, 4) && whole(row.amount, 0, 200000000), '玩家来源数量不完整。');
    const id = JSON.stringify([row.itemId, row.quality]); requireFact(!native.has(id), '原生物品统计重复。'); native.set(id, row.amount);
  }
  requireFact([...new Set([...native.keys(), ...actual.keys()])].every(id => (native.get(id) ?? 0) === (actual.get(id) ?? 0)), '原生玩家材料与MCP全背包不一致。');
}

export async function craftRecipe(args: unknown, io: WorkflowIO): Promise<'completed'> {
  requireFact(object(args) && Object.keys(args).every(k => ['mode', 'recipeName', 'count', 'entry', 'position', 'materialBudget', 'allowSeasoning', 'closeAfter'].includes(k))
    && ['crafting', 'cooking'].includes(args.mode) && typeof args.recipeName === 'string' && args.recipeName.length > 0 && args.recipeName.length <= 160 && !/[\x00-\x1f]/.test(args.recipeName), '需要明确制作/烹饪模式及实际配方key。');
  const count = args.count ?? 1, entry = args.entry ?? 'current', allowSeasoning = args.allowSeasoning ?? false, closeAfter = args.closeAfter ?? true;
  requireFact(whole(count, 1, 25) && ['backpack', 'station', 'current'].includes(entry) && typeof allowSeasoning === 'boolean' && typeof closeAfter === 'boolean', '批次、入口或调味料/关闭参数无效。');
  requireFact(Array.isArray(args.materialBudget) && args.materialBudget.length > 0 && args.materialBudget.length <= 128, '必须提供累计材料预算。');
  const limits = new Map<string, ObjectValue>();
  for (const row of args.materialBudget) {
    requireFact(object(row) && Object.keys(row).every(k => ['sourceKind', 'itemId', 'quality', 'maxCount'].includes(k))
      && ['player', 'containers'].includes(row.sourceKind) && typeof row.itemId === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(row.itemId)
      && whole(row.quality, 0, 4) && whole(row.maxCount, 1, 10000) && !limits.has(key(row)), '材料预算必须是不同来源组/完整ID/品质的有界数量。');
    limits.set(key(row), { ...row });
  }
  io.needs(CRAFTING_WORKFLOW.requiredTools);
  const remaining = (needed: number) => requireFact(whole(io.port.remainingActions?.(), needed, 128), '本日剩余动作不足以完成批次及产物入袋/清理，未开始下一次制作。');
  const read = async (position?: ObjectValue) => {
    const query = await io.call('dsh_query_crafting', { recipeName: args.recipeName, offset: 0, limit: 2, ...(position ? { position } : {}) });
    requireFact(query.supportedBuild === true && /^[a-f0-9]{64}$/.test(query.revision), '此游戏构建尚无已核对制作规则。'); return query;
  };
  let pageId: string | undefined, sources: string | undefined;
  const checkPage = (query: ObjectValue) => {
    requireFact(query.ready === true && query.mode === args.mode && typeof query.pageId === 'string' && query.held === null, '当前不是准确模式的原生空游标页面。');
    const set = sourceSet(query);
    if (pageId !== undefined) requireFact(query.pageId === pageId && set === sources, '原生页面或材料容器集合改变，未扩大来源。');
    else { pageId = query.pageId; sources = set; }
  };
  // Every operation uses a fresh query and independent MCP inventory. No generic UI
  // coordinates or model-selected tools are accepted by this workflow.
  const action = async (operation: string, parameters: ObjectValue = {}, expectHeld = false, preflight?: (query: ObjectValue) => void) => {
    const before = await io.inventory(), query = await read(parameters.position);
    if (query.ready === true) {
      requireFact(query.pageId === pageId && sourceSet(query) === sources, '操作前页面/容器来源改变。'); matchPlayer(query, before);
      requireFact(expectHeld ? object(query.held) : query.held === null, '游标状态与本步骤不符。');
    }
    preflight?.(query);
    const receipt = await io.call('dsh_craft', { operation, revision: query.revision, ...parameters });
    const sourceEvidence = (value: unknown) => Array.isArray(value) ? value.map(source => object(source)
      ? { sourceId: source.sourceId, sourceKind: source.sourceKind, digest: source.digest, itemRows: source.items?.length } : null) : null;
    io.observed('crafting_native_receipt', { ...receipt, beforeSources: sourceEvidence(receipt.beforeSources), afterSources: sourceEvidence(receipt.afterSources) });
    if (receipt.completedWorkflow !== true) {
      if (receipt.nativeActionSubmitted === false) throw new Error('本步骤在提交前已停止，没有重放。');
      return io.uncertain('原生制作操作未完整确认，保留游标/材料现场，不重做配方。');
    }
    try {
      requireFact(receipt.operation === operation && receipt.beforeGold === query.gold && receipt.afterGold === receipt.beforeGold
        && Array.isArray(receipt.inventoryChanges), '操作/金币收据不完整。');
      if (query.ready === true) requireFact(JSON.stringify(receipt.beforeSources) === JSON.stringify(query.sources)
        && JSON.stringify(receipt.beforeHeld) === JSON.stringify(query.held), '操作前实际来源/游标与收据不一致。');
      const afterInventory = await io.inventory(), after = await read();
      verifyInventoryChanges(before, afterInventory, receipt.inventoryChanges.filter((row: ObjectValue) => row.sourceId === 'player'));
      if (operation !== 'close') requireFact(after.ready === true, '操作后原生页面不可观察。');
      if (after.ready === true) {
        matchPlayer(after, afterInventory);
        if (!operation.startsWith('open_')) requireFact(after.pageId === pageId && sourceSet(after) === sources
          && JSON.stringify(after.sources) === JSON.stringify(receipt.afterSources), '操作后容器/页面新快照与收据不一致。');
      }
      requireFact(after.gold === receipt.afterGold, '新的原生余额不一致。');
      requireFact(JSON.stringify(after.held) === JSON.stringify(receipt.afterHeld), '新的游标快照与收据不一致。');
      if (operation === 'craft') {
        requireFact(receipt.confirmedCraft === true && receipt.recipeName === args.recipeName && receipt.cooking === (args.mode === 'cooking')
          && query.recipes?.length === 1 && after.recipes?.length === 1 && receipt.counterBefore === query.recipes[0].counter && receipt.counterAfter === after.recipes[0].counter,
        '没有确认准确配方、模式及新的原生计数。');
        if (args.mode === 'cooking') requireFact(JSON.stringify(receipt.cookedBefore) === JSON.stringify(query.cooked)
          && JSON.stringify(receipt.cookedAfter) === JSON.stringify(after.cooked), '新的原生烹饪记录不符。');
        requireFact(receipt.output?.destination === 'player' ? after.held === null : object(after.held) && after.held.itemId === receipt.output?.itemId
          && after.held.quality === receipt.output?.quality && after.held.count === receipt.output?.quantity, '产物实际游标/背包落点不一致。');
      }
      else if (operation === 'store') requireFact(after.ready === true && after.held === null, '原生产物没有完整入袋。');
      else if (operation === 'close') requireFact(after.ready === false && after.menuType === null && io.port.current().player.canMove && !io.port.current().ui.menuOpen, '页面未正常关闭到可操作世界。');
      return { receipt, after, query };
    } catch { return io.uncertain('原生制作收据与新MCP背包/容器/界面不符。'); }
  };
  remaining(count * 2 + (closeAfter ? 1 : 0) + (entry === 'station' ? 2 : entry === 'backpack' ? 1 : 0));
  if (entry !== 'current') {
    io.ready();
    if (entry === 'backpack') {
      requireFact(args.mode === 'crafting' && args.position === undefined, '背包入口只支持普通制作。');
      const query = await read(); await action('open_backpack', { inventoryDigest: query.inventoryDigest });
    } else {
      const position = positionOf(args.position); io.ready(position.locationId);
      await io.call('stardew_navigate', { position, arrival: 'adjacent' }); io.ready(position.locationId);
      const query = await read(position), station = query.stations?.find((row: ObjectValue) => row.position?.locationId === position.locationId && row.position.x === position.x && row.position.y === position.y);
      requireFact(station?.adjacent === true && station.kind === (args.mode === 'cooking' ? 'kitchen' : 'workbench') && /^[a-f0-9]{64}$/.test(station.stationDigest), '当前位置没有准确模式的相邻原生工作站。');
      await action('open_station', { position, stationDigest: station.stationDigest, inventoryDigest: query.inventoryDigest });
    }
  } else requireFact(args.position === undefined, 'current入口不接受另一个位置。');
  for (let index = 0; index < count; index++) {
    let query = await read(); checkPage(query);
    requireFact(Array.isArray(query.recipes) && query.recipes.length === 1 && query.count === 1 && query.nextOffset === null, '原生页面中没有唯一实际配方。');
    let recipe = query.recipes[0];
    requireFact(recipe.known === true && recipe.ghosted === false && recipe.cooking === (args.mode === 'cooking') && whole(recipe.pageIndex, 0, 127)
      && whole(query.currentPage, 0, 127), '配方未学会或页面不可定位。');
    remaining((count - index) * 2 + Math.abs(recipe.pageIndex - query.currentPage) + (closeAfter ? 1 : 0));
    for (let pages = 0; query.currentPage !== recipe.pageIndex; pages++) {
      requireFact(pages < 128, '超过原生有界页数。');
      await action(query.currentPage < recipe.pageIndex ? 'next_page' : 'previous_page');
      query = await read(); checkPage(query); recipe = query.recipes[0];
    }
    const planned = losses(recipe.plannedLosses);
    requireFact(recipe.visible === true && planned.length > 0 && (recipe.seasoningWillApply !== true || allowSeasoning), '当前材料/调味料许可不满足原生配方。');
    const totals = new Map<string, number>(); for (const row of planned) totals.set(key(row), (totals.get(key(row)) ?? 0) + row.amount);
    for (const [id, amount] of totals) requireFact(amount <= (limits.get(id)?.maxCount ?? 0), '真实倒序取料超过剩余累计预算，未制作。');
    requireFact(Array.isArray(query.emptyPlayerSlots) && query.emptyPlayerSlots.length > 0, '没有预留原生产物空槽。');
    const { receipt, after } = await action('craft', { mode: args.mode, recipeKey: recipe.recipeKey, maxCount: 1, allowSeasoning,
      materialBudget: [...limits.values()].filter(row => row.maxCount > 0) }, false, fresh => {
        const row = fresh.recipes?.[0];
        requireFact(fresh.recipes?.length === 1 && Array.isArray(fresh.emptyPlayerSlots) && fresh.emptyPlayerSlots.length > 0
          && row.recipeKey === recipe.recipeKey && JSON.stringify(row.plannedLosses) === JSON.stringify(planned)
          && JSON.stringify(row.possibleOutputIds) === JSON.stringify(recipe.possibleOutputIds) && row.numberProducedPerCraft === recipe.numberProducedPerCraft
          && row.seasoningWillApply === recipe.seasoningWillApply, '提交前配方/取料计划已变，没有套用旧计划制作。');
      });
    try {
      requireFact(JSON.stringify(losses(receipt.consumed)) === JSON.stringify(planned) && object(receipt.output) && receipt.output.quantity === recipe.numberProducedPerCraft
        && recipe.possibleOutputIds.includes(receipt.output.itemId) && receipt.output.quality === (recipe.seasoningWillApply ? 2 : 0)
        && ['player', 'cursor'].includes(receipt.output.destination), '实际取料或产物不符合原生预检。');
      for (const [id, amount] of totals) limits.get(id)!.maxCount -= amount;
      io.observed('recipe_craft_verified', { recipeName: args.recipeName, cooking: args.mode === 'cooking', output: receipt.output,
        seasoning: receipt.seasoning, consumed: receipt.consumed, index: index + 1, count,
        note: '这是已确认的原生制作；cursor仍待入袋，不把清理失败当作可以再做一份。' });
    } catch { return io.uncertain('制作的经济效果或累计材料预算不能完整确认。'); }
    if (receipt.output.destination === 'cursor') {
      requireFact(object(after.held) && Array.isArray(after.emptyPlayerSlots) && after.emptyPlayerSlots.length > 0, '已确认制作，但游标产物尚无空槽；保留现场。');
      await action('store', { destinationSlot: after.emptyPlayerSlots[0], expectedItemId: after.held.itemId, expectedQuality: after.held.quality, expectedCount: after.held.count }, true);
    } else requireFact(after.held === null, '原生自动入袋后游标仍有物品，停止后续制作。');
    io.observed('crafted_output_stored', { recipeName: args.recipeName, ...receipt.output, index: index + 1 });
  }
  if (closeAfter) await action('close');
  io.observed('recipe_batch_completed', { mode: args.mode, recipeName: args.recipeName, craftCount: count, closedMenu: closeAfter,
    remainingMaterialBudget: [...limits.values()], note: '批次真实产物入袋；不是全部配方解锁、采购/腾包、专用锻造或持久中断恢复。' });
  return 'completed';
}
