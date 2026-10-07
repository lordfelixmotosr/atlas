const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

const promptModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-prompt.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: promptModule, exports: promptModule.exports });
const source = fs.readFileSync(path.resolve(__dirname, '../src/agent/agent-host.ts'), 'utf8');
const parsed = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
const hostClass = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'AgentHost');
const method = hostClass.members.find(node => node.name?.getText(parsed) === 'generateSpriteScenes');
const code = ts.transpileModule('class SpriteHost { atlasSpriteGenerationsOpenAI=0; ' + method.getText(parsed) + ' }; module.exports=SpriteHost;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture(provider = 'openai-codex', vision = true) {
  const moduleFixture = { exports: {} }, reads = [];
  vm.runInNewContext(code, {
    module: moduleFixture, path, Date,
    ...promptModule.exports,
    readImageContentForModel: async file => { reads.push(file); return { type: 'image', data: 'fixture', mimeType: 'image/jpeg' }; },
  });
  const host = new moduleFixture.exports();
  const model = { provider, id: 'fixture-model', name: 'Fixture model', input: vision ? ['text', 'image'] : ['text'] };
  host.resolveModel = () => model;
  host.modelRegistry = { find: () => model, hasConfiguredAuth: () => true };
  const args = {
    project: {
      recipe: { name: 'Moon crow', kind: 'bird', brief: 'Grey crown and cream breast.', palette: ['#4e5c48', '#f3ead5'], canvasSize: 128, frameCount: 8, ticksPerFrame: 2, groundedDrawSize: 0.7, drawSize: 1.5 },
      candidates: [{ metadata: 'not sent to provider' }], references: [{ path: 'C:/private/reference.png' }],
    },
    directions: ['south', 'east', 'north'], instruction: 'Keep the crown shape.',
    referencePaths: ['C:/safe/reference.png'], approvedPaths: ['C:/safe/east.png'],
    model: { provider, modelId: model.id },
  };
  return { host, model, args, reads };
}

test('sprite generation uses the selected configured runtime, images and account without chat tools', async () => {
  const { host, model, args, reads } = fixture(), controller = new AbortController();
  host.modelRuntime = { completeSimple: async (selected, context, options) => {
    assert.equal(selected, model);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 1);
    assert.equal(options.signal, controller.signal);
    assert.equal(options.maxTokens, 9000);
    assert.equal(options.reasoning, 'medium');
    assert.equal(context.tools, undefined);
    assert.match(context.systemPrompt, /untrusted art data/);
    assert.match(context.systemPrompt, /body contains only/);
    assert.match(context.systemPrompt, /NO wings/);
    assert.match(context.systemPrompt, /35 degrees/);
    const content = context.messages[0].content;
    assert.equal(content.length, 5);
    const prompt = JSON.parse(content[0].text);
    assert.equal(prompt.recipe.palette[0], '#4e5c48');
    assert.equal(prompt.recipe.drawSize, 1.5);
    assert.equal(prompt.constraints.minimumPadding, 11);
    assert.equal(prompt.recipe.candidates, undefined);
    assert.doesNotMatch(content[0].text, /private|metadata/);
    assert.match(content[3].text, /Approved identity view: east.png/);
    assert.equal(content[4].type, 'image');
    return { stopReason: 'stop', content: [{ type: 'text', text: '{"directions":{}}' }] };
  } };
  const result = await host.generateSpriteScenes(args, controller.signal);
  assert.equal(result.response, '{"directions":{}}');
  assert.equal(result.model, 'Fixture model');
  assert.deepEqual(reads, args.referencePaths.concat(args.approvedPaths));
  assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
});

test('text-only models do not read images or claim reference observation', async () => {
  const { host, args, reads } = fixture('anthropic', false);
  host.modelRuntime = { completeSimple: async (_model, context) => {
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
    assert.equal(context.messages[0].content.length, 1);
    assert.match(JSON.parse(context.messages[0].content[0].text).referenceAvailability, /No reference or approved image has been observed/);
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  } };
  await host.generateSpriteScenes(args, new AbortController().signal);
  assert.equal(reads.length, 0);
});

test('an explicit unavailable model never falls back to another provider', async () => {
  for (const mode of ['missing', 'unauthed', 'fallback']) {
    const { host, args } = fixture();
    let calls = 0;
    host.modelRuntime = { completeSimple: async () => { calls++; } };
    if (mode === 'missing') host.modelRegistry.find = () => undefined;
    if (mode === 'unauthed') host.modelRegistry.hasConfiguredAuth = () => false;
    if (mode === 'fallback') host.resolveModel = () => ({ provider: 'anthropic', id: 'other' });
    await assert.rejects(host.generateSpriteScenes(args, new AbortController().signal), /selected AI account|selected sprite model/);
    assert.equal(calls, 0);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
  }
});

