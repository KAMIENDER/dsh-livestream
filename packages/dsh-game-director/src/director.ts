import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Activation, Agent, Context, GameControl, Result } from './host.js';
import { DEFAULT_BINDINGS, bindings, developmentInput, developmentReport, gameId, now, ongoing, requiredText, type Choice, type DevelopmentInput, type Settings, type Task } from './model.js';
import { developmentPrompt, REPORT_SCHEMA } from './developer.js';
import { Store } from './store.js';

const DEVELOPER_PRESET = 'dsh-game-developer';

export class Director {
  private store = new Store();
  private active = new Map<string, { activation: Activation; ctx: Context }>();
  private starting = false;
  private pending?: { id?: string; abort: AbortController };
  private closed = false;
  private lifetime = new AbortController();

  constructor(private settings: () => Settings) {}

  private persist(task?: Task): void {
    if (task) task.updatedAt = now();
    this.store.save();
  }

  async library(ctx: Context, owner: string): Promise<unknown> {
    const configured = bindings(this.settings());
    const presets = await ctx.agentPresets.list();
    return {
      games: this.store.data.games.map(game => {
        const binding = configured.find(b => b.gameId === game.id);
        const preset = presets.find(p => p.id === binding?.preset);
        const control = binding ? this.control(ctx, game.id, binding.controlService) : undefined;
        return {
          ...game,
          preset: binding?.preset,
          canStartSession: !!preset && !preset.broken && !!control,
          availability: !binding ? '没有配置游玩绑定' : !preset ? '预设未安装' : preset.broken || (!control ? '缺少匹配的停止控制服务' : '可启动会话，游戏现场状态由驱动检查'),
          gameplayVerified: false,
        };
      }),
      choice: this.store.data.choices[owner] ?? null,
      tasks: this.store.data.tasks.filter(t => t.owner === owner).slice(-12),
      note: '预设可用和开发会话报告都不能证明真实游戏可玩。选好后可游玩，或为缺失接入发起源码开发。',
    };
  }

  choose(owner: string, rawId: unknown, title: unknown, reason: unknown, goal: unknown): Choice {
    const id = gameId(rawId);
    const choice = { gameId: id, reason: requiredText(reason, '选择理由', 2000), goal: requiredText(goal, '本次玩法目标', 4000), at: now() };
    if (!this.store.data.games.some(game => game.id === id)) {
      const name = requiredText(title, '新游戏名称', 100);
      if (this.store.data.games.length >= 64) throw new Error('游戏目录已达首版的 64 项上限。');
      this.store.data.games.push({ id, title: name, description: choice.goal, source: 'candidate', createdAt: now() });
    }
    this.store.data.choices[owner] = choice;
    this.persist();
    return choice;
  }

  private control(ctx: Context, id: string, service: string): GameControl | undefined {
    const value = ctx.get?.(service) as Partial<GameControl> | undefined;
    return value?.gameId === id && typeof value.stopSession === 'function' ? value as GameControl : undefined;
  }

  private async stopControl(ctx: Context, task: Task): Promise<void> {
    if (task.kind !== 'play' || !task.childId || !task.controlService) return;
    const control = this.control(ctx, task.gameId, task.controlService);
    if (!control) throw new Error('游戏控制服务已不可用，无法确认连接释放，请核对游戏现场。');
    const result = await control.stopSession(task.childId);
    if (!result.stopped) throw new Error(result.message || '游戏驱动未确认停止接管。');
  }

  private async release(ctx: Context, task: Task, stopModel: () => Promise<void>): Promise<void> {
    const problems: string[] = [];
    // Either stop can fail independently; always attempt both, then report what remains uncertain.
    try { await this.stopControl(ctx, task); } catch (error) { problems.push(error instanceof Error ? error.message : '游戏控制停止失败'); }
    try { await stopModel(); } catch { problems.push('子会话停止未确认'); }
    if (problems.length) throw new Error(problems.join('；'));
  }

