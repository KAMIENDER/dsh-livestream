import { object, positionOf, requireFact, WorkflowIO, type ObjectValue } from '../workflow-context.js';

export const ANIMAL_WORKFLOW = {
  name: 'animal_care', title: '按真实动物ID抚摸及收取手持工具产物', sourceStatus: 'implemented_unverified',
  requiredTools: ['dsh_query_farm', 'stardew_query_inventory', 'stardew_navigate', 'dsh_animal'],
  parameters: { type: 'object', additionalProperties: false, required: ['locationId', 'animalIds'], properties: {
    locationId: { type: 'string', description: '当前已加载的动物所在地点ID' },
    animalIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string' }, description: 'dsh_query_farm animals 返回的真实数字ID，不能使用名字' },
    actions: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'string', enum: ['pet', 'harvest'] }, default: ['pet', 'harvest'] },
  } },
  scope: '最多8只当前地点的农场动物；pet为原生抚摸，harvest仅为已有挤奶器/剪刀可收的产物。不含饲喂、收地上蛋/松露、购买、繁殖、迁移或出售。',
  postconditions: ['按ID重新查询，pettedToday=true', '手持工具产物ID/品质/数量核对，包含动物饼干翻倍', '动物产物清空且背包增加对应数量；原生动作结束'],
  failure: '动物移动时最多重新定位两次；资源不足、非手持产物或未知结果停止，保留已确认部分，不再次抚摸打开管理菜单或盲目重放。',
};

export async function animalCare(args: unknown, io: WorkflowIO): Promise<void> {
  requireFact(object(args) && Object.keys(args).every(key => ['locationId', 'animalIds', 'actions'].includes(key)), 'animal_care 参数不符合workflows声明。');
  requireFact(typeof args.locationId === 'string' && args.locationId.length > 0 && args.locationId.length <= 128 && !args.locationId.includes('\0'), 'locationId必须来自实际动物查询。');
  requireFact(Array.isArray(args.animalIds) && args.animalIds.length >= 1 && args.animalIds.length <= 8
    && args.animalIds.every((id: unknown) => typeof id === 'string' && /^-?(?:0|[1-9]\d{0,18})$/.test(id))
    && new Set(args.animalIds).size === args.animalIds.length, 'animalIds需要1–8个不同的真实数字ID。');
  const actions: string[] = args.actions ?? ['pet', 'harvest'];
  requireFact(Array.isArray(actions) && actions.length >= 1 && actions.length <= 2 && actions.every(action => ['pet', 'harvest'].includes(action)) && new Set(actions).size === actions.length, 'actions仅支持pet和harvest，不能重复。');
  const ids: string[] = args.animalIds, locationId = args.locationId;
  io.needs(ANIMAL_WORKFLOW.requiredTools);
  const read = async (animalId: string): Promise<ObjectValue> => {
    const page = await io.call('dsh_query_farm', { section: 'animals', animalId, locationId, offset: 0, limit: 2 });
    requireFact(Array.isArray(page.items) && page.items.length === 1 && page.nextOffset === null, '没有在本次实际地点查询中确认唯一动物，未按名字猜测。');
    const facts = page.items[0]?.facts;
    requireFact(object(facts) && facts.animalId === animalId && typeof facts.pettedToday === 'boolean'
      && (facts.produceItemId === null || typeof facts.produceItemId === 'string'), '缺少明确动物照料事实。');
    requireFact(positionOf(facts.position).locationId === locationId, '动物地点已变化。');
    return facts;
  };
  const harvestMode = (facts: ObjectValue): 'milk' | 'shear' => {
    requireFact(facts.canMilk === true || facts.canShear === true, '该产物不是当前已有挤奶器/剪刀可收取的产物；请单独补工具或处理落地产物。');
    requireFact(facts.inventoryCanAcceptProduce === true && Number.isInteger(facts.produceCount) && facts.produceCount > 0 && Number.isInteger(facts.produceQuality), '产物数量、品质或完整背包容量未确认。');
    return facts.canMilk === true ? 'milk' : 'shear';
  };
  // Validate known resources for the whole requested batch before committing even its first pet.
  for (const id of ids) {
    const facts = await read(id); io.ready(locationId);
    if (actions.includes('harvest') && facts.produceItemId !== null) harvestMode(facts);
    io.observed('animal_preflight', facts);
  }
  const approach = async (id: string): Promise<ObjectValue> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let facts = await read(id); io.ready(locationId);
      const target = positionOf(facts.position), player = io.port.current().player.position;
      if (Math.abs(player.x - target.x) + Math.abs(player.y - target.y) <= 1) return facts;
      await io.call('stardew_navigate', { position: target, arrival: 'adjacent' });
      facts = await read(id); io.ready(locationId);
      const next = positionOf(facts.position), standing = io.port.current().player.position;
      if (Math.abs(standing.x - next.x) + Math.abs(standing.y - next.y) <= 1) return facts;
    }
    throw new Error('动物持续移动，已停止这批照料；没有朝旧位置连续交互。');
  };
  for (const id of ids) {
    if (actions.includes('pet')) {
      const facts = await approach(id);
      if (facts.pettedToday) io.observed('pet_skipped_already_petted', { animalId: id });
      else {
        const result = await io.call('dsh_animal', { mode: 'pet', animalId: id, locationId });
        io.observed('pet_native_result', result);
        requireFact(result.completedWorkflow === true && result.animalId === id && result.afterAnimal?.pettedToday === true, '原生抚摸结果未完整确认，没有再次抚摸猜结果。');
        requireFact((await read(id)).pettedToday === true, '新查询没有确认目标动物已被抚摸。');
        io.observed('animal_pet_confirmed', { animalId: id, locationId });
        io.ready(locationId);
      }
    }
    if (actions.includes('harvest')) {
      const facts = await approach(id);
      if (facts.produceItemId === null) { io.observed('animal_harvest_skipped_not_ready', { animalId: id }); continue; }
      const mode = harvestMode(facts), itemId: string = facts.produceItemId, quality: number = facts.produceQuality;
      const before = io.count(await io.inventory(), itemId, quality);
      const result = await io.call('dsh_animal', { mode, animalId: id, locationId, expectedProduceItemId: itemId });
      io.observed('animal_harvest_native_result', result);
      requireFact(result.completedWorkflow === true && result.animalId === id && result.produceItemId === itemId && result.produceQuality === quality
        && result.inventoryGain === facts.produceCount && result.afterAnimal?.produceItemId === null, '产物/数量与动物状态未同时确认，停止且不重放。');
      const after = io.count(await io.inventory(), itemId, quality), observed = await read(id);
      io.observed('animal_harvest_inventory', { animalId: id, itemId, quality, before, after, afterAnimal: observed });
      requireFact(after - before === result.inventoryGain && observed.produceItemId === null, '新的背包和动物查询与原生收取结果不一致，停止且不再收取。');
      io.ready(locationId);
    }
  }
}
