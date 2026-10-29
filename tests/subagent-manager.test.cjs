const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

const moduleUnderTest = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/atlas/subagent-manager.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
  console, Buffer, process, setTimeout, clearTimeout, AbortController, Error,
})(require, moduleUnderTest, moduleUnderTest.exports);
const { SubagentManager, chooseEfficientModel } = moduleUnderTest.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const choice = { key: 'provider/parent', label: 'Parent', thinkingLevel: 'max', routingReason: 'Fixture' };
const input = (conversationId = 'chat-a', title = 'Inspect') => ({ conversationId, title, task: 'Inspect this bounded task', kind: 'research', complexity: 'routine' });

function controlled(options = {}) {
  const calls = [], events = [];
  let active = 0, peak = 0;
  const manager = new SubagentManager({
    maxHelpers: () => 4, resolveModel: () => choice,
    onChange: task => events.push(task),
    run: async (task, context) => {
      const gate = deferred();
      const call = { task, context, gate };
      calls.push(call);
      active++; peak = Math.max(peak, active);
      if (options.autoAbort !== false) context.abortSignal.addEventListener('abort', () => gate.resolve({ summary: 'Aborted' }), { once: true });
      try { return await gate.promise; } finally { active--; }
    },
    ...options,
  });
  return { manager, calls, events, active: () => active, peak: () => peak };
}

test('defaults to four running helpers and drains a bounded global pool', async t => {
  const h = controlled(); t.after(() => h.manager.dispose());
  const tasks = Array.from({ length: 7 }, (_, i) => h.manager.spawn(input('chat-a', String(i))));
  await tick();
  assert.equal(h.calls.length, 4);
  assert.equal(h.manager.list().filter(task => task.status === 'queued').length, 3);
  assert.equal(h.manager.isBusy('chat-a'), true);
  assert.equal(h.manager.isBusy('other'), false);
  h.calls[0].gate.resolve({ summary: 'First finished' });
  await tick();
  assert.equal(h.calls.length, 5);
  assert.equal(h.peak(), 4);
  assert.equal(h.manager.get(tasks[0].id).summary, 'First finished');
  assert.equal(h.manager.get(tasks[0].id).status, 'completed');
  await h.manager.cancelConversation('chat-a');
  assert.equal(h.manager.isBusy(), false);
});

test('raising concurrency dispatches pending work and the absolute ceiling is eight', async t => {
  let limit = 4;
  const h = controlled({ maxHelpers: () => limit }); t.after(() => h.manager.dispose());
  Array.from({ length: 12 }, () => h.manager.spawn(input()));
  await tick(); assert.equal(h.calls.length, 4);
  limit = 999; h.manager.refreshLimits();
  await tick(); assert.equal(h.calls.length, 8); assert.equal(h.peak(), 8);
  limit = 2; h.manager.refreshLimits();
  assert.equal(h.calls.filter(call => call.context.abortSignal.aborted).length, 0);
  for (const call of h.calls.slice(0, 6)) call.gate.resolve({ summary: 'Done' });
  await tick(); assert.equal(h.calls.length, 8);
  h.calls[6].gate.resolve({ summary: 'Done' });
  await tick(); assert.equal(h.calls.length, 9);
});

test('queued conversations take turns and preserve their own FIFO order', async t => {
  const h = controlled({ maxHelpers: () => 1 }); t.after(() => h.manager.dispose());
  for (const [chat, title] of [['a', 'a1'], ['a', 'a2'], ['a', 'a3'], ['b', 'b1'], ['b', 'b2']]) h.manager.spawn(input(chat, title));
  await tick();
  for (let index = 0; index < 5; index++) {
    h.calls[index].gate.resolve({ summary: 'Done' });
    await tick();
  }
  assert.deepEqual(h.calls.map(call => call.task.title), ['a1', 'b1', 'a2', 'b2', 'a3']);
});

test('queued cancellation never starts a runner and cannot be undone by later events', async t => {
  const h = controlled({ maxHelpers: () => 1 }); t.after(() => h.manager.dispose());
  h.manager.spawn(input());
  const queued = h.manager.spawn(input('chat-a', 'Queued'));
  await tick();
  const cancelled = await h.manager.cancel(queued.id);
  assert.equal(cancelled.status, 'cancelled');
  h.calls[0].gate.resolve({ summary: 'Done' });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.manager.get(queued.id).status, 'cancelled');
});