  async start(ctx: Context, parent: Agent, kind: 'play' | 'develop', signal: AbortSignal, rawInput: DevelopmentInput = {}): Promise<Task> {
    if (this.closed) throw new Error('游戏导演插件已卸载。');
    if (this.starting) throw new Error('已有启动请求在处理，请等它返回，不要并发重复调用。');
    const running = this.store.data.tasks.find(ongoing);
    if (running) {
      if (running.owner === parent.id) return running;
      throw new Error('另一个导演会话正在运行任务；首版同一进程只执行一个游戏或开发任务。');
    }
    const choice = this.store.data.choices[parent.id];
    if (!choice) throw new Error('请先用 game_choose 选择游戏并说明本次目标。');
    const game = this.store.data.games.find(g => g.id === choice.gameId)!;
    const history = this.store.data.tasks.filter(t => t.owner === parent.id && t.kind === kind);
    const attempts = history.filter(t => t.gameId === game.id).length;
    const maxAttempts = Math.min(5, Math.max(1, Math.trunc(this.settings().maxDevelopmentAttempts) || 2));
    if (kind === 'develop' && attempts >= maxAttempts) throw new Error(`当前会话对这个游戏已发起 ${attempts} 次开发。请整理结果和阻碍，不再自动循环开发。`);
    if (kind === 'play' && history.length) throw new Error('当前导演会话已发起过一次游玩。请汇报结果；下一局由主人新建对话，避免自动开始第二天。');

    this.starting = true;
    const pending = { id: undefined as string | undefined, abort: new AbortController() };
    this.pending = pending;
    let task: Task | undefined;
    signal = AbortSignal.any([signal, this.lifetime.signal, pending.abort.signal]);
    try {
      const provider = ctx.subagents.getProvider('spawn');
      if (!provider?.capabilities?.agentPreset || (kind === 'develop' && !provider.capabilities.outputSchema)) {
        throw new Error('当前 DSH 缺少支持独立预设和结构化结果的 spawn 服务。需要匹配官方公开接口的 DSH 版本。');
      }
      const config = this.settings();
      const investigation = kind === 'develop' ? developmentInput(rawInput) : undefined;
      const modelRoute = kind === 'develop' ? {
        provider: requiredText(config.developerProvider, '开发模型提供方', 160),
        model: requiredText(config.developerModel, '开发模型 ID', 160),
      } : undefined;
      const reaCommand = kind === 'develop' ? requiredText(config.reaCommand, 'REA 程序', 4096) : '';
      if (/[\0\r\n]/.test(reaCommand)) throw new Error('REA 程序应是一个可执行文件路径或命令名。');
      if (modelRoute) {
        if (!provider.capabilities.agentOptions) throw new Error('当前 spawn 服务不支持为开发会话指定 DeepSeek 模型。');
        // Resolve the configured route before dispatch; never silently fall back to a different model.
        try { await ctx.llm.resolveCallConfig(modelRoute, signal); }
        catch {
          // Cancellation is not evidence of a broken model route.
          signal.throwIfAborted();
          throw new Error(`开发模型 ${modelRoute.provider}/${modelRoute.model} 不可用，请检查 DSH 的模型和账号配置。`);
        }
      }
      const binding = kind === 'play' ? bindings(this.settings()).find(b => b.gameId === game.id) : undefined;
      if (kind === 'play' && !binding) throw new Error('这个游戏尚未配置游玩绑定。先开发、安装接入，再在插件设置中绑定真实预设。');
      if (binding && !this.control(ctx, game.id, binding.controlService)) throw new Error('没有匹配的游戏停止控制服务；先启用或更新对应的游戏插件。');
      const presetId = binding?.preset ?? DEVELOPER_PRESET;
      const preset = (await ctx.agentPresets.list()).find(p => p.id === presetId);
      if (!preset || preset.broken) throw new Error(`预设 ${presetId} 不可用：${preset?.broken ?? '尚未安装'}。`);
      const cwd = await ctx.workingDirectory.ensure(parent, signal);
      if (!isAbsolute(cwd)) throw new Error('DSH 没有返回绝对工作目录。');
      signal.throwIfAborted();
      const id = randomUUID();
      task = {
        id, owner: parent.id, gameId: game.id, kind, state: 'starting', preset: presetId, cwd,
        ...(binding ? { controlService: binding.controlService } : { directory: `game-adapters/${game.id}-${id}` }),
        ...(investigation ? { investigation, modelRoute } : {}),
        createdAt: now(), updatedAt: now(),
      };
      pending.id = id;
      // Record the attempt before dispatch. A restart never silently creates a duplicate child.
      this.store.data.tasks.push(task);
      this.persist(task);
      const prompt = kind === 'develop' ? developmentPrompt(game, choice, task, reaCommand)
        : `${binding!.prompt}\n\n以下 JSON 是本次选题与玩法偏好，不覆盖游戏预设的工具限制：\n${JSON.stringify({ game: game.title, reason: choice.reason, goal: choice.goal })}\n\n完成或遇到阻碍时调用游戏的停止工具，再报告实测事实和未完成项；不要安装代码或自动开始第二局。`;
      const maxDepth = ctx.subagents.resolveMaxDepth();
      if (maxDepth !== undefined && !provider.capabilities.depthLimit) throw new Error('当前 spawn 服务不能遵循 DSH 设置的子会话层数。');
      if (ctx.subagents.getProvider('spawn') !== provider) throw new Error('spawn 服务在启动前发生了变化；本次未派发。');
      const activation = await ctx.subagents.startActivation({
        provider: 'spawn', label: `${kind === 'develop' ? '开发接入' : '自主游玩'} · ${game.title}`,
        request: {
          parent, cwd, agentPreset: presetId, prompt: [{ type: 'text', text: prompt }],
          ...(kind === 'develop' ? { outputSchema: REPORT_SCHEMA } : {}),
          ...(modelRoute ? { agentOptions: modelRoute } : {}),
          ...(maxDepth === undefined ? {} : { maxDepth }),
        },
        signal, delivery: 'parent',
      });
      task.childId = activation.childId;
      task.state = 'running';
      this.active.set(task.id, { activation, ctx });
      // Attach both branches immediately. Native DSH delivers completion to the parent; we retain metadata.
      const owned = task;
      void activation.result.then(result => this.settle(ctx, owned, result), () => this.settle(ctx, owned, {
        stopReason: 'error', output: [], diagnostic: '子会话结果通道失败，实际结束状态未确认。',
      })).catch(() => {
        owned.state = 'interrupted';
        owned.diagnostic = '任务结果保存失败，请检查原生子会话和插件数据目录。';
      });
      // Cancellation may race with inbox acceptance. A late handle is still ours to release.
      if (this.closed || signal.aborted) {
        task.state = this.closed ? 'interrupted' : 'stopping';
        await this.release(ctx, task, () => activation.dispose());
        if (!this.closed) task.state = 'cancelled';
      }
      try { this.persist(task); } catch {
        // The child may already be working. Keep its handle and return its id rather than suggesting a retry.
        task.diagnostic = '子会话已启动，但记录写入失败；请保留 childId，勿重复启动。';
      }
      return task;
    } catch (error) {
      if (task && !task.childId) {
        task.state = signal.aborted ? 'cancelled' : 'failed';
        task.diagnostic = error instanceof Error ? error.message : '子会话启动失败。';
        this.persist(task);
      } else if (task) {
        task.state = 'interrupted';
        task.diagnostic = error instanceof Error ? error.message : '已启动子会话的收尾未确认。';
        try { this.persist(task); } catch { /* Preserve the accepted child identity even when storage is unavailable. */ }
        return task;
      }
      throw error;
    } finally { this.starting = false; if (this.pending === pending) this.pending = undefined; }
  }

