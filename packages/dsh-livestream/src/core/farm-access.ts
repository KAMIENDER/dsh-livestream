import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Position { locationId: string; x: number; y: number }
interface Material { itemId: string; maxCount: number }
interface Input { itemId: string; quality: number; maxInputCount: number; materialBudgets: Material[] }
interface GearIdentity { index: number; itemId: string | null; quality: number }
interface GroundTarget { position: Position; itemId: string; quality: number; maxSourceCount: number }
export interface FarmBinding { runId: string; saveId: string; gameBuildId: string }
export interface ResolvedFarmRequest { binding: FarmBinding; request: unknown }
export type FarmResolver = (sessionId: string, workflow: string, text: string) => ResolvedFarmRequest | undefined;
export class FarmGrantStorageError extends Error {}
type Scope = { workflow: 'plant'; seedItemId: string; positions: Position[]; water: boolean }
  | { workflow: 'animal_care'; locationId: string; animalIds: string[]; actions: string[] }
  | { workflow: 'animal_feed_prepare'; positions: Position[]; hayQuality: number }
  | { workflow: 'ground_collect'; targets: GroundTarget[] }
  | { workflow: 'consume_food'; itemId: string; quality: number; allowNegativeEdibility: boolean; maxHealthLoss: number; maxEnergyLoss: number; durationMs: number }
  | { workflow: 'fishing_cast'; position: Position; rodSlot: number; expectedRodItemId: string; expectedGear: GearIdentity[]; direction: number;
      durationMs: number; castPowerPercent: number; tryTreasure: boolean; maxBaitConsumed: number; maxTackleWear: number }
  | { workflow: 'machine_cycle'; position: Position; expectedMachineItemId: string; input: Input | null; allowHopperReload: false };
