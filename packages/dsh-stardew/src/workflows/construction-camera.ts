import { object, positionOf, requireFact, type ObjectValue } from '../workflow-context.js';
const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;

// Native carpenter edge-pan geometry shared by build, move and paint.
export function constructionCameraRequest(q: ObjectValue, p: ReturnType<typeof positionOf>, blocked: Set<string>): ObjectValue | null {
  const v = q.viewport, c = q.menu?.cancelBounds;
  requireFact(object(v) && int(v.x, -1000000, 1000000) && int(v.y, -1000000, 1000000) && int(v.width, 256, 20000) && int(v.height, 256, 20000)
    && object(c) && int(c.x, -20000, 20000) && int(c.y, -20000, 20000) && int(c.width, 1, 20000) && int(c.height, 1, 20000), '建造类菜单镜头或原生取消控件几何不可用。');
  const scale = v.uiScale / v.zoomLevel, x = p.x * 64 + 32 - v.x, y = p.y * 64 + 32 - v.y;
  requireFact(Number.isFinite(scale) && scale > 0, '实际世界/UI缩放不可用。');
  const overlaps = x / scale >= c.x && x / scale < c.x + c.width && y / scale >= c.y && y / scale < c.y + c.height;
  if (x >= 64 && x < v.width - 128 && y >= 64 && y < v.height - 64 && !overlaps) return null;
  const direction = overlaps ? blocked.has('right') ? 'down' : 'right' : x < 64 ? 'left' : x >= v.width - 128 ? 'right' : y < 64 ? 'up' : 'down';
  const distance = overlaps ? direction === 'right' ? x - (c.x - 16) * scale : y - (c.y - 16) * scale
    : direction === 'left' ? (v.width - 64) / 2 - x : direction === 'right' ? x - (v.width - 64) / 2 : direction === 'up' ? v.height / 2 - y : y - v.height / 2;
  return { direction, panPixels: Math.max(8, Math.min(512, Math.ceil(distance))) };
}