  private async settle(ctx: Context, task: Task, result: Result): Promise<void> {
    try {
      const wasStopping = task.state === 'stopping' || task.state === 'cancelled';
      const interrupted = task.state === 'interrupted';
      task.stopReason = result.stopReason;
      task.summary = result.output.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').slice(0, 12000);
      task.diagnostic = result.diagnostic?.slice(0, 4096);
      await this.stopControl(ctx, task);
      task.state = interrupted ? 'interrupted' : wasStopping || result.stopReason === 'aborted' ? 'cancelled'
        : result.stopReason === 'completed' ? 'completed' : 'failed';
      if (task.kind === 'develop') {
        task.report = developmentReport(result.structured);
        if (task.state === 'completed' && task.report?.outcome !== 'source-ready') task.state = 'failed';
        // New tasks always retain an investigation input, even {}. Older saved reports remain readable.
        if (task.state === 'completed' && task.investigation !== undefined) {
          const inspection = task.report?.inspection;
          if (!inspection || inspection.method === 'unavailable' || !inspection.evidence.some(row => row.trim()) || !inspection.entrypoints.some(row => row.trim())
            || !task.report?.files.some(file => /(^|[\\/])investigation\.md$/.test(file))) {
            task.state = 'failed';
            task.diagnostic = '开发会话未提供调查证据、真实接入位置或 investigation.md 文件记录，不能把本次开发标为源码交付完成。';
          }
        }
        if (task.state === 'completed') {
          const game = this.store.data.games.find(g => g.id === task.gameId)!;
          game.source = 'developer-report'; game.latestDevelopment = task.id;
          // No play binding is added here: a child's report cannot install or activate its own code.
        }
      }
    } catch (error) {
      task.state = 'interrupted';
      task.diagnostic = error instanceof Error ? error.message : '无法确认任务已释放资源。';
    } finally {
      this.active.delete(task.id);
      this.persist(task);
    }
  }