test('provider failures and late cancelled output release the sprite account guard', async () => {
  for (const mode of ['error', 'aborted', 'cancelled', 'empty', 'oversized', 'throw', 'length']) {
    const { host, args } = fixture(), controller = new AbortController();
    host.modelRuntime = { completeSimple: async () => {
      assert.equal(host.atlasSpriteGenerationsOpenAI, 1);
      if (mode === 'throw') throw new Error('Network unavailable');
      if (mode === 'cancelled') controller.abort();
      return {
        stopReason: mode === 'error' || mode === 'aborted' || mode === 'length' ? mode : 'stop',
        errorMessage: 'Provider declined',
        content: [{ type: 'text', text: mode === 'empty' ? ' ' : mode === 'oversized' ? 'x'.repeat(500001) : '{}' }],
      };
    } };
    await assert.rejects(host.generateSpriteScenes(args, controller.signal), /Provider declined|cancelled|empty or oversized|Network unavailable|ran out of room/);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
  }
});

test('cancellation, sign-in changes and oversized inputs do not start a model request', async () => {
  for (const mode of ['cancelled', 'account', 'oauth', 'references', 'approved', 'directions']) {
    const { host, args } = fixture(), controller = new AbortController();
    let calls = 0;
    host.modelRuntime = { completeSimple: async () => { calls++; } };
    if (mode === 'cancelled') controller.abort();
    if (mode === 'account') host.felixAccountOperation = true;
    if (mode === 'oauth') host.pendingOAuth = {};
    if (mode === 'references') args.referencePaths = Array(7).fill('fake.png');
    if (mode === 'approved') args.approvedPaths = Array(4).fill('fake.png');
    if (mode === 'directions') args.directions = ['east', 'east'];
    await assert.rejects(host.generateSpriteScenes(args, controller.signal), /cancelled|Finish sign-in|too large|sprite directions/);
    assert.equal(calls, 0);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
  }
});

test('the real OpenAI account change guard rejects a running sprite generation', () => {
  const featureSource = fs.readFileSync(path.resolve(__dirname, '../src/atlas/agent-features.ts'), 'utf8');
  const parsedFeatures = ts.createSourceFile('features.ts', featureSource, ts.ScriptTarget.Latest, true);
  const names = ['felixOpenAIWorkBusy', 'felixBeginAccountChange'];
  const methods = parsedFeatures.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
  const moduleFixture = { exports: {} };
  const featureCode = ts.transpileModule(methods.map(node => node.getText(parsedFeatures)).join('\n') + '\nmodule.exports={felixOpenAIWorkBusy,felixBeginAccountChange};', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(featureCode, { module: moduleFixture, felixAgentWorking: () => false, felixAccountEvent: () => {} });
  const host = { sessions: new Map(), atlasSpriteGenerationsOpenAI: 1 };
  assert.equal(moduleFixture.exports.felixOpenAIWorkBusy(host), true);
  assert.throws(() => moduleFixture.exports.felixBeginAccountChange(host), /Wait for OpenAI work/);
  host.atlasSpriteGenerationsOpenAI = 0;
  assert.equal(moduleFixture.exports.felixOpenAIWorkBusy(host), false);
  host.atlasSpriteJobs = 1;
  assert.equal(moduleFixture.exports.felixOpenAIWorkBusy(host), true);
  assert.throws(() => moduleFixture.exports.felixBeginAccountChange(host), /Wait for OpenAI work/);
  host.atlasSpriteJobs = 0;
  moduleFixture.exports.felixBeginAccountChange(host);
  assert.equal(host.felixAccountOperation, true);
});

test('OAuth sign-in and sign-out cannot change Claude credentials during sprite preparation', async () => {
  const methods = ['loginOAuth', 'felixLoginOAuthOriginal', 'logoutOAuth'].map(name => hostClass.members.find(node => node.name?.getText(parsed) === name));
  const moduleFixture = { exports: {} };
  const authCode = ts.transpileModule('class AuthHost { atlasSpriteJobs=1; ' + methods.map(method => method.getText(parsed)).join('\n') + ' }; module.exports=AuthHost;', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(authCode, { module: moduleFixture });
  const host = new moduleFixture.exports();
  for (const method of ['loginOAuth', 'felixLoginOAuthOriginal', 'logoutOAuth']) {
    await assert.rejects(host[method]('anthropic'), /Stop or finish Sprite Studio/);
  }
});
