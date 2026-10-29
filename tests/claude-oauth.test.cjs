'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {patchClaudeOAuth} = require('../scripts/atlas/patch-claude-oauth.cjs');
const transportModule = import(pathToFileURL(path.resolve(__dirname, '../src/atlas/claude-oauth-transport.mjs')).href);
const endpoint = 'https://platform.claude.com/v1/oauth/token';
const body = {grant_type:'authorization_code',code:'private-fixture-code',code_verifier:'private-fixture-verifier'};

test('429 headers establish cooldown even when reading the body fails', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  const {createOAuthState} = require('../src/atlas/claude-oauth-state.cjs');
  const now=1900000000000,state=createOAuthState({now:()=>now});let calls=0;
  const post=createClaudeOAuthPostJson(async()=>{calls++;return {status:429,ok:false,headers:new Headers({'Retry-After':'120'}),text:async()=>{throw new Error('body reset');}};},30000,{state,now:()=>now});
  await assert.rejects(post(endpoint,body),/HTTP 429/);
  assert.equal(state.read().retryAt,now+120000);
  await assert.rejects(post(endpoint,body),/HTTP 429/);
  assert.equal(calls,1);
});

test('token transport is confined to Claude, sends JSON without browser cookies and refuses redirects', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  const calls = [];
  const post = createClaudeOAuthPostJson(async (...args) => {calls.push(args);return new Response('{"access_token":"fixture"}');});
  assert.equal(await post(endpoint, body), '{"access_token":"fixture"}');
  assert.equal(calls[0][0], endpoint);
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), body);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].cache, 'no-store');
  await assert.rejects(post('https://example.com', body), /Unexpected Claude/);
  assert.equal(calls.length, 1);
});

test('connection reset and response-body loss do not replay a possibly consumed code or leak it', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  for (const duringBody of [false, true]) {
    let calls = 0;
    const fail = () => {throw new Error('ECONNRESET private-fixture-code');};
    const post = createClaudeOAuthPostJson(async () => {calls++;if(!duringBody)fail();return {ok:true,text:fail};});
    await assert.rejects(post(endpoint, body), error => /connection.*interrupted/i.test(error.message) && /new attempt/.test(error.message) && !error.message.includes('private-fixture'));
    assert.equal(calls, 1);
  }
});

test('HTTP failures have actionable messages without logging raw token/error bodies', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  for (const [status, message] of [[400,/fresh authorization/],[401,/fresh authorization/],[429,/HTTP 429.*local delay/],[503,/HTTP 503/]]) {
    const post = createClaudeOAuthPostJson(async () => new Response('private-fixture-code',{status}));
    await assert.rejects(post(endpoint, body), error => message.test(error.message) && !error.message.includes('private-fixture'));
  }
});

test('Retry-After blocks both login and refresh, survives reload, and does not replay after expiry', async () => {
  const {createClaudeOAuthPostJson}=await transportModule;
  const {createOAuthState}=require('../src/atlas/claude-oauth-state.cjs');
  let now=1900000000000,saved,calls=0;
  const state=createOAuthState({now:()=>now,persist:value=>saved=JSON.stringify(value)});
  const request=async()=>{calls++;return new Response(JSON.stringify({error:{type:'rate_limit_error',message:'private-fixture-secret'}}),{status:429,headers:{'retry-after':'90','request-id':'req_fixture','content-type':'application/json'}});};
  const post=createClaudeOAuthPostJson(request,1000,{state,now:()=>now});
  await assert.rejects(post(endpoint,body),error=>error.retryAt===now+90000&&error.retrySource==='provider');
  await assert.rejects(post(endpoint,{grant_type:'refresh_token',refresh_token:'private-fixture-token'}),/HTTP 429/);
  assert.equal(calls,1);assert(!saved.includes('private-fixture'));assert(saved.includes('req_fixture'));
  const restored=createOAuthState({now:()=>now,load:()=>JSON.parse(saved)});
  const next=createClaudeOAuthPostJson(request,1000,{state:restored,now:()=>now});
  await assert.rejects(next(endpoint,body),/requested a wait/);assert.equal(calls,1);
  now+=90001;assert.equal(calls,1,'Expiry must not schedule an automatic token request');
  await assert.rejects(next(endpoint,body),/HTTP 429/);assert.equal(calls,2);
});

test('missing retry time uses a clearly labelled local pause and diagnostics never store token bodies', async () => {
  const {createClaudeOAuthPostJson}=await transportModule;
  const {createOAuthState,LOCAL_BACKOFF_MS}=require('../src/atlas/claude-oauth-state.cjs');
  const now=1900000000000;let saved;
  const state=createOAuthState({now:()=>now,persist:value=>saved=JSON.stringify(value)});
  const post=createClaudeOAuthPostJson(async()=>new Response('<html>private-fixture-token</html>',{status:429,headers:{'content-type':'text/html','request-id':'unsafe.value'}}),1000,{state,now:()=>now});
  await assert.rejects(post(endpoint,body),/local delay.*HTML response/);
  assert.equal(state.read().retryAt,now+LOCAL_BACKOFF_MS);assert.equal(state.read().retrySource,'local');
  assert(!saved.includes('private-fixture'));assert(!saved.includes('unsafe.value'));
});

test('Retry-After accepts seconds and HTTP dates without inventing an exact server reset', () => {
  const {retryTime}=require('../src/atlas/claude-oauth-state.cjs');
  const now=1900000000000;
  assert.equal(retryTime('120',now),now+120000);
  assert.equal(retryTime(new Date(now+60000).toUTCString(),now),now+60000);
  for(const value of [null,'','not a date','-20','0','Infinity'])assert.equal(retryTime(value,now),null);
});

