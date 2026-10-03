const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

// Compile the real module imports so an absent helper binding reproduces the bug.
// Only provider/host boundaries are mocked; no user profile or OAuth is accessed.
function loginModule(closeConnections = async () => {}) {
  const context = vm.createContext({console, process, Buffer, setTimeout, clearTimeout, AbortController, AbortSignal});
  function load(relative) {
    const filename = path.resolve(__dirname, '../src', relative);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
      fileName: filename,
    }).outputText;
    const module = {exports: {}};
    const localRequire = id => {
      if (id.startsWith('node:')) return require(id);
      if (id === './account-label') return load('atlas/account-label.ts');
      if (id === 'electron') return {BrowserWindow: {getAllWindows: () => []}};
      if (['@earendil-works/pi-coding-agent', '../agent/settings', '../agent/conversations', '../lib/thinking-levels', '../agent/agent-host'].includes(id)) return {};
      throw new Error('Unexpected dependency in login fixture: ' + id);
    };
    const connectionMock = relative === 'atlas/agent-features.ts' ? '\nfelixCloseOpenAIConnections = closeConnections;' : '';
    vm.runInContext('(function(require,module,exports,closeConnections){' + code + connectionMock + '\n})', context, {filename})(localRequire, module, module.exports, closeConnections);
    return module.exports;
  }
  const api = load('atlas/agent-features.ts');
  return {api, context};
}

function hostFixture(accounts = []) {
  const calls = [], events = [];
  const host = {
    sessions: new Map(),
    credentials: {
      openAIAccounts: () => ({activeId: accounts[0]?.id ?? null, accounts}),
      felixLoginContext: {run: async (context, callback) => {calls.push({context}); return callback();}},
    },
    emitOAuth: event => events.push({event, busy: host.felixAccountOperation}),
    felixLoginOAuthOriginal: async provider => calls.push({provider}),
  };
  return {host, calls, events};
}

test('OpenAI login validates its imported label helper before reaching the connection boundary', async () => {
  const {api} = loginModule(), {host} = hostFixture();
  await assert.rejects(() => api.felixLoginOpenAIAccount(host, undefined, ''), /Account names/);
  await assert.rejects(() => api.felixLoginOpenAIAccount(host, undefined, 123), /Enter an account name/);
  assert.equal(host.felixAccountOperation, undefined);
});

test('OpenAI first-account login reaches OAuth with its default label', async () => {
  let closed = 0;
  const {api} = loginModule(async () => {closed++;}), {host, calls, events} = hostFixture();
  await api.felixLoginOpenAIAccount(host);
  assert.equal(calls[0].context.label, 'Account 1');
  assert.equal(calls[1].provider, 'openai-codex');
  assert.equal(closed, 1);
  assert.equal(host.felixAccountOperation, false);
  assert.deepEqual(events.map(item => item.busy), [true, false]);
});

test('OpenAI second-account and existing-slot login keep their correct labels', async () => {
  const {api} = loginModule(), {host, calls} = hostFixture([{id: 'account-1', label: 'Personal'}]);
  await api.felixLoginOpenAIAccount(host);
  assert.equal(calls[0].context.label, 'Account 2');
  calls.length = 0;
  await api.felixLoginOpenAIAccount(host, 'account-1');
  assert.equal(calls[0].context.label, 'Personal');
  calls.length = 0;
  await api.felixLoginOpenAIAccount(host, 'account-2', '  Work\naccount  ');
  assert.equal(calls[0].context.label, 'Work account');
});

test('OpenAI OAuth failure releases the account-operation lock', async () => {
  const {api} = loginModule(), {host, events} = hostFixture();
  host.felixLoginOAuthOriginal = async () => {throw new Error('Synthetic sign-in cancellation');};
  await assert.rejects(() => api.felixLoginOpenAIAccount(host), /Synthetic sign-in cancellation/);
  assert.equal(host.felixAccountOperation, false);
  assert.deepEqual(events.map(item => item.busy), [true, false]);
});

test('OpenAI login rejects full or invalid account slots before starting a sign-in', async () => {
  const {api} = loginModule(), {host, calls} = hostFixture([{id: 'account-1', label: 'One'}, {id: 'account-2', label: 'Two'}]);
  await assert.rejects(() => api.felixLoginOpenAIAccount(host), /Both account slots/);
  await assert.rejects(() => api.felixLoginOpenAIAccount(host, 'wrong-slot'), /Choose an account slot/);
  assert.equal(host.felixAccountOperation, undefined);
  assert.equal(calls.length, 0);
});