interface Grant {
  id: string; sessionId: string; binding: FarmBinding; scope: Scope;
  createdAt: number; startBefore: number; totalCalls: number; remainingCalls: number; revoked: boolean;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const whole = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const location = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
const item = (value: unknown): value is string => typeof value === 'string' && /^\([A-Za-z]+\)[^\s\x00-\x1f]{1,128}$/.test(value);
const positionKey = (p: Position) => JSON.stringify([p.locationId, p.x, p.y]);
const bindingValid = (b: unknown): b is FarmBinding => object(b) && uuid.test(b.runId) && /^[a-f0-9]{64}$/.test(b.saveId) && uuid.test(b.gameBuildId);
const sameBinding = (a: FarmBinding, b: FarmBinding) => a.runId === b.runId && a.saveId === b.saveId && a.gameBuildId === b.gameBuildId;
function position(value: unknown): Position | undefined {
  return object(value) && keys(value, ['locationId', 'x', 'y']) && location(value.locationId) && whole(value.x, 0, 10000) && whole(value.y, 0, 10000)
    ? { locationId: value.locationId, x: value.x, y: value.y } : undefined;
}
function input(value: unknown): Input | null | undefined {
  if (value === undefined || value === null) return null;
  if (!object(value) || !keys(value, ['itemId', 'quality', 'maxInputCount', 'materialBudgets']) || !item(value.itemId) || !value.itemId.startsWith('(O)')
    || !whole(value.quality, 0, 4) || !whole(value.maxInputCount, 1, 10000) || !Array.isArray(value.materialBudgets) || value.materialBudgets.length > 16) return undefined;
  const budgets: Material[] = [];
  for (const row of value.materialBudgets) {
    if (!object(row) || !keys(row, ['itemId', 'maxCount']) || !item(row.itemId) || !whole(row.maxCount, 1, 10000) || budgets.some(b => b.itemId === row.itemId)) return undefined;
    budgets.push({ itemId: row.itemId, maxCount: row.maxCount });
  }
  return { itemId: value.itemId, quality: value.quality, maxInputCount: value.maxInputCount, materialBudgets: budgets.sort((a, b) => a.itemId.localeCompare(b.itemId)) };
}

/** Only reviewed semantic envelopes qualify. Generic input and a machine's hopper never do. */
function scopeOf(workflow: string, value: unknown): Scope | undefined {
  if (!object(value)) return undefined;
  if (workflow === 'consume_food' && keys(value, ['itemId', 'quality', 'allowNegativeEdibility', 'maxHealthLoss', 'maxEnergyLoss', 'durationMs'])
    && item(value.itemId) && value.itemId.startsWith('(O)') && whole(value.quality, 0, 4)
    && typeof (value.allowNegativeEdibility ?? false) === 'boolean' && whole(value.maxHealthLoss ?? 0, 0, 1000)
    && whole(value.maxEnergyLoss ?? 0, 0, 5000) && whole(value.durationMs ?? 15000, 1000, 20000)) {
    return { workflow, itemId: value.itemId, quality: value.quality, allowNegativeEdibility: value.allowNegativeEdibility ?? false,
      maxHealthLoss: value.maxHealthLoss ?? 0, maxEnergyLoss: value.maxEnergyLoss ?? 0, durationMs: value.durationMs ?? 15000 };
  }
  if (workflow === 'animal_feed_prepare' && keys(value, ['positions', 'hayQuality']) && Array.isArray(value.positions) && whole(value.positions.length, 1, 8)
    && whole(value.hayQuality ?? 0, 0, 4)) {
    const positions = value.positions.map(position);
    if (positions.some(p => !p) || new Set(positions.map(p => positionKey(p!))).size !== positions.length) return undefined;
    return { workflow, positions: positions as Position[], hayQuality: value.hayQuality ?? 0 };
  }
  if (workflow === 'ground_collect' && keys(value, ['targets']) && Array.isArray(value.targets) && whole(value.targets.length, 1, 8)) {
    const targets: GroundTarget[] = [];
    for (const target of value.targets) {
      if (!object(target) || !keys(target, ['position', 'itemId', 'quality', 'maxSourceCount']) || !item(target.itemId) || !target.itemId.startsWith('(O)')
        || !whole(target.quality, 0, 4) || !whole(target.maxSourceCount, 1, 1)) return undefined;
      const p = position(target.position);
      if (!p || targets.some(t => positionKey(t.position) === positionKey(p))) return undefined;
      targets.push({ position: p, itemId: target.itemId, quality: target.quality, maxSourceCount: target.maxSourceCount });
    }
    return { workflow, targets };
  }
  if (workflow === 'plant' && keys(value, ['seedItemId', 'positions', 'water']) && item(value.seedItemId) && value.seedItemId.startsWith('(O)')
    && Array.isArray(value.positions) && whole(value.positions.length, 1, 8) && (value.water === undefined || typeof value.water === 'boolean')) {
    const positions = value.positions.map(position);
    if (positions.some(p => !p) || new Set(positions.map(p => positionKey(p!))).size !== positions.length) return undefined;
    return { workflow, seedItemId: value.seedItemId, positions: positions as Position[], water: value.water ?? true };
  }
  if (workflow === 'animal_care' && keys(value, ['locationId', 'animalIds', 'actions']) && location(value.locationId)
    && Array.isArray(value.animalIds) && whole(value.animalIds.length, 1, 8)
    && value.animalIds.every((id: unknown) => typeof id === 'string' && /^-?(?:0|[1-9]\d{0,18})$/.test(id)) && new Set(value.animalIds).size === value.animalIds.length) {
    const actions = value.actions ?? ['pet', 'harvest'];
    if (!Array.isArray(actions) || !whole(actions.length, 1, 2) || actions.some(a => !['pet', 'harvest'].includes(a)) || new Set(actions).size !== actions.length) return undefined;
    return { workflow, locationId: value.locationId, animalIds: [...value.animalIds], actions: [...actions] };
  }
  if (workflow === 'machine_cycle' && keys(value, ['position', 'expectedMachineItemId', 'input', 'allowHopperReload']) && item(value.expectedMachineItemId)
    && (value.allowHopperReload === undefined || value.allowHopperReload === false)) {
    const p = position(value.position), i = input(value.input);
    if (p && i !== undefined) return { workflow, position: p, expectedMachineItemId: value.expectedMachineItemId, input: i, allowHopperReload: false };
  }
  if (workflow === 'fishing_cast' && keys(value, ['position', 'rodSlot', 'expectedRodItemId', 'expectedGear', 'direction', 'durationMs', 'castPowerPercent', 'tryTreasure', 'maxBaitConsumed', 'maxTackleWear'])) {
    const p = position(value.position), durationMs = value.durationMs ?? 90000, castPowerPercent = value.castPowerPercent ?? 75,
      tryTreasure = value.tryTreasure ?? true, maxBaitConsumed = value.maxBaitConsumed ?? 1, maxTackleWear = value.maxTackleWear ?? 1;
    if (!p || !whole(value.rodSlot, 0, 255) || !item(value.expectedRodItemId) || !whole(value.direction, 0, 3)
      || !whole(durationMs, 1000, 90000) || !whole(castPowerPercent, 10, 100) || typeof tryTreasure !== 'boolean' || !whole(maxBaitConsumed, 0, 1) || !whole(maxTackleWear, 0, 1)
      || !Array.isArray(value.expectedGear) || value.expectedGear.length > 3 || value.expectedGear.some((g: unknown, index: number) => !object(g) || !keys(g, ['index', 'itemId', 'quality'])
        || g.index !== index || g.itemId !== null && !item(g.itemId) || !whole(g.quality, 0, 4) || g.itemId === null && g.quality !== 0)) return undefined;
    return { workflow, position: p, rodSlot: value.rodSlot, expectedRodItemId: value.expectedRodItemId, expectedGear: value.expectedGear.map((g: GearIdentity) => ({ ...g })),
      direction: value.direction, durationMs, castPowerPercent, tryTreasure, maxBaitConsumed, maxTackleWear };
  }
  return undefined;
}
function permits(scope: Scope, request: Scope): boolean {
  if (scope.workflow === 'consume_food' && request.workflow === 'consume_food') return scope.itemId === request.itemId && scope.quality === request.quality
    && (!request.allowNegativeEdibility || scope.allowNegativeEdibility) && request.maxHealthLoss <= scope.maxHealthLoss && request.maxEnergyLoss <= scope.maxEnergyLoss && request.durationMs <= scope.durationMs;
  if (scope.workflow === 'animal_feed_prepare' && request.workflow === 'animal_feed_prepare') return scope.hayQuality === request.hayQuality
    && request.positions.every(p => scope.positions.some(target => positionKey(target) === positionKey(p)));
  if (scope.workflow === 'ground_collect' && request.workflow === 'ground_collect') return request.targets.every(target => scope.targets.some(cap =>
    positionKey(cap.position) === positionKey(target.position) && cap.itemId === target.itemId && cap.quality === target.quality && target.maxSourceCount <= cap.maxSourceCount));
  if (scope.workflow === 'plant' && request.workflow === 'plant') return scope.seedItemId === request.seedItemId && scope.water === request.water
    && request.positions.every(p => scope.positions.some(target => positionKey(target) === positionKey(p)));
  if (scope.workflow === 'animal_care' && request.workflow === 'animal_care') return scope.locationId === request.locationId
    && request.animalIds.every(id => scope.animalIds.includes(id)) && request.actions.every(action => scope.actions.includes(action));
  if (scope.workflow === 'fishing_cast' && request.workflow === 'fishing_cast') return positionKey(scope.position) === positionKey(request.position)
    && scope.rodSlot === request.rodSlot && scope.expectedRodItemId === request.expectedRodItemId && scope.direction === request.direction
    && scope.castPowerPercent === request.castPowerPercent && scope.tryTreasure === request.tryTreasure && request.durationMs <= scope.durationMs
    && request.maxBaitConsumed <= scope.maxBaitConsumed && request.maxTackleWear <= scope.maxTackleWear && request.expectedGear.length === scope.expectedGear.length
    && request.expectedGear.every((g, index) => g.itemId === null || g.itemId === scope.expectedGear[index].itemId && g.quality === scope.expectedGear[index].quality);
  if (scope.workflow === 'machine_cycle' && request.workflow === 'machine_cycle') {
    if (positionKey(scope.position) !== positionKey(request.position) || scope.expectedMachineItemId !== request.expectedMachineItemId) return false;
    if (!scope.input || !request.input) return scope.input === request.input;
    return scope.input.itemId === request.input.itemId && scope.input.quality === request.input.quality && request.input.maxInputCount <= scope.input.maxInputCount
      && request.input.materialBudgets.every(b => scope.input!.materialBudgets.some(cap => cap.itemId === b.itemId && b.maxCount <= cap.maxCount));
  }
  return false;
}
function describe(scope: Scope, calls: number): string {
  if (scope.workflow === 'consume_food') return `只消费品质${scope.quality}的${scope.itemId}，每次最多1份，累计预留最多${calls}份，每次等待最多${scope.durationMs}ms；${scope.allowNegativeEdibility ? '明确允许负食用值' : '禁止负食用值'}。每次生命/体力损失核对上限${scope.maxHealthLoss}/${scope.maxEnergyLoss}，累计预留上限${scope.maxHealthLoss * calls}/${scope.maxEnergyLoss * calls}。按原生规则恢复/替换Buff，不承诺保留旧Buff；未知效果停止、不重吃、不回滚。`;
  if (scope.workflow === 'animal_feed_prepare') return `只给所列${scope.positions.length}个饲料槽放品质${scope.hayQuality}的背包干草，累计预留最多${scope.positions.length * calls}份；不提取筒仓或调用自动喂食。填槽不代表动物已吃饱。`;
  if (scope.workflow === 'ground_collect') return `只收所列${scope.targets.length}处、指定ID和原始品质的单件地上产物/采集物；允许目标子集。保留原生品质/采集者奖励，不丢弃、不出货；不证明具体生产动物。`;
  if (scope.workflow === 'plant') return `只在所列${scope.positions.length}格播种${scope.seedItemId}，${scope.water ? '并浇水' : '不要求浇水'}；种子预留上限${scope.positions.length * calls}颗。`;
  if (scope.workflow === 'animal_care') return `只在${scope.locationId}照料所列${scope.animalIds.length}只动物；${scope.actions.includes('pet') ? '抚摸' : ''}${scope.actions.includes('pet') && scope.actions.includes('harvest') ? '、' : ''}${scope.actions.includes('harvest') ? '挤奶或剪毛' : ''}。不含买卖、迁移、繁殖或饲喂。`;
  if (scope.workflow === 'fishing_cast') return `只在所列站位/方向使用${scope.expectedRodItemId}及所列饵/鱼钩；最多${calls}次原生尝试，累计鱼饵预留最多${scope.maxBaitConsumed * calls}个，每个鱼钩槽磨损预留最多${scope.maxTackleWear * calls}次。${scope.tryTreasure ? '尝试宝箱' : '优先渔获，不主动追宝箱'}；不更换耗材身份，不保证钓到鱼。`;
  return `只操作所列位置的${scope.expectedMachineItemId}；${scope.input ? `每次原料最多${scope.input.maxInputCount}个${scope.input.itemId}，累计预留最多${scope.input.maxInputCount * calls}个；额外材料各按所列上限×${calls}次。` : '只接手已在生产或待收取的一轮，不投入新原料。'}禁止漏斗自动补料。等待查询也占一次调用。`;
}

/** Persist reservation BEFORE allowing execution. Unknown results and failed attempts never refund it. */
export class FarmGrants {
  private grants: Grant[] = [];
  private path: string;
  private broken = false;
  constructor(root: string) {
    this.path = join(root, 'farm-grants.json');
    if (!existsSync(this.path)) return;
    try {
      const text = readFileSync(this.path, 'utf8');
      if (text.length > 2_000_000) throw new Error();
      const saved = JSON.parse(text);
      if (saved?.version !== 1 || !Array.isArray(saved.grants) || saved.grants.length > 256) throw new Error();
      for (const g of saved.grants) {
        if (!g || !uuid.test(g.id) || !/^[\w-]{1,160}$/.test(g.sessionId) || !bindingValid(g.binding)
          || !Number.isSafeInteger(g.createdAt) || !Number.isSafeInteger(g.startBefore) || g.startBefore <= g.createdAt || g.startBefore > g.createdAt + 86400000
          || !whole(g.totalCalls, 1, 128) || !whole(g.remainingCalls, 0, g.totalCalls) || typeof g.revoked !== 'boolean' || !object(g.scope)) throw new Error();
        const { workflow, ...request } = g.scope, scope = scopeOf(workflow, request);
        if (!scope || this.grants.some(old => old.id === g.id)) throw new Error();
        this.grants.push({ ...g, scope });
      }
    } catch { throw new Error('经营授权记录无法读取；未清空额度或恢复旧权限。'); }
  }
  private save(): void {
    if (this.broken) throw new FarmGrantStorageError('经营授权存储已锁住，未恢复额度。');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, grants: this.grants }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, this.path);
    } catch { this.broken = true; throw new FarmGrantStorageError('经营授权额度无法落盘，已拒绝继续执行。'); }
  }
  create(sessionId: string, workflow: string, resolved: ResolvedFarmRequest, calls: number, minutes: number): string {
    if (this.broken) throw new FarmGrantStorageError('经营授权存储已锁住。');
    const scope = scopeOf(workflow, resolved.request), now = Date.now();
    if (!bindingValid(resolved.binding) || !scope || !whole(calls, 1, 128) || !whole(minutes, 1, 1440)) throw new Error('该流程不支持范围授权，或调用次数/期限无效；保留逐次审核。');
    const active = this.grants.filter(g => !g.revoked && g.startBefore > now && g.remainingCalls > 0);
    if (active.length >= 32) throw new Error('有效经营授权已达32项，请先撤销旧项。');
    const history = this.grants.filter(g => !active.includes(g)).slice(-223);
    this.grants = [...history, ...active];
    const id = randomUUID();
    this.grants.push({ id, sessionId, scope, binding: { ...resolved.binding }, createdAt: now, startBefore: now + minutes * 60000, totalCalls: calls, remainingCalls: calls, revoked: false });
    this.save(); return id;
  }
  consume(sessionId: string, workflow: string, resolved: ResolvedFarmRequest): string | undefined {
    if (this.broken) throw new FarmGrantStorageError('经营授权存储已锁住。');
    if (!bindingValid(resolved.binding)) return undefined;
    const request = scopeOf(workflow, resolved.request);
    if (!request) return undefined;
    const grant = this.grants.find(g => g.sessionId === sessionId && !g.revoked && g.remainingCalls > 0 && g.startBefore > Date.now()
      && sameBinding(g.binding, resolved.binding) && permits(g.scope, request));
    if (!grant) return undefined;
    grant.remainingCalls--;
    this.save(); return grant.id;
  }
  revoke(id?: string): void {
    if (this.broken) throw new FarmGrantStorageError('经营授权存储已锁住。');
    if (id !== undefined && !uuid.test(id)) throw new Error('经营授权ID无效，未撤销其他范围。');
    const targets = id !== undefined ? this.grants.filter(g => g.id === id) : this.grants;
    if (id !== undefined && !targets.length) throw new Error('没有这项经营授权。');
    for (const g of targets) g.revoked = true;
    this.save();
  }
  status(sessionId?: string): unknown[] {
    return this.grants.filter(g => !sessionId || g.sessionId === sessionId).map(g => ({ ...g,
      state: g.revoked ? 'revoked' : g.remainingCalls === 0 ? 'exhausted' : g.startBefore <= Date.now() ? 'expired' : 'active',
      description: describe(g.scope, g.totalCalls),
    }));
  }
}