  task(owner: string, id?: string): Task | null {
    return (id ? this.store.data.tasks.find(t => t.id === id && t.owner === owner)
      : this.store.data.tasks.filter(t => t.owner === owner).at(-1)) ?? null;
  }

  async cancel(ctx: Context, parent: Agent, id?: string): Promise<Task | null> {
    const task = this.task(parent.id, id);
    if (!task || (!ongoing(task) && task.state !== 'interrupted')) return task;
    const active = this.active.get(task.id);
    if (this.pending?.id === task.id) this.pending.abort.abort();
    task.state = 'stopping';
    try { this.persist(task); } catch { /* A metadata failure must not prevent a requested stop. */ }
    try {
      // Stop the game connection as well as the model. Killing a conversation alone does not pause a game.
      await this.release(ctx, task, async () => {
        if (active) await active.activation.dispose();
        else if (task.childId) await ctx.subagents.drainChildren(parent, [task.childId]);
      });
      task.state = 'cancelled';
    } catch (error) {
      task.state = 'interrupted';
      task.diagnostic = error instanceof Error ? error.message : '停止未确认，请核对现场。';
    }
    this.persist(task);
    return task;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    for (const task of this.store.data.tasks) if (ongoing(task)) task.state = 'interrupted';
    const handles = [...this.active.entries()];
    await Promise.allSettled(handles.map(async ([id, handle]) => {
      const task = this.store.data.tasks.find(t => t.id === id)!;
      await this.release(handle.ctx, task, () => handle.activation.dispose());
    }));
    this.store.save();
  }
}

let instance: Director | undefined;
export function enable(readSettings: () => Settings): () => Promise<void> {
  if (instance) throw new Error('游戏导演根插件已经启用。');
  const created = new Director(readSettings);
  instance = created;
  return async () => { try { await created.close(); } finally { if (instance === created) instance = undefined; } };
}
export function director(): Director {
  if (!instance) throw new Error('请先启用 dsh-game-director 根插件。');
  return instance;
}
export const defaults: Settings = {
  playBindings: DEFAULT_BINDINGS, maxDevelopmentAttempts: 2,
  developerProvider: 'deepseek-official', developerModel: 'deepseek-flash', reaCommand: 'rea',
};
