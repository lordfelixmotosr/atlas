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
  const authCalls = [];
  let oauth = true;
  let token = 'fixture-oauth-token';
  let authResponse = async () => token ? {auth: {apiKey: token}} : undefined;
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
    getAuth: async () => {authCalls.push(clock.now);return authResponse();},
  }};
  return {api: module.exports, host, clock, calls, authCalls,
    setOAuth: value => {oauth = value;}, setToken: value => {token = value;},
    respond: value => {response = value;},
    authRespond: value => {authResponse = value;},
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
  assert.equal(f.authCalls.length, 1, 'cached usage does not resolve or refresh auth again');
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
  assert.equal(f.authCalls.length, 2, '429 backoff is checked before resolving auth');
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

test('auth failure backs off before getAuth even with repeated forced usage refreshes', async () => {
  const f = fixture();
  f.authRespond(async () => {throw new Error('OAuth refresh limited');});
  assert.equal((await f.api.getClaudeUsage(f.host)).status, 'unavailable');
  for (let i=0;i<10;i++) await f.api.getClaudeUsage(f.host, true);
  f.clock.now += 299999;
  await f.api.getClaudeUsage(f.host, true);
  assert.equal(f.authCalls.length, 1);
  assert.equal(f.calls.length, 0);
  f.clock.now += 1;
  await f.api.getClaudeUsage(f.host);
  assert.equal(f.authCalls.length, 2, 'auth may be retried once the bounded cooldown ends');
});

test('concurrent usage callers share one pending auth refresh and logout prevents a late usage request', async () => {
  const f=fixture();let resolveAuth;
  f.authRespond(()=>new Promise(resolve=>{resolveAuth=resolve;}));
  const pending=Array.from({length:8},()=>f.api.getClaudeUsage(f.host,true));
  assert.equal(f.authCalls.length,1);
  f.api.clearClaudeUsage();
  resolveAuth({auth:{apiKey:'late-account-token'}});
  assert((await Promise.all(pending)).every(result=>result.status==='loading'));
  assert.equal(f.calls.length,0,'logout prevents sending the now-stale token to the usage endpoint');
});

test('sign-in invalidation clears auth-failure backoff and changed credentials cannot display another account usage', async () => {
  const f=fixture();
  const first=await f.api.getClaudeUsage(f.host);
  f.clock.now += 300001;
  f.authRespond(async()=>{throw new Error('Expired auth');});
  const stale=await f.api.getClaudeUsage(f.host);
  assert.equal(stale.status,'stale');assert.equal(stale.updatedAt,first.updatedAt);
  f.api.clearClaudeUsage();
  f.authRespond(async()=>({auth:{apiKey:'new-account-token'}}));
  f.respond(async()=>{throw new Error('Usage unavailable');});
  const next=await f.api.getClaudeUsage(f.host);
  assert.equal(next.status,'unavailable');assert.equal(next.windows.length,0);assert.equal(next.updatedAt,undefined);
  assert.equal(f.authCalls.length,3);
});

test('runtime replacement and token changes invalidate cached account usage', async()=>{
  const f=fixture();await f.api.getClaudeUsage(f.host);
  f.host.modelRuntime={isUsingOAuth:()=>true,getAuth:async()=>({auth:{apiKey:'replacement-account-token'}})};
  f.respond(async()=>{throw new Error('New account usage unavailable');});
  assert.equal((await f.api.getClaudeUsage(f.host)).status,'unavailable');
  assert.equal(f.calls.length,2);
  f.api.clearClaudeUsage();f.respond(async()=>({ok:true,json:async()=>({five_hour:{utilization:10}})}));
  await f.api.getClaudeUsage(f.host);
  f.clock.now += 300001;
  f.host.modelRuntime.getAuth=async()=>({auth:{apiKey:'another-account-token'}});
  f.respond(async()=>{throw new Error('New account usage unavailable');});
  const result=await f.api.getClaudeUsage(f.host);
  assert.equal(result.status,'unavailable');assert.equal(result.windows.length,0);
});

test('usage does not resolve auth when the host reports a pending Claude login', async()=>{
  const f=fixture();let pending=true;
  f.host.isOAuthLoginPending=provider=>provider==='anthropic'&&pending;
  assert.equal((await f.api.getClaudeUsage(f.host,true)).status,'loading');
  assert.equal(f.authCalls.length,0);assert.equal(f.calls.length,0);
  pending=false;
  assert.equal((await f.api.getClaudeUsage(f.host)).status,'ready');
});

function usageControlFixture() {
  const effects=[],states=[],calls=[],intervals=[],listeners=new Map();let cursor=0,oauthHandler;
  const hooks={useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useState:initial=>{
    const index=cursor++;states[index]=initial;
    return [initial,value=>{states[index]=typeof value==='function'?value(states[index]):value;}];
  }};
  const file=path.resolve(__dirname,'../src/atlas/claude-usage-control.tsx');
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},fileName:file}).outputText;
  const module={exports:{}};
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{
    Date,window:{modmixer:{getClaudeUsage:async force=>{calls.push(force);return {status:'ready',windows:[],updatedAt:1};},onOAuthEvent:handler=>{oauthHandler=handler;return()=>{};}}},
    document:{hidden:false,addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:name=>listeners.delete(name)},
    setInterval:fn=>{intervals.push(fn);return 1;},clearInterval:()=>{},
  },{filename:file})(name=>name==='react'?hooks:require(name),module,module.exports);
  const button=module.exports.ClaudeUsageControl({model:{provider:'anthropic'}});
  const cleanups=effects.map(effect=>effect());
  return {calls,button,event:payload=>oauthHandler(payload),visible:()=>listeners.get('visibilitychange')(),tick:()=>intervals.forEach(fn=>fn()),cleanup:()=>cleanups.forEach(fn=>fn?.())};
}

test('usage UI pauses auth-related reads throughout login and resumes only after successful credential change',async()=>{
  const f=usageControlFixture();const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try{
    await settle();assert.equal(f.calls.length,1);
    f.event({type:'login-start',providerId:'anthropic'});
    for(const type of ['login-progress','prompt-needed','prompt-resolved','login-error','login-cancelled'])f.event({type,providerId:'anthropic'});
    f.event({type:'links-changed'});f.tick();f.visible();f.button.props.onClick();await settle();
    assert.equal(f.calls.length,1,'progress, terminal failure, catalog events and timers do not start token work');
    f.event({type:'login-success',providerId:'anthropic'});await settle();assert.equal(f.calls.length,2);
    f.event({type:'logout',providerId:'anthropic'});await settle();assert.equal(f.calls.length,3);
  }finally{f.cleanup();}
});
