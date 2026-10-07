const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');

const profileModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-profiles.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: profileModule, exports: profileModule.exports });
const promptModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/atlas/sprite-prompt.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: promptModule, exports: promptModule.exports, require: name => {
  if (name === './sprite-profiles') return profileModule.exports;
  throw new Error('Unexpected prompt dependency: ' + name);
} });
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
    ...profileModule.exports,
    MAX_SPRITE_REFERENCE_TOTAL_BYTES: 24 * 1024 * 1024,
    readSpriteReference: async file => { reads.push(file); return { image: { type: 'image', data: 'fixture-original-alpha-png', mimeType: 'image/png' }, bytes: host.referenceBytes ?? 100 }; },
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
    assert.equal(prompt.recipe.palette, undefined);
    assert.equal(prompt.constraints.exactPalette, undefined);
    assert.equal(prompt.constraints.preserveColorIdentity, true);
    assert.match(context.systemPrompt, /There is no preset color restriction/);
    assert.match(context.systemPrompt, /Give shapes explicit fill or stroke/);
    assert.equal(prompt.recipe.drawSize, 1.5);
    assert.equal(prompt.constraints.minimumPadding, 11);
    assert.equal(prompt.recipe.candidates, undefined);
    assert.doesNotMatch(content[0].text, /private|metadata/);
    assert.match(content[3].text, /Saved identity view \(approved or imported artwork\): east.png/);
    assert.equal(content[4].type, 'image');
    assert.equal(content[4].mimeType, 'image/png');
    assert.equal(content[4].data, 'fixture-original-alpha-png');
    return { stopReason: 'stop', content: [{ type: 'text', text: '{"directions":{}}' }] };
  } };
  const result = await host.generateSpriteScenes(args, controller.signal);
  assert.equal(result.response, '{"directions":{}}');
  assert.equal(result.model, 'Fixture model');
  assert.deepEqual(reads, args.referencePaths.concat(args.approvedPaths));
  assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
});

test('a text-only model rejects saved artwork rather than silently generating without its identity', async () => {
  const { host, args, reads } = fixture('anthropic', false);
  let calls = 0; host.modelRuntime = { completeSimple: async () => { calls++; } };
  await assert.rejects(host.generateSpriteScenes(args, new AbortController().signal), /cannot view reference artwork.*image-capable ChatGPT or Claude/);
  assert.equal(calls, 0); assert.equal(reads.length, 0); assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
});

test('a text-only model can draw from a written recipe when there are no saved images', async () => {
  const { host, args, reads } = fixture('anthropic', false);
  args.referencePaths = []; args.approvedPaths = [];
  host.modelRuntime = { completeSimple: async (_model, context) => {
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
    assert.equal(context.messages[0].content.length, 1);
    assert.match(JSON.parse(context.messages[0].content[0].text).referenceAvailability, /No reference images supplied/);
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  } };
  await host.generateSpriteScenes(args, new AbortController().signal);
  assert.equal(reads.length, 0);
});

test('references exceeding the total PNG request budget do not call the provider', async () => {
  const { host, args } = fixture();
  host.referenceBytes = 8 * 1024 * 1024;
  args.referencePaths = Array.from({ length: 4 }, (_, index) => 'C:/safe/master-' + index + '.png'); args.approvedPaths = [];
  let calls = 0; host.modelRuntime = { completeSimple: async () => { calls++; } };
  await assert.rejects(host.generateSpriteScenes(args, new AbortController().signal), /exceed 24 MB/);
  assert.equal(calls, 0); assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
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
    if (mode === 'approved') args.approvedPaths = Array(5).fill('fake.png');
    if (mode === 'directions') args.directions = ['east', 'east'];
    await assert.rejects(host.generateSpriteScenes(args, controller.signal), /cancelled|Finish sign-in|too large|valid asset slots/);
    assert.equal(calls, 0);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
  }
});

test('apparel batches request exact garment-only adult variants and an independent inventory icon', async () => {
  const { host, args } = fixture();
  Object.assign(args.project.recipe, { kind: 'apparel', frameCount: 1, apparelLayer: 'Shell', apparelCoverage: 'full' });
  args.directions = ['item', 'Male_south', 'Female_east', 'Hulk_north'];
  host.modelRuntime = { completeSimple: async (_model, context, options) => {
    const prompt = JSON.parse(context.messages[0].content[0].text);
    assert.equal(prompt.assetProfile.requiredSlots.length, 16);
    assert.deepEqual(Array.from(prompt.requestedDirections), args.directions);
    assert.deepEqual(Array.from(prompt.assetProfile.batchSlots, slot => slot.slot), args.directions);
    assert.equal(prompt.assetProfile.batchSlots[1].bodyType, 'Male');
    assert.equal(prompt.assetProfile.batchSlots[3].bodyType, 'Hulk');
    assert.equal(prompt.recipe.apparelLayer, 'Shell');
    assert.equal(prompt.recipe.apparelCoverage, 'full');
    assert.match(prompt.assetProfile.layerMeaning, /Garment only/);
    assert.match(prompt.assetProfile.westMode, /mirror east/);
    assert.match(context.systemPrompt, /ONLY the GARMENT/);
    assert.match(context.systemPrompt, /no naked body, skin, face, head, mannequin/);
    assert.match(context.systemPrompt, /not a promise of preserving its original pixels/);
    assert.equal(prompt.approximateFitGuides.coordinateCanvas, 256);
    assert.deepEqual(Array.from(prompt.approximateFitGuides.region), [82, 70, 174, 224]);
    assert.equal(prompt.approximateFitGuides.bodyTypeScales.Fat[0], 1.26);
    assert.match(prompt.approximateFitGuides.evidence, /not been visually tested/);
    assert.equal(options.maxTokens, 9000);
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  } };
  await host.generateSpriteScenes(args, new AbortController().signal);
});

