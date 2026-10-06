'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

const readSource = file => fs.readFileSync(path.resolve(__dirname, '../src/atlas', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
};
const flush = async () => {for (let i = 0; i < 8; i++) await Promise.resolve();};
const model = {provider: 'openai-codex', modelId: 'gpt-6.1-sol'};
const now = 1900000000000;
const limits = {
  rate_limit: {
    primary_window: {used_percent: 25, limit_window_seconds: 18000, reset_at: now / 1000 + 3600},
    secondary_window: {used_percent: 100, limit_window_seconds: 604800, reset_at: now / 1000 + 86400},
  },
};

// The actual backend is compiled with only host/provider boundaries mocked.
// Synthetic JWTs contain fixture account IDs; no real sign-in or network is used.
function backend() {
  const clock = {now}, calls = [];
  class FixtureDate extends Date {static now() {return clock.now;}}
  let fetchResponse = async () => ({ok: true, json: async () => ({credits: {balance: 20}})});
  const context = vm.createContext({
    console, process, Buffer, Date: FixtureDate, setTimeout, clearTimeout, AbortController, AbortSignal,
    fetch: async (url, options) => {calls.push({url, options}); return fetchResponse(url, options);},
  });
  function load(file) {
    const module = {exports: {}};
    const output = ts.transpileModule(readSource(file), {
      compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
      fileName: file,
    }).outputText;
    const localRequire = id => {
      if (id.startsWith('node:')) return require(id);
      if (id === './account-label') return load('account-label.ts');
      if (id === 'electron') return {BrowserWindow: {getAllWindows: () => []}};
      if (['@earendil-works/pi-coding-agent', '../agent/settings', '../agent/conversations', '../lib/thinking-levels', '../agent/agent-host'].includes(id)) return {};
      throw new Error('Unexpected usage fixture dependency: ' + id);
    };
    const fixtureExports = file === 'agent-features.ts'
      ? '\nmodule.exports.parseUsage = felixParseUsage; felixCloseOpenAIConnections = async () => {};'
      : '';
    vm.runInContext('(function(require,module,exports){' + output + fixtureExports + '\n})', context, {filename: file})(localRequire, module, module.exports);
    return module.exports;
  }
  const api = load('agent-features.ts');
  const jwt = id => 'fixture.' + Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: id}})).toString('base64url') + '.signature';
  let accountId = 'account-1';
  const host = {
    sessions: new Map(), emitOAuth() {},
    credentials: {
      openAIAccounts: () => ({activeId: accountId, accounts: [{id: 'account-1'}, {id: 'account-2'}]}),
      selectOpenAIAccount: async id => {accountId = id;},
    },
    modelRuntime: {getAuth: async () => ({auth: {apiKey: jwt(accountId)}}), refresh: async () => {}},
  };
  return {api, host, clock, calls, jwt, respond: callback => {fetchResponse = callback;}};
}

test('usage parser retains credits alongside both plan windows, including numeric and string zero', () => {
  const {api} = backend();
  for (const balance of [1250.5, '1250.5', 0, '0', ' 0 ']) {
    const usage = api.parseUsage({...limits, credits: {balance}}, now);
    assert.equal(usage.status, 'ready');
    assert.equal(usage.credits.balance, Number(balance));
    assert.equal(usage.credits.unlimited, false);
    assert.equal(usage.buckets[0].primary.usedPercent, 25);
    assert.equal(usage.buckets[0].secondary.windowMinutes, 10080);
  }
});

test('unlimited credits are explicit; missing and invalid balances never become zero', () => {
  const {api} = backend();
  assert.deepEqual(plain(api.parseUsage({credits: {unlimited: true}}, now).credits), {unlimited: true, balance: null});
  for (const balance of [undefined, null, '', ' ', 'unknown', '-1', -1, NaN, Infinity, 'Infinity', true, {}]) {
    const usage = api.parseUsage({credits: {balance}}, now);
    assert.equal(usage.credits, null, 'invalid balance ' + String(balance));
    assert.equal(usage.status, 'unavailable');
  }
  assert.equal(api.parseUsage({}, now).credits, null);
});