test('cancel waits for actual runner cleanup and ignores late activity and results', async t => {
  const h = controlled({ maxHelpers: () => 1, autoAbort: false }); t.after(() => h.manager.dispose());
  const first = h.manager.spawn(input());
  h.manager.spawn(input('other'));
  await tick();
  let stopped = false;
  const stopping = h.manager.cancel(first.id).then(() => { stopped = true; });
  h.calls[0].context.update('This stale update must not replace Stopping');
  await tick();
  assert.equal(stopped, false);
  assert.equal(h.manager.get(first.id).phase, 'Stopping helper');
  assert.equal(h.manager.get(first.id).status, 'running');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].context.abortSignal.aborted, true);
  h.calls[0].gate.resolve({ summary: 'A late success must not win' });
  await stopping; await tick();
  assert.equal(h.manager.get(first.id).status, 'cancelled');
  assert.equal(h.manager.get(first.id).summary, undefined);
  assert.equal(h.calls.length, 2);
  h.calls[0].context.update('Also stale after finish');
  assert.equal(h.manager.get(first.id).phase, 'Cancelled');
  h.calls[1].gate.resolve({ summary: 'Done' });
});

test('stop-all cancels the whole parent queue and waits for each live child', async t => {
  const h = controlled({ maxHelpers: () => 2, autoAbort: false }); t.after(() => h.manager.dispose());
  for (let i = 0; i < 5; i++) h.manager.spawn(input());
  await tick();
  let done = false;
  const stopping = h.manager.cancelConversation('chat-a').then(() => { done = true; });
  assert.throws(() => h.manager.spawn(input()), /stopping/);
  assert.equal(h.manager.list().filter(task => task.status === 'cancelled').length, 3);
  assert.equal(h.calls.every(call => call.context.abortSignal.aborted), true);
  h.calls[0].gate.resolve({ summary: 'Stopped 1' });
  await tick(); assert.equal(done, false); assert.equal(h.calls.length, 2);
  h.calls[1].gate.resolve({ summary: 'Stopped 2' });
  await stopping;
  assert.equal(h.manager.list().every(task => task.status === 'cancelled'), true);
  assert.equal(h.active(), 0);
});

test('a task timeout aborts work, waits for cleanup, records failure, and frees its slot', async t => {
  const h = controlled({ maxHelpers: () => 1, maxTaskMs: 15 }); t.after(() => h.manager.dispose());
  const first = h.manager.spawn(input());
  h.manager.spawn(input('next'));
  const result = await h.manager.wait([first.id], 200);
  assert.equal(result[0].status, 'failed');
  assert.match(result[0].error, /time limit/);
  assert.equal(result[0].stopReason, 'time_limit');
  assert.equal(h.calls[0].context.abortSignal.aborted, true);
  await tick(); assert.equal(h.calls.length, 2);
  h.calls[1].gate.resolve({ summary: 'Done' });
});

test('routine research gets twenty minutes and substantial tasks get thirty without changing thinking', async t => {
  let now = 1000;
  const h = controlled({ now: () => now, maxHelpers: () => 1 }); t.after(() => h.manager.dispose());
  const research = h.manager.spawn(input());
  const implementation = h.manager.spawn({ ...input(), kind: 'implement', ownedFiles: ['Source/One.cs'] });
  const review = h.manager.spawn({ ...input(), kind: 'review' });
  const complex = h.manager.spawn({ ...input(), complexity: 'complex' });
  assert.equal(research.timeBudgetMs, 20 * 60_000);
  assert.equal(research.deadlineAt, 1000 + 20 * 60_000);
  assert.equal(research.maxDeadlineAt, 1000 + 120 * 60_000);
  for (const queued of [implementation, review, complex]) {
    assert.equal(queued.timeBudgetMs, 30 * 60_000);
    assert.equal(queued.deadlineAt, undefined, 'time queued must not consume the task budget');
    assert.equal(queued.model.thinkingLevel, 'max');
    assert.throws(() => h.manager.extend(queued.id), /running/);
  }
  await tick(); now = 250_000;
  h.calls[0].gate.resolve({ summary: 'Finished research' }); await tick();
  const started = h.manager.get(implementation.id);
  assert.equal(started.startedAt, now);
  assert.equal(started.deadlineAt, now + 30 * 60_000);
  assert.equal(h.calls[1].task.model.thinkingLevel, 'max');
});

