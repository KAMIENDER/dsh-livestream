/** Small structural view of DSH's public services. No private loop or session creation APIs. */
export interface Agent { readonly id: string; readonly session: unknown }
export interface Exec { agent?: Agent; signal: AbortSignal }
export interface Text { type: 'text'; text: string }
export interface Result {
  readonly stopReason: string;
  readonly output: readonly { type: string; text?: string }[];
  readonly structured?: unknown;
  readonly diagnostic?: string;
}
export interface Activation {
  readonly childId: string;
  readonly result: Promise<Result>;
  dispose(): Promise<void>;
}
export interface Preset { id: string; name?: string; description?: string; broken?: string }
export interface Context {
  get?(name: string): unknown;
  tools: { register(tool: unknown): () => void };
  effect(effect: () => () => void | Promise<void>, label?: string): unknown;
  agentPresets: { list(): Promise<Preset[]> };
  workingDirectory: { ensure(agent: Agent, signal?: AbortSignal): Promise<string> };
  llm: { resolveCallConfig(options: { provider: string; model: string }, signal: AbortSignal): Promise<unknown> };
  subagents: {
    getProvider(name: string): { capabilities: { agentPreset: boolean; outputSchema: boolean; depthLimit: boolean; agentOptions: boolean } } | undefined;
    resolveMaxDepth(configured?: number): number | undefined;
    drainChildren(parent: Agent, childIds: readonly string[]): Promise<void>;
    startActivation(spec: {
      provider: string;
      label: string;
      request: {
        parent: Agent;
        cwd: string;
        agentPreset: string;
        prompt: Text[];
        outputSchema?: Record<string, unknown>;
        agentOptions?: { provider: string; model: string };
        maxDepth?: number;
      };
      signal: AbortSignal;
      delivery: 'parent';
    }): Promise<Activation>;
  };
}
export interface GameControl {
  readonly gameId: string;
  stopSession(ownerId: string): Promise<{ stopped: boolean; message?: string }>;
}