test('usage parsing clamps percentages and preserves distinct model windows and reset times', () => {
  const {api} = backend();
  const usage = api.parseUsage({
    rate_limit: {primary_window: {used_percent: -30, limit_window_seconds: 300, reset_after_seconds: 90}, secondary_window: {used_percent: 160}},
    additional_rate_limits: [{metered_feature: 'gpt-6.1-sol', limit_name: 'GPT-6.1 Sol', rate_limit: {primary_window: {used_percent: 50, limit_window_seconds: 86400}}}],
  }, now);
  assert.equal(usage.buckets[0].primary.usedPercent, 0);
  assert.equal(usage.buckets[0].secondary.usedPercent, 100);
  assert.equal(usage.buckets[0].primary.resetsAt, now / 1000 + 90);
  assert.equal(usage.buckets[1].primary.windowMinutes, 1440);
});

test('failed refresh keeps same-account credits marked stale, while disconnected usage clears them', async () => {
  const {api, host, clock, calls, respond} = backend();
  const initial = await api.felixGetUsage(host);
  assert.equal(initial.credits.balance, 20);
  await api.felixGetUsage(host);
  assert.equal(calls.length, 1, 'ordinary reads use the current account cache');
  clock.now += 60001;
  respond(async () => {throw new Error('Synthetic offline response');});
  const stale = await api.felixGetUsage(host);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.credits.balance, 20);
  assert.equal(stale.updatedAt, initial.updatedAt);
  host.modelRuntime.getAuth = async () => null;
  const disconnected = await api.felixGetUsage(host);
  assert.equal(disconnected.status, 'disconnected');
  assert.equal(disconnected.credits, null);
});

test('switching accounts invalidates cached credits and cannot borrow an old-account balance on failure', async () => {
  const {api, host, calls, respond} = backend();
  assert.equal((await api.felixGetUsage(host)).credits.balance, 20);
  await api.felixChangeOpenAIAccount(host, 'switch', 'account-2');
  respond(async (url, options) => {
    assert.equal(options.headers['ChatGPT-Account-Id'], 'account-2');
    return {ok: true, json: async () => ({credits: {balance: '5'}})};
  });
  assert.equal((await api.felixGetUsage(host)).credits.balance, 5);
  assert.equal(calls.length, 2);
  await api.felixChangeOpenAIAccount(host, 'switch', 'account-1');
  respond(async () => {throw new Error('Synthetic usage failure');});
  const failed = await api.felixGetUsage(host);
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.credits, null);
});

test('an old usage response arriving during an account operation cannot expose the previous balance', async () => {
  const {api, host, respond} = backend(), network = deferred(), selection = deferred();
  respond(() => network.promise);
  const reading = api.felixGetUsage(host);
  await flush();
  const select = host.credentials.selectOpenAIAccount;
  host.credentials.selectOpenAIAccount = async id => {await selection.promise; await select(id);};
  const switching = api.felixChangeOpenAIAccount(host, 'switch', 'account-2');
  await flush();
  assert.equal(host.felixAccountOperation, true);
  network.resolve({ok: true, json: async () => ({credits: {balance: 99}})});
  const result = await reading;
  assert.equal(result.status, 'loading');
  assert.equal(result.credits, null);
  selection.resolve();
  await switching;
});

test('an old usage response arriving after account replacement cannot overwrite the new account cache', async () => {
  const {api, host, respond} = backend(), old = deferred();
  respond(() => old.promise);
  const reading = api.felixGetUsage(host);
  await flush();
  await api.felixChangeOpenAIAccount(host, 'switch', 'account-2');
  respond(async () => ({ok: true, json: async () => ({credits: {balance: 5}})}));
  assert.equal((await api.felixGetUsage(host)).credits.balance, 5);
  old.resolve({ok: true, json: async () => ({credits: {balance: 99}})});
  assert.equal((await reading).credits, null);
  assert.equal((await api.felixGetUsage(host)).credits.balance, 5);
});

