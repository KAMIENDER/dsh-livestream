/**
 * 舞台事件流（v1）：身体推给舞台页的全部东西。模板和挂件只读这里，不含任何逻辑，
 * 所以换皮不会把直播弄坏；别人写的模板和挂件按这个版本号对接。
 *
 * 连接：GET /events?token=…（SSE，每条 data 是一个 StageEvent）。舞台念完一句回执 POST /said?id=…&token=…。
 */

export const STAGE_PROTOCOL = 1;

/** 角色包清单（assets/characters/<id>/character.json） */
export interface CharacterManifest {
  format: 1;
  id: string;
  name: string;
  /** 观众叫她时用的名字（点名判断） */
  names: string[];
  /** 默认豆包音色 */
  voice?: string;
  renderer: 'clips' | 'image';
  license?: string;
  /** 动画片段渲染器：待机循环、说话循环；有表情时先播 out，再播表情，再播 in 回到说话 */
  clips?: {
    size: [number, number];
    idle: string;
    talk: string;
    out?: string;
    in?: string;
    moods: Record<string, string>;
  };
  /** 立绘渲染器：一张图，说话时轻轻弹跳；moods 是表情差分 */
  image?: {
    size: [number, number];
    idle: string;
    moods?: Record<string, string>;
  };
}

/** 模板清单（templates/<id>/template.json）：只管布局、主题、放哪些挂件 */
export interface TemplateManifest {
  format: 1;
  id: string;
  name: string;
  /** 画布大小，OBS 浏览器源按这个尺寸设 */
  canvas: [number, number];
  /** CSS 变量：颜色、字体……挂件都读这些变量 */
  theme: Record<string, string>;
  widgets: WidgetPlacement[];
}

export type WidgetType = 'character' | 'subtitle' | 'chat' | 'alerts' | 'status' | 'ai-label';

export interface WidgetPlacement {
  type: WidgetType;
  /** 画布坐标（像素） */
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** 挂件自己的参数 */
  options?: Record<string, unknown>;
}

/** 观众（舞台显示用，已清洗） */
export interface StageUser {
  id: string;
  name: string;
  face?: string;
  guard?: number;
  medal?: { name: string; level: number };
  admin?: boolean;
}

export type StageLiveEvent =
  | { kind: 'chat'; id: string; user: StageUser; text: string; sticker?: string }
  | { kind: 'gift'; id: string; user: StageUser; gift: string; count: number; yuan: number }
  | { kind: 'superchat'; id: string; user: StageUser; text: string; yuan: number }
  | { kind: 'membership'; id: string; user: StageUser; level: string; count: number }
  | { kind: 'enter' | 'follow'; id: string; user: StageUser };

/** 大脑现在在干什么：舞台上「正在想…」的提示用 */
export type BrainState = 'off' | 'listening' | 'thinking' | 'speaking' | 'away';

export type StageEvent =
  | { v: 1; type: 'hello'; character: CharacterManifest; template: TemplateManifest; at: number }
  | { v: 1; type: 'say'; id: string; text: string; mood: string; audio: string | null; estimateMs: number; at: number }
  | { v: 1; type: 'brain'; state: BrainState; detail?: string; at: number }
  /** isUpdate：同 id 再来一次（礼物连击累加） */
  | { v: 1; type: 'live'; event: StageLiveEvent; isUpdate: boolean; at: number }
  /** 她正在回应这几位观众（弹幕流里高亮） */
  | { v: 1; type: 'focus'; userIds: string[]; at: number }
  | { v: 1; type: 'room'; online?: number; title?: string; onAir: boolean; at: number }
  /** 模板或角色换了：舞台重新加载 */
  | { v: 1; type: 'reload'; at: number };
