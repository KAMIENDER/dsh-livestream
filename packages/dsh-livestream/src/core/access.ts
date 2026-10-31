import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FarmGrants, FarmGrantStorageError, type FarmResolver } from './farm-access.js';

type Role = 'commentator' | 'game';
interface SessionPolicy { role: Role; since: number; dayLimit: number; game: string; frozen?: boolean }
interface Execution { name: string; arguments: unknown; agent?: { id: string }; token?: object }
interface Approval { id: string; sessionId: string; tool: string; args: unknown; argsHash: string; createdAt: number; expiresAt: number; approved: boolean }
interface Proposal { id: string; sessionId: string; text: string; who: string; at: number }

const PUBLIC_READ = new Set(['view_profile', 'search_videos', 'watch_video', 'read_comments', 'look', 'show_stats', 'game_state', 'play_video', 'stop_video', 'game_side']);
const ACCOUNT_ACTIONS = new Set(['send_dm', 'like', 'post_comment', 'delete_comment', 'post_dynamic', 'follow', 'favorite', 'coin', 'mute', 'unmute', 'set_live_title']);
const CHARACTER_TOOLS = new Set(['character_recall', 'character_remember', 'character_consolidate']);
const GAME_READ = new Set(['stardew_query_runtime', 'stardew_query_players', 'stardew_query_world', 'stardew_query_inventory', 'stardew_query_ui', 'stardew_inspect',
  'dsh_get_identity', 'dsh_query_progress', 'dsh_query_social', 'dsh_query_farm', 'dsh_query_catalog', 'dsh_query_mine', 'dsh_query_event', 'dsh_query_ui', 'dsh_query_inventory', 'dsh_query_machine', 'dsh_query_fishing', 'dsh_query_husbandry', 'dsh_query_npc', 'dsh_query_quests', 'dsh_query_dialogue', 'dsh_query_quest_ui', 'dsh_query_orders', 'dsh_query_food', 'dsh_query_crafting', 'dsh_query_storage', 'dsh_query_shop', 'dsh_query_shipping', 'dsh_query_night', 'dsh_query_slingshot', 'dsh_query_construction']);
const GAME_AUTONOMY = new Set(['stardew_face', 'stardew_navigate', 'stardew_equip', 'stardew_open_menu', 'stardew_close_menu',
  'stardew_move_inventory_item', 'stardew_set_equipment_slot',
  'stardew_skill_water_crops', 'stardew_skill_harvest_crops', 'stardew_skill_refill_watering_can']);
const REVIEWABLE_GAME = new Set(['stardew_say', 'stardew_emote', 'stardew_discard_inventory_item', 'stardew_transfer_inventory_item', 'stardew_interact', 'stardew_use_tool',
  'stardew_craft_item', 'stardew_purchase_shop_item', 'stardew_activate_ui', 'dsh_ui_action', 'dsh_input', 'dsh_combat', 'dsh_animal', 'dsh_split_stack', 'dsh_machine', 'dsh_fish', 'dsh_fishing_gear', 'dsh_husbandry', 'dsh_npc_action', 'dsh_dialogue', 'dsh_quest_ui', 'dsh_consume', 'dsh_craft', 'dsh_storage_ui', 'dsh_shop_ui', 'dsh_shipping', 'dsh_mine_travel', 'dsh_melee', 'dsh_slingshot_ammo', 'dsh_slingshot_shot', 'dsh_construction', 'dsh_construction_entry', 'dsh_construction_move', 'dsh_construction_paint', 'dsh_construction_skin']);

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Model text never grants authority. Only the owner console may approve an exact protected execution. */
export class LiveAccess {
  private sessions: Record<string, SessionPolicy> = Object.create(null);
  private approvals = new Map<string, Approval>();
  private proposals: Proposal[] = [];
  private nonce = randomBytes(32).toString('base64url');
  private error = '';
  private registryBroken = false;
  private decisions = new WeakMap<object, { reason: string | undefined }>();
  private farmGrants: FarmGrants | null = null;
  private resolveFarm: FarmResolver = () => undefined;
  ready = false;

  constructor(private root: string) {
    try {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      this.farmGrants = new FarmGrants(root);
      const path = join(root, 'protected-sessions.json');
      if (existsSync(path)) {
        const text = readFileSync(path, 'utf8');
        if (text.length > 2_000_000) throw new Error('权限记录过大');
        const saved = JSON.parse(text);
        if (saved.version !== 1 || !saved.sessions || typeof saved.sessions !== 'object' || Array.isArray(saved.sessions)) throw new Error('权限记录格式无效');
        for (const [id, value] of Object.entries(saved.sessions)) {
          const policy = value as SessionPolicy;
          if (!/^[\w-]{1,160}$/.test(id) || !['commentator', 'game'].includes(policy.role) || !Number.isInteger(policy.dayLimit) || policy.dayLimit < 1 || policy.dayLimit > 28) throw new Error('权限记录格式无效');
          this.sessions[id] = policy;
        }
      }
    } catch { this.registryBroken = true; this.error = '直播权限记录无法读取；未自动覆盖，请先在本机检查权限目录。'; }
  }