test('overlapping token calls do not create a second network request', async () => {
  const {createClaudeOAuthPostJson}=await transportModule;let finish,calls=0;
  const post=createClaudeOAuthPostJson(async()=>{calls++;return new Promise(resolve=>finish=resolve);});
  const first=post(endpoint,body);
  await assert.rejects(post(endpoint,{grant_type:'refresh_token',refresh_token:'fixture'}),/already|still finishing/);
  assert.equal(calls,1);finish(new Response('{}'));await first;
});

test('cancel before sending or during response reading rejects and never returns credentials', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  let calls = 0;
  const abort = new AbortController();abort.abort();
  const post = createClaudeOAuthPostJson(async () => {calls++;return new Response('{}');});
  await assert.rejects(post(endpoint, body, abort.signal), {name:'AbortError'});
  assert.equal(calls, 0);
  const duringRead = new AbortController();
  const reading = createClaudeOAuthPostJson(async () => ({ok:true,text:async()=>{duringRead.abort();return '{"access_token":"fixture"}';}}));
  await assert.rejects(reading(endpoint, body, duringRead.signal), {name:'AbortError'});
});

test('timeouts abort the transport and provide a bounded fresh-sign-in path', async () => {
  const {createClaudeOAuthPostJson} = await transportModule;
  let calls = 0;
  const post = createClaudeOAuthPostJson(async (_url, options) => {
    calls++;
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
  }, 15);
  await assert.rejects(post(endpoint, body), /timed out.*new attempt/);
  assert.equal(calls, 1);
});

function fixture(post) {
  const upstream = fs.readFileSync(path.resolve(__dirname, '../build-tools/native/node_modules/@earendil-works/pi-ai/dist/auth/oauth/anthropic.js'), 'utf8');
  let source = patchClaudeOAuth(upstream);
  const start = source.indexOf('async function startCallbackServer(');
  const end = source.indexOf('async function postJson(', start);
  source = source.slice(0, start) + source.slice(end);
  source = source.replace(/^import .*;\r?\n/gm,'').replace('export const anthropicOAuth', 'const anthropicOAuth');
  let closed = 0;
  let release;
  const sandbox = {
    atob, URL, URLSearchParams, AbortController, Date,
    getProviderEnvValue:()=>undefined,
    generatePKCE:async()=>({verifier:'fixture-verifier',challenge:'fixture-challenge'}),
    atlasClaudeOAuthPostJson:post,
    startCallbackServer:async()=>({server:{close:()=>closed++},cancelWait:()=>release?.(null),waitForCode:()=>new Promise(resolve=>{release=resolve;})}),
  };
  const api = vm.runInNewContext(source+'\n;anthropicOAuth;', sandbox);
  return {api,get closed(){return closed;},upstream};
}

test('patched provider preserves PKCE, forwards cancel to exchange, dismisses manual prompt and closes callback', async () => {
  let received;
  let promptSignal;
  const abort = new AbortController();
  const f = fixture(async (url, input, signal) => {
    assert.equal(promptSignal.aborted, true);
    received = {url,input,signal};
    return '{"access_token":"fixture-access","refresh_token":"fixture-refresh","expires_in":3600}';
  });
  const events = [];
  const credential = await f.api.login({signal:abort.signal,notify:e=>events.push(e),prompt:async p=>{promptSignal=p.signal;return 'fixture-code#fixture-verifier';}});
  assert.equal(received.url, endpoint);
  assert.equal(received.input.code_verifier, 'fixture-verifier');
  assert.equal(received.input.state, 'fixture-verifier');
  assert.equal(received.input.redirect_uri, 'http://localhost:53692/callback');
  assert.equal(received.signal, abort.signal);
  assert.equal(credential.access, 'fixture-access');
  assert.equal(credential.refresh, 'fixture-refresh');
  assert.equal(f.closed, 1);
  assert.equal(new URL(events[0].url).searchParams.get('code_challenge_method'), 'S256');
});

test('failed exchanges and invalid JSON release callback without exposing response tokens', async () => {
  for (const fail of [true, false]) {
    const f = fixture(async()=>{if(fail)throw new Error('Connection interrupted. Start a new attempt.');return 'private-fixture-token';});
    await assert.rejects(f.api.login({notify:()=>{},prompt:async()=> 'fixture-code#fixture-verifier'}), error=> !error.message.includes('private-fixture') && (fail ? /Connection interrupted/.test(error.message) : /unreadable sign-in/.test(error.message)));
    assert.equal(f.closed, 1);
  }
});

test('refresh uses the same transport, preserves rotated credentials and forwards cancellation', async () => {
  let input;
  const abort = new AbortController();
  const f = fixture(async (url, body, signal)=>{input={url,body,signal};return '{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}';});
  const next = await f.api.refresh({refresh:'old-refresh'}, abort.signal);
  assert.equal(input.body.grant_type, 'refresh_token');
  assert.equal(input.body.refresh_token, 'old-refresh');
  assert.equal(input.signal, abort.signal);
  assert.equal(next.refresh, 'new-refresh');
});

test('dependency patch is repeatable and rejects incompatible upstream code', () => {
  const {upstream} = fixture(async()=> '{}');
  const patched = patchClaudeOAuth(upstream);
  assert.equal(patchClaudeOAuth(patched), patched);
  assert.throws(()=>patchClaudeOAuth(upstream.replace('async function postJson(url, body)', 'async function differentFunction(url, body)')), /boundary changed/);
  assert.throws(()=>patchClaudeOAuth(upstream.replace('code_verifier: verifier,', 'code_verifier: changed,')), /dependency changed/);
});
