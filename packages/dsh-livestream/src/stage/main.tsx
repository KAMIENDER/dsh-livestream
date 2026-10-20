/**
 * 舞台页：OBS 的浏览器源打开它（1920×1080 或模板写的尺寸）。按模板摆挂件、套主题变量、加载模板自己的 style.css。
 * 窗口和画布不一样大时整体缩放（控制台里的小预览也是这一页）。
 */

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { WidgetPlacement, WidgetType } from './protocol';
import { assetUrl, connect, preview, unlockAudio } from './store';
import { AiLabel, Alerts, Character, Chat, Reply, Status, Subtitle, useStage } from './widgets';

const WIDGETS: Record<WidgetType, React.ComponentType<{ options?: Record<string, unknown> }>> = {
  character: Character,
  subtitle: Subtitle,
  chat: Chat,
  alerts: Alerts,
  status: Status,
  'ai-label': AiLabel,
  reply: Reply,
};

function useViewport(): { width: number; height: number } {
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);
  return size;
}

function Placed({ p }: { p: WidgetPlacement }) {
  const Widget = WIDGETS[p.type];
  if (!Widget) return null;
  return (
    <div className={`ls-slot ls-slot-${p.type}`} style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
      <Widget options={p.options} />
    </div>
  );
}

function App() {
  const { template, needsClick } = useStage();
  const { width, height } = useViewport();
  // 模板自己的样式：每次换模板、每次打开页面都重新加载（服务器让浏览器缓存一小时，改了模板刷新一下就要看到）
  useEffect(() => {
    if (!template) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${assetUrl('templates', template.id, 'style.css')}&v=${Date.now()}`;
    document.head.append(link);
    return () => link.remove();
  }, [template?.id]);
  if (!template) return <div className="ls-loading">舞台连接中…</div>;
  const [cw, ch] = template.canvas;
  const scale = Math.min(width / cw, height / ch);
  return (
    <div className="ls-viewport">
      <div
        className={`ls-canvas ls-template-${template.id}`}
        style={{ width: cw, height: ch, transform: `scale(${scale})`, left: (width - cw * scale) / 2, top: (height - ch * scale) / 2, ...template.theme } as React.CSSProperties}
      >
        {/* 背景和前景各几层空的 div：模板拿它们（和各自的 ::before / ::after）画光、气泡、云……，挂件在中间 */}
        <div className="ls-backdrop"><i className="ls-layer ls-layer-1" /><i className="ls-layer ls-layer-2" /><i className="ls-layer ls-layer-3" /></div>
        {template.widgets.map((p, i) => <Placed key={`${p.type}-${i}`} p={p} />)}
        <div className="ls-overlay"><i className="ls-layer ls-layer-1" /><i className="ls-layer ls-layer-2" /></div>
      </div>
      {needsClick && !preview && (
        <button className="ls-unlock" onClick={unlockAudio}>点一下这里开启声音（OBS 的浏览器源不需要）</button>
      )}
    </div>
  );
}

connect();
createRoot(document.getElementById('root')!).render(<App />);
