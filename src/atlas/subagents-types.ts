export type SubagentKind = 'research' | 'implement' | 'review';
export type SubagentComplexity = 'routine' | 'complex';
export interface SubagentSettings { enabled: boolean; mode: 'efficient' | 'match'; maxHelpers: number }
export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {enabled: true, mode: 'efficient', maxHelpers: 4};
export function normalizeSubagentSettings(value: unknown): SubagentSettings {
  const v = value && typeof value === 'object' ? value as Partial<SubagentSettings> : {};
  return {enabled: v.enabled !== false, mode: v.mode === 'match' ? 'match' : 'efficient',
    maxHelpers: typeof v.maxHelpers === 'number' && Number.isFinite(v.maxHelpers) ? Math.max(1, Math.min(8, Math.floor(v.maxHelpers))) : 4};
}
export interface SubagentSpawnInput {
  conversationId: string; title: string; task: string; kind: SubagentKind;
  complexity: SubagentComplexity; ownedFiles?: string[];
}
export interface SubagentChange { path: string; kind: 'added' | 'modified' | 'deleted'; beforeHash: string | null; afterHash: string | null; bytes: number }
export interface SubagentPatchReview {
  changes: SubagentChange[]; diff?: string; warning?: string; partial: boolean;
  path?: string; offset?: number; totalLines?: number; text?: string;
}
export interface SubagentModelChoice { key: string; label: string; thinkingLevel: string; routingReason: string }
export interface SubagentUsage { input: number; output: number }
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface SubagentTask extends SubagentSpawnInput {
  id: string; status: SubagentStatus; phase: string; createdAt: number; startedAt?: number;
  endedAt?: number; lastActivityAt: number; model: SubagentModelChoice;
  /** Wall-clock budget starts when the helper gets a slot, not while queued. */
  timeBudgetMs?: number; deadlineAt?: number; maxDeadlineAt?: number;
  stopReason?: 'time_limit' | 'cancelled';
  summary?: string; error?: string; changes?: SubagentChange[]; usage?: SubagentUsage;
  /** Incomplete work is reviewable, never treated as a successful task. */
  partialPatch?: boolean; patchError?: string;
  applied?: boolean;
  stagingPath?: string;
}
export interface SubagentSnapshot { conversationId: string; settings: SubagentSettings; tasks: SubagentTask[] }