test('Extend resets the old timer, adds fifteen minutes and never starts another request', async t => {
  const h = controlled({ maxTaskMs: 30 }); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input()); await tick();
  const original = h.manager.get(task.id), extended = h.manager.extend(task.id);
  assert.equal(extended.deadlineAt, original.deadlineAt + 15 * 60_000);
  assert.equal(extended.timeBudgetMs, 30 + 15 * 60_000);
  assert.equal(extended.model.thinkingLevel, 'max');
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(h.manager.get(task.id).status, 'running');
  assert.equal(h.calls[0].context.abortSignal.aborted, false);
  assert.equal(h.calls.length, 1);
  h.calls[0].gate.resolve({ summary: 'Finished after the old deadline' }); await tick();
  assert.equal(h.manager.get(task.id).status, 'completed');
  assert.throws(() => h.manager.extend(task.id), /running/);
});

test('extensions stop at two hours and cannot revive a stopping or expired helper', async t => {
  let now = 1000;
  const h = controlled({ now: () => now, autoAbort: false }); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input()); await tick();
  for (let i = 0; i < 7; i++) h.manager.extend(task.id);
  const capped = h.manager.get(task.id);
  assert.equal(capped.timeBudgetMs, 120 * 60_000);
  assert.equal(capped.deadlineAt, capped.maxDeadlineAt);
  assert.throws(() => h.manager.extend(task.id), /two-hour maximum/);
  now = capped.deadlineAt;
  assert.throws(() => h.manager.extend(task.id), /reached its time limit/);
  assert.equal(h.calls[0].context.abortSignal.aborted, true);
  assert.equal(h.manager.get(task.id).stopReason, 'time_limit');
  assert.throws(() => h.manager.extend(task.id), /running/);
  h.calls[0].gate.resolve({ summary: 'Late result' }); await tick();
  assert.equal(h.manager.get(task.id).status, 'failed');
  assert.equal(h.manager.get(task.id).summary, undefined);
});

test('manual cancellation prevents extension while cleanup still occupies the slot', async t => {
  const h = controlled({ autoAbort: false }); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input()); await tick();
  const stopping = h.manager.cancel(task.id);
  assert.equal(h.manager.get(task.id).stopReason, 'cancelled');
  assert.throws(() => h.manager.extend(task.id), /running/);
  h.calls[0].gate.resolve({ summary: 'Stopped' }); await stopping;
  assert.equal(h.manager.get(task.id).status, 'cancelled');
});

