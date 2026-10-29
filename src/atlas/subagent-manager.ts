import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  SubagentChange, SubagentComplexity, SubagentKind, SubagentModelChoice,
  SubagentSettings, SubagentSpawnInput, SubagentTask, SubagentUsage,
} from './subagents-types.js';

export interface SubagentRoutingModel {
  key: string;
  provider: string;
  id: string;
  name: string;
  thinkingLevel: string;
  reasoning?: boolean;
  vision?: boolean;
  supportedThinkingLevels?: string[];
}

/** Select from the connected provider's catalogue; catalogue entries do not prove account access. */
export function chooseEfficientModel(input: {
  parent: SubagentRoutingModel;
  available: SubagentRoutingModel[];
  mode: SubagentSettings['mode'];
  kind: SubagentKind;
  complexity: SubagentComplexity;
  requiresVision?: boolean;
  /** Models explicitly rejected for this account/conversation, supplied by the controller. */
  excludedModelKeys?: ReadonlySet<string>;
}): SubagentModelChoice {
  const { parent, available, mode, kind, complexity } = input;
  const retain = (routingReason: string): SubagentModelChoice => ({
    key: parent.key, label: parent.name, thinkingLevel: parent.thinkingLevel, routingReason,
  });
  if (mode === 'match') return retain('Match mode keeps the main model and thinking level.');
  if (kind !== 'research' || complexity !== 'routine') {
    return retain('Implementation, review, and complex work keep the main model and thinking level.');
  }
  if (/(?:\bluna\b|\bmini\b|\bhaiku\b)/i.test(`${parent.id} ${parent.name}`)) {
    return retain('The main model is already economical; keeping its model and thinking level.');
  }
  const lighter = available.filter(model => model.provider === parent.provider
    && model.key !== parent.key
    && !input.excludedModelKeys?.has(model.key)
    // The catalogue advertises this model for Codex, but the ChatGPT account
    // endpoint rejects direct requests. Keep API-key use eligible and leave
    // manual main-model selections unchanged; only automatic routing is gated.
    && !(model.provider === 'openai-codex' && /^gpt-5\.4-mini(?:-\d{4}-\d{2}-\d{2})?$/i.test(model.id))
    && /(?:\bluna\b|\bmini\b|\bhaiku\b)/i.test(`${model.id} ${model.name}`)
    && (input.requiresVision !== true || model.vision === true));
  // Preserve catalogue order among eligible entries. Unknown families and
  // providers intentionally have no fallback.
  const chosen = lighter[0];
  if (!chosen) return retain('No compatible lighter model is available on the current provider; using the main model and thinking level.');
  const levels = chosen.supportedThinkingLevels;
  const thinkingLevel = chosen.reasoning === false ? 'off'
    : !levels || levels.includes('medium') ? 'medium'
      : ['low', 'minimal', 'off'].find(level => levels.includes(level)) ?? chosen.thinkingLevel;
  return {
    key: chosen.key, label: chosen.name, thinkingLevel,
    routingReason: `Routine research uses ${chosen.name} on the current provider with ${thinkingLevel} thinking.`,
  };
}

export interface SubagentRunContext {
  abortSignal: AbortSignal;
  update: (phase: string) => void;
  setSteer: (handler: (text: string) => Promise<void> | void) => void;
}
export interface SubagentRunResult {
  summary: string;
  changes?: SubagentChange[];
  usage?: SubagentUsage;
}
export interface SubagentManagerOptions {
  run: (task: SubagentTask, context: SubagentRunContext) => Promise<SubagentRunResult>;
  onChange?: (task: SubagentTask) => void;
  maxHelpers: () => number;
  resolveModel: (input: SubagentSpawnInput) => SubagentModelChoice;
  now?: () => number;
  persistencePath?: string;
  maxTaskMs?: number;
}

type Entry = {
  task: SubagentTask;
  controller?: AbortController;
  completion?: Promise<void>;
  finish?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  steer?: (text: string) => Promise<void> | void;
  pendingSteers: string[];
  steering?: Promise<void>;
  stopStatus?: 'cancelled' | 'failed';
  stopReason?: string;
};

