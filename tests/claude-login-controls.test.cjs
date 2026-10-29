'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const {createOAuthState, cooldownMessage} = require('../src/atlas/claude-oauth-state.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}

// Execute the actual host's login methods and state, without constructing its
// game/credential/session dependencies. Runtime and browser are strict fakes.
function fixture() {
  const file = path.resolve(__dirname, '../src/agent/agent-host.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AgentHost');
  const names = ['pendingOAuth', 'oauthLoginTask', 'listOAuthLinks', 'claudeLoginCooldown',
    'blockClaudeLoginCooldown', 'isOAuthLoginPending', 'felixLoginOAuthOriginal', 'performOAuthLogin',
    'cancelOAuthLogin', 'provideOAuthCode', 'awaitPrompt', 'emitOAuth'];
  const members = names.map(name => {
    const node = declaration.members.find(member => member.name?.getText(source) === name);
    assert(node, 'Missing production member: ' + name);
    return node.getText(source);
  });
  const code = ts.transpileModule('class TestHost {' + members.join('\n') + '} globalThis.TestHost = TestHost;', {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
  }).outputText;
  const clock = {now: 1900000000000};
  class FixtureDate extends Date {static now() {return clock.now;}}
  const state = createOAuthState({now: () => clock.now});
  const calls = [], events = [], browser = [], clears = [];
  const context = vm.createContext({AbortController, Date: FixtureDate, Error, Promise,
    claudeOAuthState: {...state, cooldownMessage},
    shell: {openExternal: async url => browser.push(url)},
    HOSTED_PROVIDERS: ['anthropic', 'openai-codex'], providerLabel: id => id,
    clearClaudeUsage: () => clears.push('claude'), felixClearUsage: () => clears.push('openai'),
  });
  vm.runInContext(code, context, {filename: file});
  const host = new context.TestHost();
  const active = {current: 0, maximum: 0};
  const openAIContext = {};
  host.credentials = {felixLoginContext: {getStore: () => openAIContext}};
  host.modelRuntime = {
    getProvider: id => ({auth: {oauth: {name: id}}}),
    login: (id, method, interaction) => {
      assert.equal(method, 'oauth');
      const done = deferred();
      calls.push({id, interaction, done});
      active.current++;
      active.maximum = Math.max(active.current, active.maximum);
      return done.promise.finally(() => {active.current--;});
    },
  };
  host.modelRegistry = {getProviderAuthStatus: () => ({})};
  host.isProviderConfigured = () => false;
  host.sendToRenderer = (channel, event) => {
    assert.equal(channel, 'modmixer:oauth:event');
    events.push({...event, pendingAtEvent: host.isOAuthLoginPending(event.providerId)});
  };
  host.refreshActiveModel = async () => {};
  host.refreshModelCatalog = async () => {};
  return {host, state, clock, calls, events, browser, clears, active, openAIContext};
}

test('rapid same-provider clicks share one attempt and terminal success releases pending state', async () => {
  const f = fixture();
  const first = f.host.felixLoginOAuthOriginal('anthropic');
  assert.equal(f.host.isOAuthLoginPending('anthropic'), true);
  assert.equal(f.host.felixLoginOAuthOriginal('anthropic'), first);
  await tick();
  assert.equal(f.calls.length, 1);
  f.calls[0].interaction.notify({type: 'auth_url', url: 'https://example.invalid/sign-in'});
  assert.deepEqual(f.browser, ['https://example.invalid/sign-in']);
  assert.equal(f.host.felixLoginOAuthOriginal('anthropic'), first);
  f.calls[0].done.resolve();
  await first;
  assert.equal(f.host.isOAuthLoginPending('anthropic'), false);
  assert.equal(f.events.filter(event => event.type === 'login-start').length, 1);
  assert.equal(f.events.find(event => event.type === 'login-success').pendingAtEvent, false);
  assert.equal(f.clears.filter(value => value === 'claude').length, 1);
});

test('provider switching awaits teardown, suppresses stale callbacks, and keeps the OpenAI context', async () => {
  const f = fixture();
  const first = f.host.felixLoginOAuthOriginal('anthropic');
  await tick();
  const second = f.host.felixLoginOAuthOriginal('openai-codex');
  assert.equal(f.host.felixLoginOAuthOriginal('openai-codex'), second);
  assert.equal(f.calls[0].interaction.signal.aborted, true);
  f.calls[0].interaction.notify({type: 'auth_url', url: 'https://example.invalid/stale'});
  await assert.rejects(f.calls[0].interaction.prompt({type: 'manual_code'}), /cancelled/);
  await tick();
  assert.equal(f.calls.length, 1, 'must not bind another callback before teardown');
  assert.equal(f.host.isOAuthLoginPending('anthropic'), true);
  f.calls[0].done.resolve();
  await first;
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.active.maximum, 1);
  assert.equal(f.host.isOAuthLoginPending('anthropic'), false);
  assert.equal(f.openAIContext.signal, f.calls[1].interaction.signal);
  f.calls[0].interaction.notify({type: 'progress', message: 'Stale'});
  assert.deepEqual(f.browser, []);
  assert(!f.events.some(event => event.message === 'Stale'));
  assert.deepEqual(f.events.filter(event => event.type === 'login-success'), []);
  f.calls[1].done.resolve();
  await second;
  assert.equal(f.events.find(event => event.type === 'login-success').providerId, 'openai-codex');
});