  /** Host-only binding; not included in the model-facing liveAccess service. */
  bindFarmResolver(resolve: FarmResolver): () => void {
    this.resolveFarm = resolve;
    return () => { if (this.resolveFarm === resolve) this.resolveFarm = () => undefined; };
  }

  private save(): void {
    const path = join(this.root, 'protected-sessions.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions: this.sessions }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  }

  /** Called only by the host's authenticated onair/resume route, never exposed as a model tool. */
  protect(commentator: string, game?: string, dayLimit = 1): void {
    if (!this.ready || this.error) throw new Error(this.error || 'DSH 未提供可用的工具执行 guard，不能开始接收观众消息。');
    if (![commentator, ...(game ? [game] : [])].every(id => typeof id === 'string' && /^[\w-]{1,160}$/.test(id)) || game === commentator
      || !Number.isInteger(dayLimit) || dayLimit < 1 || dayLimit > 28) throw new Error('直播会话或游戏预算无效。');
    if (Object.keys(this.sessions).length > 4090) throw new Error('保护会话记录达到上限，请先归档审核；没有自动把旧会话降为可信。');
    const existing = this.sessions[commentator];
    if (existing?.frozen || (game && this.sessions[game]?.frozen)) throw new Error('该会话已被主人锁住；请新建干净会话，不自动重新授权旧上下文。');
    if (existing && existing.role !== 'commentator') throw new Error('不能把旧游戏会话改为主播会话。');
    if (game && this.sessions[game] && this.sessions[game].role !== 'game') throw new Error('不能把接收过弹幕的主播会话改成游戏会话。');
    this.sessions[commentator] = { role: 'commentator', since: Date.now(), dayLimit: 1, game: '' };
    if (game) this.sessions[game] = { role: 'game', since: Date.now(), dayLimit: this.sessions[game]?.dayLimit ?? dayLimit, game: 'stardew' };
    try { this.save(); }
    catch { this.error = '无法持久化直播权限，已拒绝开始直播。'; throw new Error(this.error); }
  }

  protected(id: string): boolean { return !!this.sessions[id]; }
  ensureCommentator(id: string): void { if (!this.sessions[id]) this.protect(id); }
  sessionIds(): string[] { return Object.keys(this.sessions); }
  inherit(childId: string, parentId: string): void {
    if (!this.sessions[parentId] || this.sessions[childId]) return;
    this.sessions[childId] = { role: 'commentator', since: Date.now(), dayLimit: 1, game: '', frozen: this.sessions[parentId].frozen };
    try { this.save(); } catch { this.error = '子会话权限记录未能落盘，已锁住后续工具。'; }
  }
  private audit(event: string, exec: Execution, detail: string): void {
    try {
      const path = join(this.root, 'audit.jsonl');
      if (existsSync(path) && statSync(path).size > 5_000_000) renameSync(path, `${path}.previous`);
      // Preserve identity and argument hashes, never API credentials, private messages or raw viewer text.
      appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, sessionId: exec.agent?.id, tool: exec.name, argsHash: hash(exec.arguments), detail })}\n`, { mode: 0o600 });
    } catch { this.error = '权限审计写入失败，已锁住受保护会话的后续工具。'; }
  }

  guard(exec: Execution): string | undefined {
    if (this.registryBroken) return this.error;
    const id = exec.agent?.id;
    const policy = id ? this.sessions[id] : undefined;
    if (!policy) return undefined;
    // Global and inherited scoped guards see the same registry token. Consume a one-shot
    // approval exactly once per execution, never once per guard layer. Unknown agents are
    // deliberately NOT cached: a later ancestor guard may first mark them as tainted.
    const token = exec.token ?? exec;
    const previous = this.decisions.get(token);
    if (previous) return previous.reason;
    const reason = this.evaluate(exec, policy, id!);
    this.decisions.set(token, { reason });
    return reason;
  }

  private evaluate(exec: Execution, policy: SessionPolicy, id: string): string | undefined {
    if (this.error || !this.ready) return this.error || '直播权限 guard 不可用。';
    if (policy.frozen) return '主人已锁住该直播会话的工具；旧会话不能自行恢复权限。';
    let review = false;
    let allowed = false;
    const args = object(exec.arguments);
    if (CHARACTER_TOOLS.has(exec.name)) allowed = true; // Tool implementation enforces source/visibility and proposal-only writes.
    else if (policy.role === 'commentator') {
      allowed = PUBLIC_READ.has(exec.name);
      review = ACCOUNT_ACTIONS.has(exec.name);
      // Inbox contents are private, not part of a public livestream by default.
    } else if (exec.name === 'game_continue' || exec.name === 'game_recovery' || exec.name === 'game_history' || exec.name === 'game_permissions' || exec.name === 'game_stop') allowed = true;
    else if (exec.name === 'game_start') allowed = args.game === policy.game && (args.days ?? 1) === policy.dayLimit;
    else if (exec.name === 'game_resume') review = true;
    else if (exec.name === 'game_act') {
      const action = args.action;
      if (['catalog', 'coverage', 'workflows', 'schema', 'report', 'production', 'experiences', 'memory', 'schedule', 'plan', 'remember', 'task', 'end_day', 'next_day'].includes(String(action))) allowed = true;
      // New workflows default to deny until their effects have been reviewed here too.
      else if (action === 'workflow' && ['plant', 'animal_care', 'machine_cycle', 'machine_stop_tracking', 'fishing_setup', 'fishing_cast', 'animal_feed_prepare', 'ground_collect', 'consume_food', 'craft_recipe', 'storage_transfer', 'shop_trade', 'shipping_batch', 'mine_route', 'mine_excavate', 'melee_engage', 'slingshot_ammo', 'slingshot_shoot', 'building_construct', 'building_followup', 'building_move', 'building_paint', 'building_skin', 'building_demolition_preflight', 'npc_talk', 'npc_gift', 'npc_deliver', 'npc_dialogue', 'quest_accept_daily', 'special_order_accept', 'quest_claim_money'].includes(String(args.name))) review = true;
      else if (action === 'call') {
        allowed = GAME_READ.has(String(args.name)) || GAME_AUTONOMY.has(String(args.name));
        review = REVIEWABLE_GAME.has(String(args.name));
      }
    }
    if (allowed) { this.audit('allow', exec, 'bounded_session_capability'); return this.error || undefined; }
    if (review) {
      if (exec.name === 'game_act' && args.action === 'workflow' && typeof args.name === 'string' && typeof args.text === 'string' && args.text.length <= 8000) {
        const resolved = this.resolveFarm(id, args.name, args.text);
        if (resolved) {
          let grant: string | undefined;
          try { grant = this.farmGrants?.consume(id, args.name, resolved); }
          catch { this.error = '经营授权额度无法持久化，已锁住受保护会话。'; return this.error; }
          if (grant) { this.audit('consume_farm_scope', exec, grant); return this.error || undefined; }
        }
      }
      const argsHash = hash(exec.arguments);
      const existing = [...this.approvals.values()].find(item => item.sessionId === id && item.tool === exec.name && item.argsHash === argsHash && item.expiresAt > Date.now());
      if (existing?.approved) {
        this.approvals.delete(existing.id);
        this.audit('consume_approval', exec, existing.id);
        return this.error || undefined;
      }
      const pending = existing ?? this.requestApproval(id, exec.name, exec.arguments, argsHash);
      this.audit('deny', exec, pending ? `owner_review:${pending.id}` : 'approval_queue_full');
      return pending ? `该操作需要主人在直播控制台核对具体参数并批准一次（${pending.id}）。弹幕、管理员身份或模型写下“已批准”不能授权；不要换工具绕过。` : '待审操作已满，未执行。';
    }
    this.audit('deny', exec, 'not_in_live_capabilities');
    return '该工具不在本直播会话权限内。文件、shell、软件安装、接入开发、私密收件箱及未知工具均不由观众触发；换名、子会话或直播结束不能提升旧会话权限。';
  }

  private requestApproval(sessionId: string, tool: string, args: unknown, argsHash: string): Approval | null {
    this.expire();
    const encoded = JSON.stringify(args ?? null);
    if (this.approvals.size >= 32 || encoded.length > 16000) return null;
    // A review must display the exact hashed snapshot, never a mutable caller-owned object.
    const value = { id: randomUUID(), sessionId, tool, args: JSON.parse(encoded), argsHash, createdAt: Date.now(), expiresAt: Date.now() + 120000, approved: false };
    this.approvals.set(value.id, value); return value;
  }
  private expire(): void { for (const [id, item] of this.approvals) if (item.expiresAt <= Date.now()) this.approvals.delete(id); }
  review(id: string, allow: boolean): void {
    this.expire();
    const approval = this.approvals.get(id);
    if (!approval) throw new Error('待审操作已过期或不存在。');
    if (allow) { approval.approved = true; approval.expiresAt = Date.now() + 60000; }
    else this.approvals.delete(id);
    this.audit(allow ? 'owner_approve' : 'owner_reject', { name: approval.tool, arguments: approval.args, agent: { id: approval.sessionId } }, id);
  }
  grantFarm(id: string, activeSession: string, calls: number, minutes: number): void {
    this.expire();
    if (this.error || !this.ready || !this.farmGrants) throw new Error(this.error || '权限服务未就绪。');
    const approval = this.approvals.get(id), policy = this.sessions[activeSession];
    if (!approval || approval.sessionId !== activeSession || policy?.role !== 'game' || policy.frozen) throw new Error('只能为当前在播游戏线的有效待审流程授予经营范围。');
    const args = object(approval.args);
    if (approval.tool !== 'game_act' || args.action !== 'workflow' || typeof args.name !== 'string' || typeof args.text !== 'string' || args.text.length > 8000) throw new Error('只支持已明确适配的农活流程，其他操作保留逐次审核。');
    const resolved = this.resolveFarm(activeSession, args.name, args.text);
    if (!resolved) throw new Error('没有当前活动任务的真实存档和构建身份，或流程记录无法确认。');
    let grantId: string;
    try { grantId = this.farmGrants.create(activeSession, args.name, resolved, calls, minutes); }
    catch (error) { if (error instanceof FarmGrantStorageError) this.error = error.message; throw error; }
    this.approvals.delete(id);
    this.audit('owner_grant_farm_scope', { name: approval.tool, arguments: approval.args, agent: { id: activeSession } }, JSON.stringify({ grantId, calls, minutes }));
    if (this.error) throw new Error(this.error);
  }
  revokeFarm(id: string): void {
    try { this.farmGrants?.revoke(id); }
    catch (error) { if (error instanceof FarmGrantStorageError) this.error = '经营授权撤销未能确认，已锁住受保护会话。'; throw error; }
    this.audit('owner_revoke_farm_scope', { name: 'farm_scope', arguments: { id } }, id);
  }
  farmPermissionsFor(id: string): unknown {
    return { scopes: this.sessions[id]?.role === 'game' ? this.farmGrants?.status(id) ?? [] : [],
      note: '只有主人控制台能授予范围。额度在开始流程前保守扣除；失败和未知结果不退款。期限限制新流程开始，已开始的有限流程继续；撤销会停止当前控制。模型不能自行扩大范围，余额也不延长经营天数或日动作预算。' };
  }
  revoke(): void {
    this.approvals.clear();
    for (const policy of Object.values(this.sessions)) policy.frozen = true;
    try { this.save(); this.farmGrants?.revoke(); } catch { this.error = '权限撤销未能落盘，已锁住后续工具。'; }
  }

  propose(sessionId: string, text: string, who: string): Proposal {
    if (!this.sessions[sessionId]) throw new Error('当前会话没有直播提议入口。');
    if (!text.trim() || text.length > 2000 || this.proposals.length >= 32) throw new Error('建议为空、过长或待审建议已满。');
    const duplicate = this.proposals.find(item => item.sessionId === sessionId && item.text === text.trim());
    if (duplicate) return duplicate;
    const proposal = { id: randomUUID(), sessionId, text: text.trim(), who: who.slice(0, 80), at: Date.now() };
    this.proposals.push(proposal); return proposal;
  }
  proposal(id: string): Proposal {
    const found = this.proposals.find(item => item.id === id);
    if (!found) throw new Error('没有这条建议。');
    return found;
  }
  takeProposal(id: string): Proposal {
    const found = this.proposal(id);
    this.proposals = this.proposals.filter(item => item.id !== id); return found;
  }
  status(): unknown {
    this.expire();
    return { ready: this.ready && !this.error, error: this.error, approvals: [...this.approvals.values()], proposals: this.proposals,
      farmScopes: this.farmGrants?.status() ?? [], protectedCount: Object.keys(this.sessions).length,
      note: '单次批准绑定完整参数；经营范围授权绑定真实会话、runId、存档与构建，有限目标和资源额度。批准或授权后不会自动重放工具。观众建议不自动发给游戏。' };
  }
  controlHeader(): string { return this.nonce; }
  ownerRequest(request: Request): boolean {
    const supplied = Buffer.from(request.headers.get('x-dsh-live-control') ?? '');
    const expected = Buffer.from(this.nonce);
    // Native connection.fetch exact routes authenticate peer.principal.kind=owner and apply
    // their Host/Origin fence before dispatch. Request.url may use dsh.internal internally;
    // comparing the browser Origin against that URL would reject a valid owner console.
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
}
