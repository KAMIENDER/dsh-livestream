/** Shared boundary for future game drivers; game rules stay in each driver. */
export interface GameAction {
  action: string;
  name?: string;
  text?: string;
}
export type { StoryObserver } from './experiences.js';

export interface GameDriver {
  readonly id: string;
  readonly title: string;
  readonly active: boolean;
  readonly finished: boolean;
  readonly farmId?: string;
  /** Host policy inspection only. The host supplies the actual session; model text supplies no identity. */
  autonomyRequest?(workflow: string, text: string): { binding: { runId: string; saveId: string; gameBuildId: string }; request: unknown } | undefined;
  start(signal: AbortSignal): Promise<string>;
  observe(signal: AbortSignal): Promise<string>;
  act(action: GameAction, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}

export interface LiveBody {
  readonly onAir: boolean;
  readonly gameSessionId?: string | null;
  showGame(source: { window: string } | null): void;
}