function frontend(extra = {}) {
  const source = ts.createSourceFile('controls.tsx', readSource('controls.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = ['felixUsageView', 'FelixUsageControl'];
  const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node) && wanted.includes(node.name?.text)).map(node => node.getText(source));
  assert.equal(declarations.length, wanted.length);
  const module = {exports: {}};
  const code = ts.transpileModule(declarations.join('\n') + '\nmodule.exports = {felixUsageView, FelixUsageControl};', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  vm.runInNewContext(code, {module, Date, ...extra});
  return module.exports;
}

test('usage presentation shows credit balance and both windows together, including a real zero', () => {
  const {api} = backend(), {felixUsageView} = frontend();
  const view = felixUsageView(api.parseUsage({...limits, credits: {balance: 1250.5}}, now), model, now);
  assert.equal(view.windows.length, 2);
  assert.equal(view.windows[0].remaining, 75);
  assert.equal(view.windows[1].label, 'Week');
  assert.equal(view.windows[1].remaining, 0);
  assert.equal(view.low, true);
  assert.equal(view.credits.label, 'Credits');
  assert.equal(view.credits.available, true);
  assert.match(view.credits.value, /1[,. ]250/);
  assert.match(view.text, /Credits/i);
  assert.match(view.text, /Week/i);
  assert.match(view.title, /credits/i);
  const zero = felixUsageView(api.parseUsage({credits: {balance: '0'}}, now), model, now);
  assert.equal(zero.credits.available, true);
  assert.equal(zero.credits.value, '0');
});

test('usage presentation distinguishes unlimited, unavailable and loading credits without inventing a balance', () => {
  const {api} = backend(), {felixUsageView} = frontend();
  const unlimited = felixUsageView(api.parseUsage({credits: {unlimited: true}}, now), model, now);
  assert.equal(unlimited.credits.available, true);
  assert.match(unlimited.credits.value, /unlimited/i);
  for (const status of ['unavailable', 'disconnected', 'ready']) {
    const view = felixUsageView({status, buckets: [], credits: null}, model, now);
    assert.equal(view.credits.available, false);
    assert.match(view.credits.value, status === 'disconnected' ? /sign in/i : /unavailable|not reported|—/i);
    assert.doesNotMatch(view.text, /Credits:?\s*0\b/);
  }
  const loading = felixUsageView({status: 'loading', buckets: [], credits: null}, model, now);
  assert.equal(loading.credits.available, false);
  assert.match(loading.credits.value, /loading/i);
  const tiny = felixUsageView(api.parseUsage({credits: {balance: 0.0000001}}, now), model, now);
  assert.equal(tiny.credits.available, true);
  assert.notEqual(tiny.credits.value, '0', 'a positive balance must not be rounded down to an apparent zero');
});

test('stale credits are identified and expired windows wait for a refresh rather than showing fresh zero usage', () => {
  const {api} = backend(), {felixUsageView} = frontend();
  const usage = {...api.parseUsage({...limits, credits: {balance: 42}}, now), status: 'stale'};
  const view = felixUsageView(usage, model, now + 86400001);
  assert.equal(view.stale, true);
  assert.equal(view.credits.available, true);
  assert.equal(view.credits.value, '42');
  assert(view.windows.every(window => window.remaining === null));
  assert.match(view.text, /stale/i);
  assert.match(view.title, /last known/i);
});

test('model-specific usage takes precedence over the shared plan bucket without dropping account credits', () => {
  const {api} = backend(), {felixUsageView} = frontend();
  const usage = api.parseUsage({...limits, credits: {balance: 2.125}, additional_rate_limits: [
    {metered_feature: 'gpt-6.1-sol', limit_name: 'GPT 6.1 Sol', rate_limit: {primary_window: {used_percent: 40, limit_window_seconds: 86400}}},
  ]}, now);
  const view = felixUsageView(usage, model, now);
  assert.equal(view.windows.length, 1);
  assert.equal(view.windows[0].label, 'Day');
  assert.equal(view.windows[0].remaining, 60);
  assert.equal(view.credits.value, '2.125');
});

// Exercise the real component effects with deterministic React/browser boundaries.
// Timers are inert, requests are synthetic, and rendered text is the user-facing assertion.
function usageComponent(getUsage) {
  const slots = [], effects = [], listeners = new Set();
  let cursor = 0;
  const v = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {slots[index] = typeof value === 'function' ? value(slots[index]) : value;}];
    },
    useRef(initial) {const index = cursor++; return slots[index] ??= {current: initial};},
    useEffect(callback, deps) {
      const index = cursor++, prior = slots[index];
      if (!prior || deps.some((value, i) => value !== prior.deps[i])) {
        prior?.cleanup?.(); slots[index] = {deps}; effects.push(() => {slots[index].cleanup = callback();});
      }
    },
  };
  const node = (type, props) => ({type, props});
  const {FelixUsageControl} = frontend({
    v, s: {jsx: node, jsxs: node},
    window: {modmixer: {getOpenAIUsage: getUsage, onOAuthEvent: callback => {listeners.add(callback); return () => listeners.delete(callback);}}},
    document: {hidden: false, addEventListener() {}, removeEventListener() {}},
    setInterval: () => 1, clearInterval() {},
  });
  const render = (selectedModel = model) => {cursor = 0; const result = FelixUsageControl({model: selectedModel}); while (effects.length) effects.shift()(); return result;};
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node ? text(node.props?.children) : '';
  return {render, text, emit: event => {for (const listener of listeners) listener(event);}};
}

