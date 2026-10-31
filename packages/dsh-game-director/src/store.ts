import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ID, developmentReport, now, ongoing, type State } from './model.js';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: Record<string, unknown>, keys: string[]) => keys.every(key => typeof v[key] === 'string');
function validState(v: unknown): v is State {
  if (!object(v) || v.version !== 1 || !Array.isArray(v.games) || !Array.isArray(v.tasks) || !object(v.choices)) return false;
  const ids = new Set<string>();
  for (const game of v.games) {
    if (!object(game) || !strings(game, ['id', 'title', 'description', 'source', 'createdAt'])
      || !ID.test(String(game.id)) || ids.has(String(game.id))
      || !['sample', 'candidate', 'developer-report'].includes(String(game.source))) return false;
    ids.add(String(game.id));
  }
  for (const choice of Object.values(v.choices)) {
    if (!object(choice) || !strings(choice, ['gameId', 'reason', 'goal', 'at']) || !ids.has(String(choice.gameId))) return false;
  }
  const tasks = new Set<string>();
  for (const task of v.tasks) {
    if (!object(task) || !strings(task, ['id', 'owner', 'gameId', 'kind', 'state', 'preset', 'cwd', 'createdAt', 'updatedAt'])
      || !ids.has(String(task.gameId)) || tasks.has(String(task.id))
      || !['develop', 'play'].includes(String(task.kind))
      || !['starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(task.state))
      || (task.kind === 'play' && typeof task.controlService !== 'string')
      || (task.childId !== undefined && typeof task.childId !== 'string')
      || (task.modelRoute !== undefined && (!object(task.modelRoute) || !strings(task.modelRoute, ['provider', 'model'])))
      || (task.investigation !== undefined && (!object(task.investigation)
        || Object.values(task.investigation).some(value => typeof value !== 'string')))
      || (task.report !== undefined && !developmentReport(task.report))) return false;
    tasks.add(String(task.id));
  }
  return true;
}

const initial = (): State => ({
  version: 1,
  games: [{ id: 'stardew', title: '星露谷物语', description: '独立经营单人农场主的一天；现有 dsh-stardew 源码样例，实机能力待确认。', source: 'sample', createdAt: now() }],
  choices: {}, tasks: [],
});

/** Plugin-owned metadata only; never load or execute an adapter from this file. */
export class Store {
  readonly path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-game-director/state.json');
  readonly data: State;
  constructor() {
    if (!existsSync(this.path)) { this.data = initial(); return; }
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!validState(value)) throw new Error();
      this.data = value;
      // An activation handle cannot survive this plugin instance. A previous 'running' is not completion.
      for (const task of this.data.tasks) if (ongoing(task)) {
        task.state = 'interrupted'; task.updatedAt = now();
        task.diagnostic = '插件已重载或进程重启；原任务的结束结果未确认，不自动重放。请检查记录中的子会话。';
      }
      this.save();
    } catch { throw new Error(`游戏目录记录无法读取；保留原文件，请检查 ${this.path}。`); }
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}
