import { homedir } from 'node:os';
import { join } from 'node:path';
import { CharacterStore } from './store.js';

export const name = 'dsh-character';
interface Context { provide(name: string, service: unknown): void; effect(work: () => () => void, label?: string): unknown }
export function apply(ctx: Context): void {
  const store = new CharacterStore(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-character', 'memory.sqlite'));
  ctx.provide('characterMemory', store);
  ctx.effect(() => () => store.close(), 'character memory lifecycle');
}