test('cancel waits for shutdown, rejects the code prompt, and cancels a queued replacement', async () => {
  const f = fixture();
  const first = f.host.felixLoginOAuthOriginal('anthropic');
  await tick();
  const prompt = f.calls[0].interaction.prompt({type: 'manual_code'});
  const rejected = assert.rejects(prompt, /aborted/);
  const replacement = f.host.felixLoginOAuthOriginal('openai-codex');
  const cancelled = f.host.cancelOAuthLogin();
  let finished = false;
  void cancelled.then(() => {finished = true;});
  await tick();
  assert.equal(finished, false);
  f.host.provideOAuthCode('anthropic', 'unused-fixture-code');
  f.calls[0].done.reject(new Error('aborted'));
  await Promise.all([first, replacement, cancelled, rejected]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.filter(event => event.type === 'login-cancelled').length, 1);
  assert.equal(f.host.isOAuthLoginPending('anthropic'), false);
  assert.equal(f.host.isOAuthLoginPending('openai-codex'), false);
});

for (const [label, retryAfter, expectedSource] of [['provider wait', '120', 'provider'], ['local fallback', null, 'local']]) {
  test(label + ' blocks login before browser/runtime, expires without automatic retry', async () => {
    const f = fixture();
    const limited = f.state.rateLimit(retryAfter, {status: 429, requestId: 'req_fixture'});
    await f.host.felixLoginOAuthOriginal('anthropic');
    assert.equal(f.calls.length, 0);
    assert.equal(f.browser.length, 0);
    const event = f.events.find(event => event.type === 'login-error');
    assert.equal(event.retryAt, limited.retryAt);
    assert.equal(event.retrySource, expectedSource);
    assert.match(event.message, expectedSource === 'provider' ? /requested a wait/ : /local delay/);
    const link = f.host.listOAuthLinks().find(link => link.id === 'anthropic');
    assert.equal(link.retryAt, limited.retryAt);
    assert.equal(link.retrySource, expectedSource);
    assert.equal(f.host.listOAuthLinks().find(link => link.id === 'openai-codex').retryAt, undefined);
    f.clock.now = limited.retryAt + 1;
    await tick();
    assert.equal(f.calls.length, 0);
    const manual = f.host.felixLoginOAuthOriginal('anthropic');
    await tick();
    assert.equal(f.calls.length, 1);
    f.calls[0].done.resolve();
    await manual;
  });
}

test('queued Claude attempt checks cooldown again after previous teardown', async () => {
  const f = fixture();
  const first = f.host.felixLoginOAuthOriginal('openai-codex');
  await tick();
  const next = f.host.felixLoginOAuthOriginal('anthropic');
  f.state.rateLimit('60', {status: 429});
  f.calls[0].done.resolve();
  await Promise.all([first, next]);
  assert.equal(f.calls.length, 1);
  assert.equal(f.events.at(-1).type, 'login-error');
  assert.equal(f.host.isOAuthLoginPending('anthropic'), false);
});

test('provider HTTP 429 failure exposes durable cooldown and does not clear usage', async () => {
  const f = fixture();
  const pending = f.host.felixLoginOAuthOriginal('anthropic');
  await tick();
  f.state.rateLimit('90', {status: 429});
  f.calls[0].done.reject(new Error('HTTP 429, fixture provider request'));
  await pending;
  const event = f.events.at(-1);
  assert.equal(event.type, 'login-error');
  assert.equal(event.retrySource, 'provider');
  assert.equal(event.pendingAtEvent, false);
  assert.equal(f.clears.filter(value => value === 'claude').length, 0);
  await f.host.felixLoginOAuthOriginal('anthropic');
  assert.equal(f.calls.length, 1);
});

test('catalog updates, prompts, progress, cancel and errors retain the Claude usage cache', () => {
  const f = fixture();
  for (const type of ['links-changed', 'login-start', 'login-progress', 'prompt-needed', 'prompt-resolved', 'login-error', 'login-cancelled']) {
    f.host.emitOAuth(type === 'links-changed' ? {type} : {type, providerId: 'anthropic'});
  }
  f.host.emitOAuth({type: 'login-success', providerId: 'openai-codex'});
  assert.equal(f.clears.filter(value => value === 'claude').length, 0);
  f.host.emitOAuth({type: 'login-success', providerId: 'anthropic'});
  f.host.emitOAuth({type: 'logout', providerId: 'anthropic'});
  assert.equal(f.clears.filter(value => value === 'claude').length, 2);
});

test('settings render disabled countdown, explain local/provider waits, and re-enable after expiry', () => {
  const React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const file = path.resolve(__dirname, '../src/components/app-settings-dialog.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = ['ProviderRow', 'StatusPill'].map(name => source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
  const compiled = ts.transpileModule(functions.join('\n') + '\nglobalThis.ProviderRow = ProviderRow;', {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX},
    fileName: file,
  }).outputText;
  let now = 1900000000000;
  class FixtureDate extends Date {static now() {return now;}}
  const context = vm.createContext({require, exports: {}, Date: FixtureDate, useState: React.useState, useEffect: React.useEffect});
  vm.runInContext(compiled, context, {filename: file});
  const props = {link: {id: 'anthropic', name: 'Claude', label: 'Claude', linked: false, retryAt: now + 120000, retrySource: 'provider'}, busy: false, progress: null, prompt: null, onSignIn() {}, onCancel() {}, onSignOut() {}};
  const render = () => renderToStaticMarkup(React.createElement(context.ProviderRow, props));
  assert.match(render(), /disabled=""[^>]*>Try again in 2:00/);
  assert.match(render(), /Claude requested this wait/);
  props.link.retrySource = 'local';
  assert.match(render(), /pausing attempts locally/);
  assert.match(render(), /will not retry automatically/);
  now += 120001;
  assert.doesNotMatch(render(), /disabled=""/);
  assert.match(render(), />Sign in<\/button>/);
});
