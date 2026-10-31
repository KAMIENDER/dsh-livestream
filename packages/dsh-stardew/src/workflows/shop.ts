import { object, positionOf, requireFact, samePosition, WorkflowIO, type ObjectValue } from '../workflow-context.js';
import { inventoryDelta, verifyInventoryChanges, verifyNativeInventory } from './inventory-receipt.js';

const position = { type: 'object', additionalProperties: false, required: ['locationId', 'x', 'y'], properties: {
  locationId: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' },
} };
const common = { itemId: { type: 'string' }, quality: { type: 'integer', minimum: 0, maximum: 4 } };
export const SHOP_WORKFLOW = {
  name: 'shop_trade', title: '准确商店金币购买/出售批次及累计支出预算', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_shop', 'dsh_shop_ui', 'stardew_query_ui', 'stardew_query_inventory', 'stardew_purchase_shop_item', 'stardew_navigate'],
  parameters: { type: 'object', additionalProperties: false, required: ['expectedShopId', 'maxGoldSpend', 'transactions'], properties: {
    expectedShopId: { type: 'string', description: '实际原生ShopId，不是NPC/显示名' }, entry: { type: 'string', enum: ['current', 'position'], default: 'current' },
    menuKey: { type: 'string', description: 'entry=current必须绑定dsh_query_shop返回的实际菜单实例；重开/重载后失效' }, position,
    maxGoldSpend: { type: 'integer', minimum: 0, maximum: 2147483647, description: '整批累计购买金币上限，卖货收入不增加此额度' },
    minimumGoldReserve: { type: 'integer', minimum: 0, maximum: 2147483647, default: 0 }, closeAfter: { type: 'boolean', default: true },
    maxScrollSteps: { type: 'integer', minimum: 0, maximum: 96, default: 32, description: '整批正常逐行滚动上限，开始时连同交易/关闭预留原日动作' },
    transactions: { type: 'array', minItems: 1, maxItems: 16, items: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['operation', 'itemId', 'quality', 'purchaseCount', 'unitsPerPurchase', 'maxUnitPrice'], properties: {
        ...common, operation: { const: 'buy' }, purchaseCount: { type: 'integer', minimum: 1, maximum: 25 }, unitsPerPurchase: { type: 'integer', minimum: 1, maximum: 10000 },
        maxUnitPrice: { type: 'integer', minimum: 0, maximum: 2147483647 }, expectedSaleKey: { type: 'string', description: '可选固定Native商品实例，同ID候选不唯一时必须明确；不是MCP saleRef' },
      } },
      { type: 'object', additionalProperties: false, required: ['operation', 'itemId', 'quality', 'sourceSlot', 'quantity', 'minimumUnitPrice'], properties: {
        ...common, operation: { const: 'sell' }, sourceSlot: { type: 'integer', minimum: 0, maximum: 255 }, quantity: { type: 'integer', minimum: 1, maximum: 10000 },
        minimumUnitPrice: { type: 'integer', minimum: 0, maximum: 2147483647 }, expectedItemRef: { type: 'string', description: '可额外绑定实际MCP当前源槽物品Ref；不接受旧Ref替换' },
      } },
    ] } },
  } },
  scope: '1–16步当前准确原生ShopMenu的普通金币实物买卖。可正常导航/交互已加载OpenShop柜台，原生检查营业/店主/方向/条件；其他专用开店问题需另适配。购买沿用真实MCP，出售走原生左/右键，工具/特殊品/配方/交易物/其他货币/回购/交易回调均不冒充普通交易。',
  postconditions: ['固定实际ShopId/菜单实例，Native商品实例按真实UI位置与MCP商品Ref对应；每步使用新revision',
    '购买次数与每份数量、单价/库存/金币精确核对，累计支出及最低保留金币不因售货扩张',
    '出售准确源槽/ID/品质/数量与原生单位价格，原生结算；新完整MCP背包与Native数量/金币独立核对',
    '拒绝只有在新观察证明库存、金币和商店摘要未变时才记录无效果；未知/部分失败停止不重放，已确认交易与关闭分开'],
};
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const qualified = (v: unknown): v is string => typeof v === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(v);
const opaque = (v: unknown): v is ObjectValue => object(v) && typeof v.value === 'string' && v.value.length > 0 && v.value.length <= 512 && !/[\x00-\x1f]/.test(v.value);
const sameBounds = (a: unknown, b: unknown) => object(a) && object(b) && ['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger(a[k]) && a[k] === b[k]);
const price = (v: unknown): number | null => whole(v, 0, 2147483647) ? v : typeof v === 'string' && /^(0|[1-9]\d{0,9})$/.test(v) && Number(v) <= 2147483647 ? Number(v) : null;
interface Frame { native: ObjectValue; ui: ObjectValue; inventory: ObjectValue }

export async function shopTrade(args: unknown, io: WorkflowIO): Promise<'completed' | 'waiting'> {
  requireFact(object(args) && Object.keys(args).every(k => ['expectedShopId', 'entry', 'menuKey', 'position', 'maxGoldSpend', 'minimumGoldReserve', 'closeAfter', 'maxScrollSteps', 'transactions'].includes(k))
    && typeof args.expectedShopId === 'string' && args.expectedShopId.length > 0 && args.expectedShopId.length <= 128 && !/[\s\x00-\x1f]/.test(args.expectedShopId)
    && whole(args.maxGoldSpend, 0, 2147483647), '需要实际ShopId、明确累计购买金币上限和交易列表。');
  const entry = args.entry ?? 'current', closeAfter = args.closeAfter ?? true, reserve = args.minimumGoldReserve ?? 0, scrollLimit = args.maxScrollSteps ?? 32;
  requireFact(['current', 'position'].includes(entry) && typeof closeAfter === 'boolean' && whole(reserve, 0, 2147483647) && whole(scrollLimit, 0, 96)
    && Array.isArray(args.transactions) && args.transactions.length >= 1 && args.transactions.length <= 16, '入口、预算、清理或批次数量不符合声明。');
  requireFact(entry === 'current' ? key(args.menuKey) && args.position === undefined : args.menuKey === undefined && object(args.position), 'current必须绑定实际菜单key；position入口不能混用旧菜单key。');
  const target = entry === 'position' ? positionOf(args.position) : undefined;
  const trades = args.transactions.map((t: unknown) => {
    requireFact(object(t) && qualified(t.itemId) && whole(t.quality, 0, 4), '每笔交易需要真实完整ID和品质。');
    if (t.operation === 'buy') requireFact(Object.keys(t).every(k => ['operation', 'itemId', 'quality', 'purchaseCount', 'unitsPerPurchase', 'maxUnitPrice', 'expectedSaleKey'].includes(k))
      && whole(t.purchaseCount, 1, 25) && whole(t.unitsPerPurchase, 1, 10000) && whole(t.maxUnitPrice, 0, 2147483647)
      && (t.expectedSaleKey === undefined || key(t.expectedSaleKey)), '购买需要次数、每份实际数量和单份金币上限。');
    else requireFact(t.operation === 'sell' && Object.keys(t).every(k => ['operation', 'itemId', 'quality', 'sourceSlot', 'quantity', 'minimumUnitPrice', 'expectedItemRef'].includes(k))
      && whole(t.sourceSlot, 0, 255) && whole(t.quantity, 1, 10000) && whole(t.minimumUnitPrice, 0, 2147483647)
      && (t.expectedItemRef === undefined || opaque({ value: t.expectedItemRef })), '出售需要准确当前源槽/数量和最低单位收入。');
    return t;
  });
  io.needs(SHOP_WORKFLOW.requiredTools);
  const enough = (needed: number) => requireFact(whole(io.port.remainingActions?.(), needed, 128), '原日剩余动作不足以覆盖交易、滚动与清理，未开始下一步。');
  enough(trades.length + scrollLimit + (closeAfter ? 1 : 0) + (target ? 2 : 0));
  let menuKey: string | undefined = entry === 'current' ? args.menuKey : undefined, spent = 0, earned = 0, scrolls = 0;
  const native = async (filter?: ObjectValue): Promise<ObjectValue> => {
    const value = await io.call('dsh_query_shop', { offset: 0, limit: 100, ...filter });
    requireFact(value.supportedBuild === true && sha(value.revision) && whole(value.gold, 0, 2147483647)
      && Array.isArray(value.player) && Array.isArray(value.items) && whole(value.count, 0, 4096), '缺少真实商店/构建/库存或金币事实。');
    return value;
  };
  const frame = async (filter?: ObjectValue): Promise<Frame> => {
    const before = await native(filter), shop = before.shop;
    requireFact(object(shop) && shop.shopId === args.expectedShopId && key(shop.menuKey) && shop.held === null && shop.currency === 0 && shop.ordinary === true,
      '当前不是该普通金币商店的准确空游标菜单。');
    if (menuKey) requireFact(shop.menuKey === menuKey, '商店菜单实例已改变，不把同名新店当原批准。');
    const inventory = await io.inventory(), ui = (await io.call('stardew_query_ui', {})).snapshot;
    requireFact(object(ui) && ui.menuOpen === true && ui.menu?.menuType === 'ShopMenu' && ui.menu.title === args.expectedShopId
      && sha(ui.uiRevision) && Array.isArray(ui.elements) && ui.elements.length <= 128, 'MCP没有当前准确商店和商品UI事实。');
    const after = await native(filter);
    requireFact(before.revision === after.revision && after.shop?.menuKey === shop.menuKey && String(after.gold) === io.port.current().player.money,
      '读取商店/背包时现场改变或两路金币不一致。');
    verifyNativeInventory(inventory, after.player); menuKey ??= shop.menuKey;
    return { native: after, ui, inventory };
  };
  const clean = async (operation: 'next_row' | 'previous_row' | 'close', before: Frame, filter?: ObjectValue): Promise<Frame | null> => {
    const result = await io.call('dsh_shop_ui', { operation, expectedShopId: args.expectedShopId, menuKey, revision: before.native.revision });
    io.observed('shop_ui_receipt', { operation, result });
    try {
      requireFact(result.completedWorkflow === true && result.operation === operation && result.shopId === args.expectedShopId, '原生商店滚动/关闭没有确认。');
      if (operation === 'close') {
        const inventory = await io.inventory(), after = await native(); verifyInventoryChanges(before.inventory, inventory, []); verifyNativeInventory(inventory, after.player);
        requireFact(after.shop === null && after.menuType === null && after.gold === before.native.gold && io.port.current().player.canMove && !io.port.current().ui.menuOpen,
          '关闭后未回到正确空闲世界，或库存/金币改变。'); return null;
      }
      const after = await frame(filter); verifyInventoryChanges(before.inventory, after.inventory, []);
      requireFact(after.native.gold === before.native.gold && after.native.shop.stockDigest === before.native.shop.stockDigest
        && after.native.shop.currentItemIndex === before.native.shop.currentItemIndex + (operation === 'next_row' ? 1 : -1), '滚动改变了物品/金币/商品集合或未到准确相邻行。');
      return after;
    } catch { return io.uncertain('商店滚动/关闭后的独立库存、余额或菜单无法确认。'); }
  };
  if (target) {
    io.ready(target.locationId); await io.call('stardew_navigate', { position: target, arrival: 'adjacent' }); io.ready(target.locationId);
    const inventory = await io.inventory(), before = await native({ position: target }); verifyNativeInventory(inventory, before.player);
    requireFact(before.shop === null && before.menuType === null && Array.isArray(before.stations), '柜台入口已有菜单或没有真实查询。');
    const stations = before.stations.filter((s: ObjectValue) => samePosition(s.position, target) && s.shopId === args.expectedShopId);
    requireFact(stations.length === 1 && stations[0].adjacent === true && stations[0].clear === true && sha(stations[0].stationDigest), '该实际OpenShop柜台不唯一、不相邻或被挡。');
    const result = await io.call('dsh_shop_ui', { operation: 'open', expectedShopId: args.expectedShopId, position: target,
      stationDigest: stations[0].stationDigest, revision: before.revision }); io.observed('shop_ui_receipt', { operation: 'open', result });
    try {
      const opened = await native(), bag = await io.inventory(); verifyInventoryChanges(inventory, bag, []); verifyNativeInventory(bag, opened.player);
      requireFact(opened.gold === before.gold && result.shopId === args.expectedShopId, '柜台交互改变了物品/金币。');
      if (result.blocked === true && result.completedWorkflow === false && opened.shop === null) {
        io.report.reason = '原生没有打开商店，可能仍有营业/店主/方向/剧情条件或提示；未交易，不跳过条件。'; return 'waiting';
      }
      requireFact(result.completedWorkflow === true && key(result.menuKey) && opened.shop?.menuKey === result.menuKey
        && opened.shop.shopId === args.expectedShopId, '原生打开的不是准确目标商店。'); menuKey = result.menuKey;
    } catch { return io.uncertain('柜台交互后的准确商店及零资源变化未确认。'); }
  }
  let latest = await frame();
  for (let i = 0; i < trades.length; i++) {
    enough(trades.length - i + (closeAfter ? 1 : 0));
    const trade = trades[i], filter = trade.operation === 'buy' ? { itemId: trade.itemId, quality: trade.quality } : undefined;
    let before = await frame(filter);
    if (trade.operation === 'buy') {
      const select = (current: Frame): ObjectValue => {
        requireFact(current.native.count <= 100 && current.native.items.length === current.native.count && current.native.nextOffset === null,
          '同ID候选未完整捕获，未从截断列表挑商品。');
        const matches = current.native.items.filter((s: ObjectValue) => s.itemId === trade.itemId && s.quality === trade.quality
          && s.compatibleWithAuditedPurchase === true && (trade.expectedSaleKey === undefined || s.saleKey === trade.expectedSaleKey));
        requireFact(matches.length === 1 && key(matches[0].saleKey), '准确普通商品不唯一/售罄/不支持，未选替代商品。'); return matches[0];
      };
      let sale = select(before); const pinnedSaleKey = sale.saleKey;
      while (!sale.visible) {
        requireFact(scrolls < scrollLimit && whole(sale.index, 0, 4095) && whole(before.native.shop.currentItemIndex, 0, 4095), '商品不在可见行或整批滚动额度已用尽。');
        enough(trades.length - i + (closeAfter ? 1 : 0) + 1);
        before = (await clean(sale.index < before.native.shop.currentItemIndex ? 'previous_row' : 'next_row', before, filter))!; scrolls++;
        sale = select(before); requireFact(sale.saleKey === pinnedSaleKey, '翻行后商品实例改变，未改选同名商品。');
      }
      requireFact(whole(sale.price, 0, trade.maxUnitPrice) && sale.templateStack === trade.unitsPerPurchase && whole(sale.stock, 0, 2147483647)
        && typeof sale.unlimited === 'boolean' && (sale.unlimited || sale.stock >= trade.purchaseCount), '实际价格/每份数量/限购库存与计划不符。');
      const cost = sale.price * trade.purchaseCount, quantity = trade.unitsPerPurchase * trade.purchaseCount;
      requireFact(whole(cost, 0, 2147483647) && whole(quantity, 1, 10000) && spent + cost <= args.maxGoldSpend && before.native.gold - cost >= reserve,
        '购买会超过累计金币上限或最低保留额；售货所得不扩张支出额度。');
      // Opaque sale refs come only from the real current MCP UI. Native bounds
      // tie that row to the pinned actual salable, never to a guessed opaque ID.
      const rows = before.ui.elements.filter((e: ObjectValue) => e.visible === true && opaque(e.ref) && sameBounds(e.bounds, sale.bounds)
        && e.item?.qualifiedItemId === trade.itemId && e.item?.quality === trade.quality && e.item?.stack === trade.unitsPerPurchase && price(e.price) === sale.price);
      requireFact(rows.length === 1, 'Native商品行与MCP真实Ref没有唯一准确对应。');
      const result = await io.port.call('stardew_purchase_shop_item', { saleRef: rows[0].ref, purchaseCount: trade.purchaseCount, uiRevision: before.ui.uiRevision });
      io.observed('shop_purchase_receipt', { index: i + 1, status: result.status, output: result.output, error: result.error });
      if (result.status !== 'succeeded') {
        if (result.status === 'unknown') return io.uncertain('购买结果未知，未重下订单。');
        let unchanged: Frame;
        try {
          unchanged = await frame(filter);
          requireFact(unchanged.native.revision === before.native.revision && unchanged.inventory.inventoryRevision === before.inventory.inventoryRevision
            && inventoryDelta(before.inventory, unchanged.inventory).size === 0, '购买拒绝后现场不是原样。');
        } catch { return io.uncertain('购买报错但不能独立证明物品、钱和商店未变，不把报错当作无效果。'); }
        io.observed('shop_purchase_rejected_unchanged', { index: i + 1, code: result.error?.code });
        if (closeAfter) await clean('close', unchanged);
        throw new Error(`第${i + 1}笔购买被拒绝且已确认无变化；保留之前确认的交易，不减量或重下。`);
      }
      try {
        latest = await frame(filter); const receipt = result.output;
        requireFact(object(receipt) && receipt.purchaseCount === trade.purchaseCount && receipt.item?.qualifiedItemId === trade.itemId
          && receipt.item?.quality === trade.quality && receipt.item?.stack === quantity && receipt.totalPrice === cost && receipt.moneyBefore === before.native.gold
          && receipt.moneyAfter === before.native.gold - cost && latest.native.gold === receipt.moneyAfter && receipt.playerInventoryRevision === latest.inventory.inventoryRevision
          && receipt.uiRevision === latest.ui.uiRevision, '购买次数/实物/余额/版本收据不一致。');
        verifyInventoryChanges(before.inventory, latest.inventory, [{ itemId: trade.itemId, quality: trade.quality, amount: quantity }]);
        requireFact(latest.native.count <= 100 && latest.native.items.length === latest.native.count && latest.native.nextOffset === null, '购买后同ID商品列表不完整。');
        const remaining = latest.native.items.filter((s: ObjectValue) => s.saleKey === pinnedSaleKey);
        if (sale.unlimited) requireFact(remaining.length === 1 && remaining[0].stock === sale.stock && receipt.stockRemaining === undefined, '无限库存或收据不一致。');
        else {
          const expected = sale.stock - trade.purchaseCount;
          requireFact(receipt.stockRemaining === expected && (expected === 0 ? remaining.length === 0 : remaining.length === 1 && remaining[0].stock === expected), '限购库存变化或售罄移除不一致。');
        }
        spent += cost;
        io.observed('shop_trade_verified', { shopId: args.expectedShopId, operation: 'buy', itemId: trade.itemId, quality: trade.quality, quantity,
          purchaseCount: trade.purchaseCount, unitPrice: sale.price, goldBefore: before.native.gold, goldAfter: latest.native.gold, cumulativeGoldSpent: spent,
          note: '已确认入袋和购买成本；买到的物品不算农场生产。' });
      } catch { return io.uncertain('购买后的新库存、Native商品/数量/金币或限购收据未确认，停止且不重下。'); }
    } else {
      const source = before.inventory.slots[trade.sourceSlot]?.item;
      requireFact(object(source) && source.qualifiedItemId === trade.itemId && source.quality === trade.quality && source.tool !== true && whole(source.stack, trade.quantity, 10000)
        && opaque(source.ref) && (trade.expectedItemRef === undefined || source.ref.value === trade.expectedItemRef), '准确出售源槽、数量/品质或指定Ref已变，未换源。');
      const sources = before.native.playerSell?.filter((s: ObjectValue) => s.inventorySlot === trade.sourceSlot && s.itemId === trade.itemId && s.quality === trade.quality);
      requireFact(Array.isArray(sources) && sources.length === 1 && sources[0].eligible === true && key(sources[0].itemKey)
        && sources[0].quantity === source.stack && whole(sources[0].unitPrice, trade.minimumUnitPrice, 2147483647)
        && (trade.quantity === source.stack || trade.quantity <= 999), '原生商店不接受该普通物品、售价不足、来源不一致或部分出售超限。');
      const unit = sources[0].unitPrice, revenue = unit * trade.quantity;
      requireFact(whole(revenue, 0, 2147483647) && before.native.gold + revenue <= 2147483647, '出售收入会溢出，未执行。');
      const result = await io.call('dsh_shop_ui', { operation: 'sell', expectedShopId: args.expectedShopId, menuKey, revision: before.native.revision,
        inventorySlot: trade.sourceSlot, itemKey: sources[0].itemKey, expectedItemId: trade.itemId, expectedQuality: trade.quality, quantity: trade.quantity, expectedUnitPrice: unit });
      io.observed('shop_sale_receipt', result);
      try {
        latest = await frame();
        requireFact(result.confirmedSale === true && result.completedWorkflow === true && result.sourceSlot === trade.sourceSlot && result.itemId === trade.itemId
          && result.quality === trade.quality && result.quantitySold === trade.quantity && result.unitPrice === unit && result.beforeGold === before.native.gold
          && result.afterGold === before.native.gold + revenue && latest.native.gold === result.afterGold && result.menuKey === menuKey && result.shopId === args.expectedShopId,
          '出售源、数量、价格或余额收据不一致。');
        verifyInventoryChanges(before.inventory, latest.inventory, [{ itemId: trade.itemId, quality: trade.quality, amount: -trade.quantity }]);
        verifyInventoryChanges(before.inventory, latest.inventory, result.inventoryChanges); earned += revenue;
        io.observed('shop_trade_verified', { shopId: args.expectedShopId, operation: 'sell', itemId: trade.itemId, quality: trade.quality, quantity: trade.quantity,
          unitPrice: unit, goldBefore: before.native.gold, goldAfter: latest.native.gold, cumulativeGoldSpent: spent,
          note: '原生卖货含游戏自身回购/统计效果；不承诺回购，也不把售货收入变成额外购买权限。' });
      } catch { return io.uncertain('出售后的独立背包、Native结算/数量或余额未确认；可能已有部分交易，不重卖。'); }
    }
  }
  if (closeAfter) await clean('close', latest);
  requireFact(latest.native.gold >= reserve, '已确认交易仍未达到最低保留金币，未自动追加卖货。');
  io.observed('shop_batch_completed', { shopId: args.expectedShopId, transactions: trades.length, spent, earned, scrolls, closed: closeAfter,
    note: '仅已批准普通金币实物交易；未包含全货币/回购/特殊品/专用商店与持久中断恢复。' });
  return 'completed';
}
