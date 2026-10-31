import { object, type ObjectValue } from '../workflow-context.js';
const int = (v: unknown, lo: number, hi: number): v is number => Number.isSafeInteger(v) && Number(v) >= lo && Number(v) <= hi;

export function validConstructionColors(v: unknown): v is ObjectValue {
  return object(v) && typeof v.name === 'string' && Array.isArray(v.regions) && v.regions.length === 3 && v.regions.every((r: unknown, i: number) => object(r)
    && r.index === i && typeof r.default === 'boolean' && ['hue', 'saturation', 'lightness'].every(c => int(r[c], -10000, 10000)));
}