const terminal = (task: SubagentTask) => task.status !== 'queued' && task.status !== 'running';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bounded = (value: unknown, max: number) => String(value ?? '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
export const SUBAGENT_EXTENSION_MS = 15 * 60_000;
export const SUBAGENT_MAX_TASK_MS = 120 * 60_000;
const cleanChanges = (changes: SubagentChange[]) => changes.slice(0, 500).map(change => ({
  path: bounded(change.path, 2048), kind: change.kind,
  beforeHash: change.beforeHash ? bounded(change.beforeHash, 256) : null,
  afterHash: change.afterHash ? bounded(change.afterHash, 256) : null,
  bytes: count(change.bytes),
}));

/** Background helpers share one bounded pool, round-robin across parent chats. */
export class SubagentManager {
  private readonly entries = new Map<string, Entry>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly stoppingConversations = new Set<string>();
  private readonly now: () => number;
  private readonly maxTaskMs?: number;
  private active = 0;
  private lastConversation?: string;
  private closed = false;
  private pumping = false;
  private historyTimer?: ReturnType<typeof setTimeout>;
  private readonly waitingIds = new Map<string, number>();
  /** A failed history write never silently changes the result of a helper. */
  persistenceError?: string;

  constructor(private readonly options: SubagentManagerOptions) {
    this.now = options.now ?? Date.now;
    this.maxTaskMs = typeof options.maxTaskMs === 'number' && Number.isFinite(options.maxTaskMs)
      ? Math.min(SUBAGENT_MAX_TASK_MS, Math.max(1, Math.floor(options.maxTaskMs))) : undefined;
    this.restore();
  }

  spawn(input: SubagentSpawnInput): SubagentTask {
    if (this.closed) throw new Error('The helper manager has stopped.');
    if ([...this.entries.values()].filter(entry => !terminal(entry.task)).length >= 64) throw new Error('The helper queue is full (64 active or queued tasks). Collect or stop existing helpers before adding more.');
    if (this.stoppingConversations.has(input.conversationId)) throw new Error('Helpers for this conversation are stopping.');
    if (typeof input.conversationId !== 'string' || !input.conversationId.trim()) throw new Error('A parent conversation is required.');
    if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 64_000) throw new Error('A helper task must contain between 1 and 64000 characters.');
    if (!['research', 'implement', 'review'].includes(input.kind)) throw new Error('Unknown helper kind.');
    if (!['routine', 'complex'].includes(input.complexity)) throw new Error('Unknown helper complexity.');
    const clean: SubagentSpawnInput = {
      conversationId: input.conversationId, title: bounded(input.title || input.task, 160),
      task: input.task, kind: input.kind, complexity: input.complexity,
      ...(input.ownedFiles ? { ownedFiles: [...new Set(input.ownedFiles.map(file => bounded(file, 2048)))].slice(0, 256) } : {}),
    };
    const model = this.options.resolveModel(clone(clean));
    if (!model?.key || !model.label) throw new Error('No model is available for this helper.');
    const at = this.now();
    const task: SubagentTask = {
      ...clean, id: randomUUID(), status: 'queued', phase: 'Waiting for a helper slot',
      createdAt: at, lastActivityAt: at, model: clone(model),
      timeBudgetMs: this.maxTaskMs ?? (clean.kind === 'research' && clean.complexity === 'routine' ? 20 : 30) * 60_000,
    };
    this.entries.set(task.id, { task, pendingSteers: [] });
    this.queue.push(task.id);
    this.publish(task);
    this.refreshLimits();
    return clone(task);
  }

  list(conversationId?: string): SubagentTask[] {
    return [...this.entries.values()].map(entry => entry.task)
      .filter(task => conversationId === undefined || task.conversationId === conversationId).map(clone);
  }

  get(id: string): SubagentTask | undefined {
    const task = this.entries.get(id)?.task;
    return task ? clone(task) : undefined;
  }

  isBusy(conversationId?: string): boolean {
    return [...this.entries.values()].some(({ task }) => !terminal(task)
      && (conversationId === undefined || task.conversationId === conversationId));
  }

  /** Raising the limit takes effect immediately; lowering it never kills work. */
  refreshLimits(): void {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const configured = this.options.maxHelpers();
      const limit = Number.isFinite(configured) ? Math.max(1, Math.min(8, Math.floor(configured))) : 4;
      while (this.active < limit && this.queue.length > 0) {
        const conversations = [...new Set(this.queue.map(id => this.entries.get(id)!.task.conversationId))];
        const nextConversation = conversations[(conversations.indexOf(this.lastConversation ?? '') + 1) % conversations.length];
        const index = this.queue.findIndex(id => this.entries.get(id)!.task.conversationId === nextConversation);
        const [id] = this.queue.splice(index, 1);
        const entry = this.entries.get(id)!;
        if (entry.task.status !== 'queued') continue;
        this.lastConversation = nextConversation;
        this.start(entry);
      }
    } finally { this.pumping = false; }
  }

  async steer(id: string, text: string): Promise<SubagentTask> {
    const entry = this.require(id);
    if (terminal(entry.task) || entry.stopStatus) throw new Error('This helper has stopped; start a follow-up or retry instead.');
    const instruction = bounded(text, 16_000).trim();
    if (!instruction) throw new Error('A steering instruction is required.');
    if (entry.pendingSteers.length >= 8) throw new Error('This helper already has eight pending steering instructions.');
    entry.pendingSteers.push(instruction);
    entry.task.phase = entry.task.status === 'queued' ? 'Queued with an additional instruction' : 'Receiving an additional instruction';
    entry.task.lastActivityAt = this.now();
    this.publish(entry.task, true);
    await this.deliverSteers(entry);
    return clone(entry.task);
  }

  async cancel(id: string): Promise<SubagentTask> {
    const entry = this.require(id);
    this.requestStop(entry, 'cancelled', 'Cancelled');
    await entry.completion;
    return clone(entry.task);
  }

  /** User-only extension: no additional request is sent and thinking is unchanged. */
  extend(id: string): SubagentTask {
    const entry = this.require(id), task = entry.task;
    if (this.closed || task.status !== 'running' || entry.stopStatus || entry.controller?.signal.aborted) throw new Error('Only a running helper can receive more time.');
    if (!Number.isFinite(task.deadlineAt) || !Number.isFinite(task.maxDeadlineAt) || task.startedAt === undefined) throw new Error('This helper has no active task deadline.');
    if (this.now() >= task.deadlineAt!) {
      this.requestStop(entry, 'failed', 'Helper reached its task time limit. Review any staged work before retrying.');
      throw new Error('The helper reached its time limit. Review its partial work or retry.');
    }
    if (task.deadlineAt! >= task.maxDeadlineAt!) throw new Error('This helper has reached its two-hour maximum budget.');
    task.deadlineAt = Math.min(task.maxDeadlineAt!, task.deadlineAt! + SUBAGENT_EXTENSION_MS);
    task.timeBudgetMs = task.deadlineAt - task.startedAt;
    this.armDeadline(entry);
    this.publish(task);
    return clone(task);
  }

  async cancelConversation(conversationId: string): Promise<void> {
    this.stoppingConversations.add(conversationId);
    try {
      const entries = [...this.entries.values()].filter(entry => entry.task.conversationId === conversationId && !terminal(entry.task));
      // Cancel queued entries first so finishing a running helper cannot dispatch
      // another child while this stop operation is awaiting cleanup.
      for (const entry of entries.filter(item => item.task.status === 'queued')) this.requestStop(entry, 'cancelled', 'Cancelled');
      for (const entry of entries.filter(item => item.task.status === 'running')) this.requestStop(entry, 'cancelled', 'Cancelled');
      await Promise.all(entries.map(entry => entry.completion));
    } finally { this.stoppingConversations.delete(conversationId); }
  }

  /** Wait returns on a completion or its bounded deadline, never busy-polls. */
  async wait(ids: string[], timeoutMs = 10_000): Promise<SubagentTask[]> {
    const unique = [...new Set(ids)];
    for (const id of unique) this.require(id);
    const snapshots = () => unique.map(id => this.get(id)!);
    if (!unique.length || unique.some(id => terminal(this.require(id).task))) return snapshots();
    const duration = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(30_000, timeoutMs)) : 10_000;
    if (!duration) return snapshots();
    return new Promise<SubagentTask[]>(resolve => {
      for (const id of unique) this.waitingIds.set(id, (this.waitingIds.get(id) ?? 0) + 1);
      const finish = () => {
        const result = snapshots();
        clearTimeout(timer); this.listeners.delete(check);
        for (const id of unique) {
          const references = (this.waitingIds.get(id) ?? 1) - 1;
          if (references) this.waitingIds.set(id, references); else this.waitingIds.delete(id);
        }
        resolve(result);
      };
      const check = () => { if (unique.some(id => terminal(this.require(id).task))) finish(); };
      const timer = setTimeout(finish, duration);
      this.listeners.add(check);
      check();
    });
  }

  retry(id: string): SubagentTask {
    const previous = this.require(id).task;
    if (!terminal(previous)) throw new Error('Stop the existing helper before retrying it.');
    return this.spawn({
      conversationId: previous.conversationId, title: previous.title, task: previous.task,
      kind: previous.kind, complexity: previous.complexity, ownedFiles: previous.ownedFiles,
    });
  }

  markApplied(id: string): SubagentTask {
    const entry = this.require(id);
    if (entry.task.status !== 'completed' && !(terminal(entry.task) && entry.task.kind === 'implement' && entry.task.partialPatch)) throw new Error('Only a stopped helper with a reviewed patch can have its changes applied.');
    entry.task.applied = true;
    this.publish(entry.task);
    return clone(entry.task);
  }

  setStagingPath(id: string, stagingPath: string): void {
    const entry = this.require(id);
    entry.task.stagingPath = stagingPath;
    this.publish(entry.task);
  }

  /** Called by the host after checkpointing, including during cancellation cleanup. */
  setPartialChanges(id: string, changes: SubagentChange[], error?: string): SubagentTask {
    const entry = this.require(id), task = entry.task;
    if (task.kind !== 'implement' || task.applied || !task.stagingPath) throw new Error('No staged implementation patch is available.');
    if (task.status === 'queued') throw new Error('The helper has not started its patch.');
    task.changes = cleanChanges(changes);
    task.partialPatch = task.changes.length > 0;
    if (error) task.patchError = bounded(error, 2000); else delete task.patchError;
    this.publish(task);
    return clone(task);
  }

  discardPatch(id: string, retainedPathWarning?: string): SubagentTask {
    const entry = this.require(id);
    if (!terminal(entry.task) || entry.task.applied || (entry.task.status !== 'completed' && !(entry.task.kind === 'implement' && entry.task.stagingPath))) throw new Error('Only a stopped unapplied patch can be discarded.');
    entry.task.status = 'cancelled';
    entry.task.phase = retainedPathWarning ? 'Patch retired; staged files retained' : 'Patch discarded';
    if (retainedPathWarning) entry.task.error = bounded(retainedPathWarning, 2000);
    else delete entry.task.stagingPath;
    delete entry.task.partialPatch;
    delete entry.task.changes;
    delete entry.task.patchError;
    entry.task.lastActivityAt = this.now();
    this.publish(entry.task);
    return clone(entry.task);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries.values()];
    for (const entry of entries) this.requestStop(entry, 'cancelled', 'Stopped');
    await Promise.all(entries.map(entry => entry.completion));
    this.persist();
  }

  private require(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Helper not found.');
    return entry;
  }

  private start(entry: Entry): void {
    this.active++;
    entry.controller = new AbortController();
    entry.completion = new Promise<void>(resolve => { entry.finish = resolve; });
    entry.task.status = 'running';
    entry.task.startedAt = entry.task.lastActivityAt = this.now();
    entry.task.timeBudgetMs ??= this.maxTaskMs ?? (entry.task.kind === 'research' && entry.task.complexity === 'routine' ? 20 : 30) * 60_000;
    entry.task.deadlineAt = entry.task.startedAt + entry.task.timeBudgetMs;
    entry.task.maxDeadlineAt = entry.task.startedAt + SUBAGENT_MAX_TASK_MS;
    entry.task.phase = 'Starting helper';
    this.armDeadline(entry);
    this.publish(entry.task);
    // The runner starts on the next microtask, after spawn has returned its id.
    void Promise.resolve().then(() => this.execute(entry));
  }

  private armDeadline(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    const expire = () => {
      if (entry.stopStatus || entry.task.status !== 'running') return;
      // Recheck the wall deadline after waking: an extension or backward clock
      // adjustment must not let an obsolete timer stop useful work.
      const remaining = entry.task.deadlineAt! - this.now();
      if (remaining > 0) { entry.timer = setTimeout(expire, remaining); entry.timer.unref?.(); return; }
      this.requestStop(entry, 'failed', 'Helper reached its task time limit. Review any staged work before retrying.');
    };
    entry.timer = setTimeout(expire, Math.max(1, entry.task.deadlineAt! - this.now()));
    entry.timer.unref?.();
  }

  private async execute(entry: Entry): Promise<void> {
    try {
      if (entry.controller!.signal.aborted) return;
      // A queued sibling may have learned that its automatic model is not
      // supported while this task was waiting. Resolve again immediately before
      // work starts and publish the actual choice before invoking the runner.
      // Resolution failures use the same cleanup as runner failures.
      const model = this.options.resolveModel(clone(entry.task));
      if (!model?.key || !model.label) throw new Error('No model is available for this helper.');
      entry.task.model = clone(model);
      this.publish(entry.task);
      if (entry.controller!.signal.aborted) return;
      const result = await this.options.run(clone(entry.task), {
        abortSignal: entry.controller!.signal,
        update: phase => {
          if (entry.stopStatus || entry.task.status !== 'running') return;
          entry.task.phase = bounded(phase, 240);
          entry.task.lastActivityAt = this.now();
          this.publish(entry.task, true);
        },
        setSteer: handler => {
          if (entry.stopStatus || entry.task.status !== 'running') return;
          entry.steer = handler;
          void this.deliverSteers(entry).catch(error => {
            if (entry.stopStatus || entry.task.status !== 'running') return;
            entry.task.phase = `Could not deliver instruction: ${bounded(error instanceof Error ? error.message : error, 160)}`;
            entry.task.lastActivityAt = this.now();
            this.publish(entry.task, true);
          });
        },
      });
      if (!entry.stopStatus) {
        entry.task.status = 'completed';
        entry.task.phase = 'Completed';
        entry.task.summary = bounded(result.summary, 12_000);
        if (result.changes) entry.task.changes = cleanChanges(result.changes);
        delete entry.task.partialPatch;
        delete entry.task.patchError;
        if (result.usage) entry.task.usage = { input: count(result.usage.input), output: count(result.usage.output) };
      }
    } catch (error) {
      if (!entry.stopStatus) {
        entry.task.status = 'failed';
        entry.task.phase = 'Failed';
        entry.task.error = bounded(error instanceof Error ? error.message : error, 2000);
      }
    } finally {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.stopStatus) {
        entry.task.status = entry.stopStatus;
        entry.task.phase = entry.stopStatus === 'cancelled' ? 'Cancelled' : 'Failed';
        if (entry.stopStatus === 'failed') entry.task.error = entry.stopReason;
      }
      entry.steer = undefined;
      entry.pendingSteers.length = 0;
      entry.task.endedAt = entry.task.lastActivityAt = this.now();
      this.active--;
      this.publish(entry.task);
      entry.finish?.();
      this.refreshLimits();
    }
  }

  private async deliverSteers(entry: Entry): Promise<void> {
    if (!entry.steer || entry.stopStatus || entry.task.status !== 'running') return;
    if (entry.steering) return entry.steering;
    const delivery = async () => {
      while (entry.pendingSteers.length && entry.steer && !entry.stopStatus && entry.task.status === 'running') {
        await entry.steer(entry.pendingSteers.shift()!);
      }
    };
    entry.steering = delivery();
    try { await entry.steering; } finally { entry.steering = undefined; }
  }

  private requestStop(entry: Entry, status: 'cancelled' | 'failed', reason: string): void {
    if (terminal(entry.task) || entry.stopStatus) return;
    entry.stopStatus = status;
    entry.stopReason = reason;
    entry.task.stopReason = status === 'cancelled' ? 'cancelled' : 'time_limit';
    entry.pendingSteers.length = 0;
    if (entry.task.status === 'queued') {
      const index = this.queue.indexOf(entry.task.id);
      if (index >= 0) this.queue.splice(index, 1);
      entry.task.status = status;
      entry.task.phase = 'Cancelled';
      entry.task.endedAt = entry.task.lastActivityAt = this.now();
    } else {
      entry.task.phase = status === 'failed' ? 'Time limit reached; stopping helper' : 'Stopping helper';
      entry.task.lastActivityAt = this.now();
      entry.controller?.abort(new Error(reason));
    }
    this.publish(entry.task);
  }

  private publish(task: SubagentTask, activityOnly = false): void {
    if (activityOnly) {
      if (this.options.persistencePath && !this.historyTimer) {
        this.historyTimer = setTimeout(() => { this.historyTimer = undefined; this.persist(); }, 2000);
        this.historyTimer.unref?.();
      }
    } else {
      this.pruneHistory();
      this.persist();
    }
    try { this.options.onChange?.(clone(task)); } catch { /* UI listeners must not interrupt cleanup. */ }
    for (const listener of [...this.listeners]) listener();
  }

  private persist(): void {
    if (this.historyTimer) { clearTimeout(this.historyTimer); this.historyTimer = undefined; }
    const file = this.options.persistencePath;
    if (!file) return;
    const temporary = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const saved = [...this.entries.values()].map(entry => entry.task);
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, tasks: saved }), 'utf8');
      fs.renameSync(temporary, file);
      this.persistenceError = undefined;
    } catch (error) {
      this.persistenceError = bounded(error instanceof Error ? error.message : error, 2000);
      try { fs.unlinkSync(temporary); } catch { /* No temporary history to remove. */ }
    }
  }

  private pruneHistory(): void {
    const disposable = [...this.entries.values()].filter(({ task }) => terminal(task)
      && !(task.kind === 'implement' && !task.applied && (task.status === 'completed' || task.stagingPath)));
    let excess = Math.max(0, disposable.length - 100);
    for (const entry of disposable) {
      if (!excess) break;
      if (this.waitingIds.has(entry.task.id)) continue;
      this.entries.delete(entry.task.id); excess--;
    }
  }

  private restore(): void {
    const file = this.options.persistencePath;
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.tasks)) throw new Error('Unsupported helper history.');
      for (const raw of saved.tasks) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.conversationId !== 'string'
          || typeof raw.task !== 'string' || !raw.model?.key
          || !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(raw.status)
          || !['research', 'implement', 'review'].includes(raw.kind)
          || !['routine', 'complex'].includes(raw.complexity)) continue;
        const task: SubagentTask = clone(raw);
        task.title = bounded(task.title, 160);
        task.task = bounded(task.task, 64_000);
        task.phase = bounded(task.phase, 240);
        if (task.summary !== undefined) task.summary = bounded(task.summary, 12_000);
        if (task.error !== undefined) task.error = bounded(task.error, 2000);
        if (!terminal(task)) {
          task.status = 'interrupted';
          task.phase = 'Interrupted when Atlas stopped';
          task.error = 'Atlas stopped before this helper finished. Retry explicitly to continue.';
          task.endedAt = task.lastActivityAt = this.now();
        }
        this.entries.set(task.id, { task, pendingSteers: [] });
      }
      this.pruneHistory();
      this.persist();
    } catch (error) { this.persistenceError = bounded(error instanceof Error ? error.message : error, 2000); }
  }
}