test('account-switch events clear visible credits immediately and discard late old-account UI responses', async () => {
  const old = deferred();
  let busy = false, pending = false, balance = 59;
  const f = usageComponent(async () => {
    if (busy) return {status: 'loading', buckets: [], credits: null};
    if (pending) {pending = false; return old.promise;}
    return {status: 'ready', buckets: [], credits: {unlimited: false, balance}, updatedAt: now};
  });
  f.render(); await flush();
  assert.match(f.text(f.render()), /59/);
  pending = true;
  f.render().props.onClick(); await flush();
  busy = true;
  f.emit({providerId: 'openai-codex', type: 'accounts-changed', usageChanged: false});
  assert.doesNotMatch(f.text(f.render()), /59/);
  await flush();
  busy = false; balance = 5;
  f.emit({providerId: 'openai-codex', type: 'accounts-changed', usageChanged: true});
  await flush();
  assert.match(f.text(f.render()), /5/);
  old.resolve({status: 'ready', buckets: [], credits: {unlimited: false, balance: 88}, updatedAt: now});
  await flush();
  assert.doesNotMatch(f.text(f.render()), /88/);
  assert.match(f.text(f.render()), /5/);
});

test('returning to OpenAI after an account change on another provider does not display retained old credits', async () => {
  const nextAccount = deferred();
  let switched = false;
  const f = usageComponent(async () => switched ? nextAccount.promise : {status: 'ready', buckets: [], credits: {unlimited: false, balance: 59}, updatedAt: now});
  f.render(); await flush();
  assert.match(f.text(f.render()), /59/);
  assert.equal(f.render({provider: 'anthropic', modelId: 'fixture-claude'}), null);
  switched = true;
  f.emit({providerId: 'openai-codex', type: 'accounts-changed', usageChanged: true});
  f.render(); await flush();
  assert.doesNotMatch(f.text(f.render()), /59/);
  nextAccount.resolve({status: 'ready', buckets: [], credits: {unlimited: false, balance: 5}, updatedAt: now});
  await flush();
  assert.match(f.text(f.render()), /5/);
});