test('hat slots draw only headwear while building rotations include an explicit west view', async () => {
  for (const kind of ['hat', 'building', 'furniture']) {
    const { host, args } = fixture();
    Object.assign(args.project.recipe, { kind, frameCount: 1, hatCoverage: 'upper', graphicMode: 'multi', footprintX: 2, footprintZ: 3, drawWidth: 3.2, drawHeight: 4.1 });
    args.directions = kind === 'hat' ? ['item', 'south', 'east', 'north'] : ['south', 'east', 'north', 'west'];
    host.modelRuntime = { completeSimple: async (_model, context) => {
      const prompt = JSON.parse(context.messages[0].content[0].text);
      assert.deepEqual(Array.from(prompt.requestedDirections), args.directions);
      assert.equal(prompt.assetProfile.requiredSlots.length, 4);
      if (kind === 'hat') {
        assert.match(context.systemPrompt, /ONLY the HAT or HELMET/);
        assert.match(context.systemPrompt, /no head, skin, eyes, hair, face, mannequin/);
        assert.match(prompt.assetProfile.layerMeaning, /Headwear only/);
        assert.deepEqual(Array.from(prompt.approximateFitGuides.region), [75, 60, 181, 128]);
      } else {
        assert.equal(prompt.assetProfile.westMode, 'explicit west artwork');
        assert.match(context.systemPrompt, /West MUST be drawn as its own requested view/);
        assert.match(context.systemPrompt, /FootprintX\/Z are occupied game cells/);
        assert.equal(prompt.recipe.footprintX, 2);
        assert.equal(prompt.recipe.footprintZ, 3);
        assert.equal(prompt.recipe.drawWidth, 3.2);
        assert.equal(prompt.recipe.drawHeight, 4.1);
      }
      assert.match(context.systemPrompt, /All non-bird assets return only body/);
      return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
    } };
    await host.generateSpriteScenes(args, new AbortController().signal);
  }
});

test('a single-graphic building requests its main texture and rejects directional or unrelated slots', async () => {
  const { host, args } = fixture();
  Object.assign(args.project.recipe, { kind: 'building', graphicMode: 'single', frameCount: 1 });
  args.directions = ['item'];
  let calls = 0;
  host.modelRuntime = { completeSimple: async (_model, context) => {
    calls++;
    const prompt = JSON.parse(context.messages[0].content[0].text);
    assert.equal(prompt.assetProfile.requiredSlots.length, 1);
    assert.equal(prompt.assetProfile.batchSlots[0].label, 'Main texture');
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  } };
  await host.generateSpriteScenes(args, new AbortController().signal);
  for (const directions of [['south'], ['west'], ['Male_south'], ['item', 'item'], ['item', 'south', 'east', 'north', 'west']]) {
    await assert.rejects(host.generateSpriteScenes({ ...args, directions }, new AbortController().signal), /valid asset slots/);
  }
  assert.equal(calls, 1);
});

test('profile slots are case-sensitive and invalid asset views cannot call a provider', async () => {
  for (const [kind, directions] of [['bird', ['west']], ['sprite', ['item']], ['apparel', ['south']], ['apparel', ['male_south']], ['hat', ['Male_south']], ['hat', ['west']], ['building', ['item']]]) {
    const { host, args } = fixture();
    Object.assign(args.project.recipe, { kind, graphicMode: 'multi' }); args.directions = directions;
    let calls = 0; host.modelRuntime = { completeSimple: async () => { calls++; } };
    await assert.rejects(host.generateSpriteScenes(args, new AbortController().signal), /valid asset slots/);
    assert.equal(calls, 0);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
  }
});

test('four apparel batches retain the family identity and use bounded reference images on the chosen account', async () => {
  const { host, args, reads } = fixture();
  Object.assign(args.project.recipe, { kind: 'apparel', frameCount: 1, apparelCoverage: 'upper' });
  args.referencePaths = Array.from({ length: 6 }, (_, index) => 'C:/safe/master-' + index + '.png');
  args.approvedPaths = Array.from({ length: 4 }, (_, index) => 'C:/safe/approved-' + index + '.png');
  host.atlasSpriteJobs = 1;
  const slots = profileModule.exports.getSpriteSlots(args.project.recipe), seen = [];
  host.modelRuntime = { completeSimple: async (_model, context, options) => {
    assert.equal(host.atlasSpriteJobs, 1);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 1);
    const prompt = JSON.parse(context.messages[0].content[0].text);
    assert.equal(prompt.assetProfile.requiredSlots.length, 16);
    assert.equal(context.messages[0].content.filter(part => part.type === 'image').length, 10);
    assert.equal(options.maxTokens, 9000);
    seen.push(...prompt.requestedDirections);
    return { stopReason: 'stop', content: [{ type: 'text', text: '{}' }] };
  } };
  for (let index = 0; index < slots.length; index += 4) {
    await host.generateSpriteScenes({ ...args, directions: slots.slice(index, index + 4) }, new AbortController().signal);
    assert.equal(host.atlasSpriteGenerationsOpenAI, 0);
    assert.equal(host.atlasSpriteJobs, 1);
  }
  assert.deepEqual(seen, Array.from(slots));
  assert.equal(reads.length, 40);
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