test('timed-out implementation checkpoint retains partial work and original error through recovery', async t => {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'subagent-partial-')), history = path.join(directory, 'history.json');
  const changes = [{ path: 'Source/One.cs', kind: 'modified', beforeHash: 'before', afterHash: 'after', bytes: 50 }];
  let manager;
  manager = new SubagentManager({ maxHelpers: () => 1, resolveModel: () => choice, maxTaskMs: 20, persistencePath: history,
    run: (task, context) => new Promise((resolve, reject) => {
      manager.setStagingPath(task.id, path.join(directory, 'staging'));
      context.abortSignal.addEventListener('abort', () => {
        manager.setPartialChanges(task.id, changes);
        reject(new Error('Provider abort must not hide the task timeout'));
      }, { once: true });
    }),
  });
  t.after(async () => { await manager.dispose(); assert(directory.startsWith(base + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const task = manager.spawn({ ...input(), kind: 'implement', ownedFiles: ['Source/One.cs'] });
  const [failed] = await manager.wait([task.id], 200);
  assert.equal(failed.status, 'failed'); assert.equal(failed.partialPatch, true);
  assert.deepEqual(plain(failed.changes), changes); assert.match(failed.error, /task time limit/);
  let requests = 0;
  const reopened = new SubagentManager({ maxHelpers: () => 1, resolveModel: () => choice, persistencePath: history,
    run: async () => { requests++; return { summary: 'Must not restart' }; } });
  t.after(() => reopened.dispose());
  assert.equal(reopened.get(task.id).status, 'failed'); assert.equal(reopened.get(task.id).partialPatch, true);
  assert.equal(reopened.get(task.id).error, failed.error); assert.equal(requests, 0);
  const applied = reopened.markApplied(task.id);
  assert.equal(applied.applied, true); assert.equal(applied.status, 'failed', 'applying a partial patch must not claim the task completed');
  await reopened.dispose();
});

test('partial checkpoint errors stay separate from failure and incomplete patches can be retired', async t => {
  const h = controlled(); t.after(() => h.manager.dispose());
  const task = h.manager.spawn({ ...input(), kind: 'implement', ownedFiles: ['Source/One.cs'] }); await tick();
  h.manager.setStagingPath(task.id, 'C:/fixture/partial');
  h.manager.setPartialChanges(task.id, [], 'Source changed; staging retained.');
  assert.throws(() => h.manager.markApplied(task.id), /stopped helper/);
  h.calls[0].gate.reject(new Error('Connection interrupted')); await tick();
  const failed = h.manager.get(task.id);
  assert.equal(failed.partialPatch, false); assert.equal(failed.error, 'Connection interrupted');
  assert.equal(failed.patchError, 'Source changed; staging retained.');
  assert.throws(() => h.manager.markApplied(task.id), /stopped helper/);
  const retired = h.manager.discardPatch(task.id, 'Recovery files retained.');
  assert.equal(retired.status, 'cancelled'); assert.equal(retired.stagingPath, 'C:/fixture/partial');
  assert.equal(retired.partialPatch, undefined); assert.equal(retired.changes, undefined); assert.equal(retired.patchError, undefined);
  assert.equal(retired.phase, 'Patch retired; staged files retained');
});

test('failed tasks do not retry automatically; explicit retry has a fresh id and route', async t => {
  let routes = 0;
  const h = controlled({ resolveModel: () => ({ ...choice, label: `Route ${++routes}` }) }); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input());
  await tick(); h.calls[0].gate.reject(new Error('Provider unavailable'));
  await tick();
  assert.equal(h.manager.get(task.id).status, 'failed');
  assert.equal(h.manager.get(task.id).error, 'Provider unavailable');
  assert.equal(h.calls.length, 1);
  const retry = h.manager.retry(task.id);
  assert.notEqual(retry.id, task.id); assert.equal(retry.model.label, 'Route 3');
  await tick(); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].task.model.label, 'Route 4');
});

test('queued helpers re-resolve after a sibling rejects an automatic model', async t => {
  const rejected = new Set();
  const h = controlled({ maxHelpers: () => 1, resolveModel: () => chooseEfficientModel(routing({ excludedModelKeys: rejected })) });
  t.after(() => h.manager.dispose());
  const first = h.manager.spawn(input()), queued = h.manager.spawn(input());
  assert.equal(queued.model.key, luna.key);
  await tick();
  rejected.add(luna.key);
  h.calls[0].gate.reject(new Error("The 'gpt-6-luna' model is not supported for this account."));
  await tick();
  assert.equal(h.manager.get(first.id).status, 'failed');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].task.model.key, parent.key);
  assert.equal(h.calls[1].task.model.thinkingLevel, 'max');
  assert.equal(h.manager.get(queued.id).model.key, parent.key);
});

test('a dispatch-time model resolution failure frees its slot without invoking the runner', async t => {
  let unavailable = false;
  const h = controlled({ maxHelpers: () => 1, resolveModel: task => {
    if (unavailable && task.title === 'Unavailable') throw new Error('Account is no longer connected.');
    return choice;
  } });
  t.after(() => h.manager.dispose());
  h.manager.spawn(input('chat-a', 'First'));
  const failing = h.manager.spawn(input('chat-a', 'Unavailable'));
  const next = h.manager.spawn(input('chat-a', 'Next'));
  await tick(); unavailable = true;
  h.calls[0].gate.resolve({ summary: 'Finished' }); await tick();
  assert.equal(h.manager.get(failing.id).status, 'failed');
  assert.equal(h.manager.get(failing.id).error, 'Account is no longer connected.');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].task.id, next.id);
  h.calls[1].gate.resolve({ summary: 'Finished next' }); await tick();
  assert.equal(h.manager.isBusy(), false);
});

