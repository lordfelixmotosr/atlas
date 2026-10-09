'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

function fixture() {
  const clock = {now: 1900000000000};
  const calls = [];
  let oauth = true;
  let token = 'fixture-oauth-token';
  let response = async () => ({ok: true, json: async () => ({
    five_hour: {utilization: 25, resets_at: '2030-03-17T00:00:00Z'},
    seven_day: {utilization: 80, resets_at: '2030-03-23T00:00:00Z'},
  })});
  class FixtureDate extends Date {static now() {return clock.now;}}
  const file = path.resolve(__dirname, '../src/atlas/claude-usage.ts');
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}, fileName: file,
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {
    Date: FixtureDate, AbortSignal, fetch: async (url, options) => {
      calls.push({url, options}); return response();
    },
  }, {filename: file})(require, module, module.exports);
  const host = {modelRuntime: {
    isUsingOAuth: () => oauth,
    getAuth: async () => token ? {auth: {apiKey: token}} : undefined,
  }};
  return {api: module.exports, host, clock, calls,
    setOAuth: value => {oauth = value;}, setToken: value => {token = value;},
    respond: value => {response = value;},
  };
}

test('Claude plan parser accepts legacy and scoped usage without treating extra usage as plan credits', () => {
  const {api} = fixture();
  const result = api.parseClaudeUsage({
    five_hour: {utilization: 12, resets_at: '2030-03-17T00:00:00Z'},
    seven_day: {utilization: 52},
    seven_day_opus: {utilization: 75},
    extra_usage: {is_enabled: true, utilization: 20, used_credits: 1000},
  });
  assert.deepEqual(Array.from(result.windows, w => w.label), ['5h', 'Week', 'Opus week', 'Extra usage']);
  assert.deepEqual(Array.from(result.windows, w => w.usedPercent), [12, 52, 75, 20]);
  assert(Number.isFinite(result.windows[0].resetsAt));
  assert.equal(result.status, 'ready');
});

test('Claude plan parser accepts new limits and ignores malformed or unreported values', () => {
  const {api} = fixture();
  const result = api.parseClaudeUsage({limits: [
    {kind: 'session', percent: 30, resets_at: '2030-03-17T00:00:00Z'},
    {kind: 'weekly_all', percent: 90},
    {kind: 'weekly_scoped', percent: 40, scope: {model: {display_name: 'Fable'}}},
    {kind: 'weekly_scoped', percent: -1, scope: {model: {display_name: 'Bad'}}},
    {kind: 'weekly_scoped', percent: '45', scope: {model: {display_name: 'Invalid'}}},
  ]});
  assert.deepEqual(Array.from(result.windows, w => w.label), ['5h', 'Week', 'Fable week']);
  assert.equal(api.parseClaudeUsage({extra_usage: {used_credits: 500}}).status, 'unavailable');
});

test('Claude plan request uses only Claude OAuth, caches reads, and never calls the endpoint for an API key', async () => {
  const f = fixture();
  const first = await f.api.getClaudeUsage(f.host);
  assert.equal(first.status, 'ready');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer fixture-oauth-token');
  await f.api.getClaudeUsage(f.host);
  assert.equal(f.calls.length, 1);
  f.setOAuth(false);
  assert.equal((await f.api.getClaudeUsage(f.host)).status, 'api-key');
  assert.equal(f.calls.length, 1);
  f.setToken('');
  assert.equal((await f.api.getClaudeUsage(f.host)).status, 'disconnected');
  assert.equal(f.calls.length, 1);
});

test('Claude usage stays stale on a failed refresh and backs off after 429', async () => {
  const f = fixture();
  const first = await f.api.getClaudeUsage(f.host);
  f.clock.now += 300001;
  f.respond(async () => ({ok: false, status: 429}));
  const stale = await f.api.getClaudeUsage(f.host);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.equal(f.calls.length, 2);
  f.clock.now += 300001;
  await f.api.getClaudeUsage(f.host, true);
  assert.equal(f.calls.length, 2, '429 backs off even after manual refresh');
});

test('Claude logout invalidates an in-flight usage response', async () => {
  const f = fixture();
  let resolve;
  f.respond(() => new Promise(done => {resolve = done;}));
  const pending = f.api.getClaudeUsage(f.host);
  for (let i = 0; i < 5 && !resolve; i++) await Promise.resolve();
  assert.equal(typeof resolve, 'function');
  f.api.clearClaudeUsage();
  resolve({ok: true, json: async () => ({five_hour: {utilization: 99}})});
  assert.equal((await pending).status, 'loading');
});
