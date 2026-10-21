/**
 * 同一个模板里换布局：平时是聊天布局，放视频时换成模板写的 video 布局（见 protocol.ts 的 layouts）。
 */

import type { LayoutPlacement, TemplateManifest, WidgetPlacement } from './protocol';

export type Mode = 'chat' | 'video';

export interface Slot extends WidgetPlacement {
  key: string;
  scale?: number;
  hidden?: boolean;
}

/** 模板没写 video 布局：视频摆在画布中间偏上，别的挂件不动 */
function defaultVideoLayout(t: TemplateManifest): LayoutPlacement[] {
  const [cw, ch] = t.canvas;
  const w = Math.round(cw * 0.6);
  return [{ type: 'video', x: Math.round((cw - w) / 2), y: Math.round(ch * 0.08), w, h: Math.round((w * 9) / 16) }];
}

/**
 * 这个布局下每个挂件摆哪：平时的布局，按 type 套上 video 布局里写的位置。
 * 只在 video 布局里有的挂件（视频画面）平时也摆着、藏起来：切换时挂件平滑挪动，新出现的淡入
 */
export function arrange(t: TemplateManifest, mode: Mode): Slot[] {
  const video = t.layouts?.video ?? defaultVideoLayout(t);
  const matched = new Set<number>();
  const slots: Slot[] = t.widgets.map((p, i) => {
    const j = video.findIndex((l, k) => l.type === p.type && !matched.has(k));
    if (j >= 0) matched.add(j);
    return { ...p, ...(mode === 'video' && j >= 0 ? video[j] : {}), key: `${p.type}-${i}` };
  });
  video.forEach((l, k) => {
    if (!matched.has(k)) slots.push({ x: 0, y: 0, ...l, key: `video-${l.type}-${k}`, hidden: mode !== 'video' || l.hidden });
  });
  return slots;
}