test('steering survives the queue and is delivered in order to only its intended runner', async t => {
  const h = controlled({ maxHelpers: () => 1 }); t.after(() => h.manager.dispose());
  h.manager.spawn(input());
  const queued = h.manager.spawn(input('next'));
  await h.manager.steer(queued.id, 'Inspect one');
  await h.manager.steer(queued.id, 'Inspect two');
  await tick(); h.calls[0].gate.resolve({ summary: 'Done' }); await tick();
  const delivered = [];
  h.calls[1].context.setSteer(async text => { delivered.push(text); });
  await tick();
  await h.manager.steer(queued.id, 'Inspect three');
  assert.deepEqual(delivered, ['Inspect one', 'Inspect two', 'Inspect three']);
  h.calls[1].gate.resolve({ summary: 'Done' }); await tick();
  await assert.rejects(h.manager.steer(queued.id, 'Too late'), /stopped/);
});

test('wait is bounded, wakes on completion, and only observes its selected tasks', async t => {
  const h = controlled(); t.after(() => h.manager.dispose());
  const first = h.manager.spawn(input()), second = h.manager.spawn(input('other'));
  const started = Date.now();
  assert.equal((await h.manager.wait([first.id], 15))[0].status, 'running');
  assert(Date.now() - started < 200);
  const waiting = h.manager.wait([second.id], 1000);
  h.calls[1].gate.resolve({ summary: 'Specific helper completed' });
  assert.equal((await waiting)[0].status, 'completed');
  assert.equal(h.manager.get(first.id).status, 'running');
  assert.equal((await h.manager.wait([first.id], -1))[0].status, 'running');
  await assert.rejects(h.manager.wait(['missing']), /not found/);
});

test('returned state is detached and output is bounded with control sequences removed', async t => {
  const h = controlled(); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input()); task.model.label = 'Tampered'; task.task = 'Tampered';
  await tick(); assert.equal(h.calls[0].task.task, input().task);
  h.calls[0].context.update('Working\0\u001b[31m now');
  assert.equal(h.manager.get(task.id).phase, 'Working now');
  h.calls[0].gate.resolve({ summary: '\u001b[31m' + 'a'.repeat(20_000), usage: { input: -2, output: Infinity } });
  await tick();
  const saved = h.manager.get(task.id);
  assert.equal(saved.summary.length, 12_000);
  assert.deepEqual(plain(saved.usage), { input: 0, output: 0 });
  assert.equal(saved.model.label, 'Parent');
  assert.equal(h.manager.markApplied(task.id).applied, true);
});

test('history survives reopen and unfinished helpers become interrupted without retry', async t => {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'subagents-'));
  const history = path.join(directory, 'history.json');
  t.after(() => { assert(directory.startsWith(base + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const h = controlled({ maxHelpers: () => 1, persistencePath: history });
  const complete = h.manager.spawn(input()); await tick();
  h.calls[0].gate.resolve({ summary: 'Remembered summary', changes: [{ path: 'Defs/One.xml', kind: 'added', beforeHash: null, afterHash: 'hash', bytes: 2 }] });
  await tick(); h.manager.markApplied(complete.id);
  const running = h.manager.spawn({ ...input(), ownedFiles: ['Source/One.cs'] });
  const queued = h.manager.spawn(input('other'));
  await tick();
  let runs = 0;
  const reopened = new SubagentManager({ maxHelpers: () => 4, resolveModel: () => choice, run: async () => { runs++; return { summary: 'Unexpected' }; }, persistencePath: history });
  assert.equal(reopened.get(complete.id).summary, 'Remembered summary');
  assert.equal(reopened.get(complete.id).applied, true);
  assert.equal(reopened.get(running.id).status, 'interrupted');
  assert.equal(reopened.get(queued.id).status, 'interrupted');
  assert.deepEqual(plain(reopened.get(running.id).ownedFiles), ['Source/One.cs']);
  assert.equal(reopened.isBusy(), false); assert.equal(runs, 0);
  await reopened.dispose(); await h.manager.dispose();
});

test('listener or history failures do not leave a live slot or mask a runner result', async t => {
  const h = controlled({ onChange: () => { throw new Error('Detached window'); } }); t.after(() => h.manager.dispose());
  const task = h.manager.spawn(input()); await tick();
  h.calls[0].gate.resolve({ summary: 'Done anyway' }); await tick();
  assert.equal(h.manager.get(task.id).status, 'completed'); assert.equal(h.manager.isBusy(), false);
});

const parent = { key: 'openai-codex/gpt-6.1-sol', provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol', thinkingLevel: 'max', reasoning: true, vision: true };
const luna = { ...parent, key: 'openai-codex/gpt-6-luna', id: 'gpt-6-luna', name: 'GPT 6 Luna', thinkingLevel: 'high', supportedThinkingLevels: ['off', 'low', 'medium', 'high'] };
const routing = extra => ({ parent, available: [parent, luna], mode: 'efficient', kind: 'research', complexity: 'routine', ...extra });

test('efficient routine research uses an available lighter sibling and medium effort without changing parent', () => {
  const before = JSON.stringify(parent);
  const selected = chooseEfficientModel(routing());
  assert.equal(selected.key, luna.key); assert.equal(selected.thinkingLevel, 'medium');
  assert.match(selected.routingReason, /Routine research/);
  assert.equal(JSON.stringify(parent), before); assert.equal(parent.thinkingLevel, 'max');
});

test('implementation, review, complex research, and match mode preserve exact parent thinking', () => {
  for (const extra of [{ kind: 'implement' }, { kind: 'review' }, { complexity: 'complex' }, { mode: 'match' }]) {
    const selected = chooseEfficientModel(routing(extra));
    assert.equal(selected.key, parent.key); assert.equal(selected.thinkingLevel, 'max');
  }
});

test('routing never crosses providers or invents an unavailable model', () => {
  for (const available of [[], [{ ...luna, provider: 'openai', key: 'openai/gpt-6-luna' }], [{ ...luna, id: 'unknown-economy', name: 'Economy' }]]) {
    const selected = chooseEfficientModel(routing({ available }));
    assert.equal(selected.key, parent.key); assert.equal(selected.thinkingLevel, 'max');
    assert.match(selected.routingReason, /No compatible lighter model/);
  }
});

test('efficient ChatGPT routing excludes the rejected GPT-5.4 mini catalog entry and retains exact main thinking when necessary', () => {
  const mini = { ...parent, id: 'gpt-5.4-mini', key: 'openai-codex/gpt-5.4-mini', name: 'GPT-5.4 mini' };
  for (const id of ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17']) {
    const entry = { ...mini, id, key: `openai-codex/${id}` };
    const fallback = chooseEfficientModel(routing({ available: [entry] }));
    assert.equal(fallback.key, parent.key); assert.equal(fallback.thinkingLevel, 'max');
    const alternative = chooseEfficientModel(routing({ available: [entry, luna] }));
    assert.equal(alternative.key, luna.key);
  }
  const apiParent = { ...parent, provider: 'openai', key: 'openai/gpt-6.1-sol' };
  const apiMini = { ...mini, provider: 'openai', key: 'openai/gpt-5.4-mini' };
  assert.equal(chooseEfficientModel(routing({ parent: apiParent, available: [apiMini] })).key, apiMini.key);
});

test('explicit model rejections remove automatic choices without changing manual parent selections', () => {
  const rejected = new Set([luna.key, parent.key]);
  const selected = chooseEfficientModel(routing({ excludedModelKeys: rejected }));
  assert.equal(selected.key, parent.key); assert.equal(selected.thinkingLevel, 'max');
  assert.equal(chooseEfficientModel(routing({ parent: luna, excludedModelKeys: rejected })).key, luna.key);
  assert.equal(rejected.size, 2);
});

test('routine text research can use a nonreasoning model and economical parents never upgrade', () => {
  const simple = {...luna, reasoning:false, vision:false};
  assert.equal(chooseEfficientModel(routing({available:[simple]})).thinkingLevel, 'off');
  assert.equal(chooseEfficientModel(routing({available:[simple], requiresVision:true})).key, parent.key);
  const retained = chooseEfficientModel(routing({parent:luna, available:[{...parent,id:'gpt-future-mini',name:'Future Mini'}]}));
  assert.equal(retained.key,luna.key); assert.equal(retained.thinkingLevel,luna.thinkingLevel);
});

test('the global delegation queue rejects its 65th pending task before allocating a runner', async t => {
  const h=controlled({maxHelpers:()=>1}); t.after(()=>h.manager.dispose());
  for(let i=0;i<64;i++)h.manager.spawn(input());
  assert.throws(()=>h.manager.spawn(input()),/64 active or queued/);
  assert.equal(h.manager.list().length,64);
  await tick(); assert.equal(h.calls.length,1);
});

test('history keeps 100 disposable tasks while preserving unapplied patch metadata', async t => {
  const manager=new SubagentManager({maxHelpers:()=>4,resolveModel:()=>choice,run:async()=>({summary:'Done'})});
  t.after(()=>manager.dispose());
  const patch=manager.spawn({...input(),kind:'implement',ownedFiles:['Source/One.cs']});
  manager.setStagingPath(patch.id,'C:/fixture/staging');
  await manager.wait([patch.id],100);
  for(let i=0;i<110;i++){const task=manager.spawn(input());await manager.wait([task.id],100);}
  assert.equal(manager.list().length,101);
  assert.equal(manager.get(patch.id).stagingPath,'C:/fixture/staging');
  const discarded=manager.discardPatch(patch.id);
  assert.equal(discarded.status,'cancelled');assert.equal(discarded.phase,'Patch discarded');
  assert.equal(discarded.stagingPath,undefined);
  assert.equal(manager.list().length,100);
});

test('activity changes debounce history writes and final completion flushes immediately', async t => {
  const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
  const directory=fs.mkdtempSync(path.join(base,'subagent-write-rate-')),history=path.join(directory,'state.json');
  const h=controlled({persistencePath:history});
  t.after(async()=>{await h.manager.dispose();assert(directory.startsWith(base+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
  const task=h.manager.spawn(input());await tick();
  const initial=fs.readFileSync(history,'utf8');
  for(let i=0;i<50;i++)h.calls[0].context.update('Activity '+i);
  assert.equal(fs.readFileSync(history,'utf8'),initial);
  assert.equal(h.manager.get(task.id).phase,'Activity 49');
  h.calls[0].gate.resolve({summary:'Finished'});await tick();
  assert.equal(JSON.parse(fs.readFileSync(history,'utf8')).tasks[0].summary,'Finished');
});

test('retiring an unsafe patch retains its recovery location and warning', async t => {
  const manager=new SubagentManager({maxHelpers:()=>4,resolveModel:()=>choice,run:async()=>({summary:'Done'})});
  t.after(()=>manager.dispose());
  const patch=manager.spawn({...input(),kind:'implement',ownedFiles:['Source/One.cs']});
  manager.setStagingPath(patch.id,'C:/fixture/recovery');await manager.wait([patch.id],100);
  const retired=manager.discardPatch(patch.id,'Recovery data retained because the source changed.');
  assert.equal(retired.status,'cancelled');assert.equal(retired.phase,'Patch retired; staged files retained');
  assert.equal(retired.stagingPath,'C:/fixture/recovery');assert.match(retired.error,/Recovery data retained/);
  assert.equal(retired.applied,undefined);
});

test('Haiku routing stays on Claude and only requests a supported lower effort', () => {
  const claude = { ...parent, key: 'anthropic/claude-opus', provider: 'anthropic', id: 'claude-opus', name: 'Opus' };
  const haiku = { ...claude, key: 'anthropic/claude-haiku', id: 'claude-haiku', name: 'Haiku', supportedThinkingLevels: ['low', 'high'] };
  const selected = chooseEfficientModel(routing({ parent: claude, available: [luna, haiku] }));
  assert.equal(selected.key, haiku.key); assert.equal(selected.thinkingLevel, 'low');
  assert.equal(claude.thinkingLevel, 'max');
});
