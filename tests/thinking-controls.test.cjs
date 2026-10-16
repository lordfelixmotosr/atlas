const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const ts = require('../build-tools/native/node_modules/typescript');
const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const sdkPath = file => pathToFileURL(path.join(root, 'node_modules/@earendil-works/pi-ai/dist', file)).href;
let sdk, thinking, labels;

function load(file, imports = {}) {
  const module = {exports: {}};
  const output = ts.transpileModule(fs.readFileSync(path.join(root, 'src', file), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
    fileName: file,
  }).outputText;
  vm.runInNewContext('(function(require,module,exports){' + output + '\n})', {console})(id => {
    if (id in imports) return imports[id];
    if (id.startsWith('node:') || id.startsWith('react')) return require(id);
    throw Error('Unexpected import: ' + id);
  }, module, module.exports);
  return module.exports;
}
const seed = JSON.parse(fs.readFileSync(path.join(root, 'scripts/atlas/inputs/default-models.json')));
const gpt = {...seed.providers['openai-codex'].models[0], provider: 'openai-codex'};
const claude = {...seed.providers.anthropic.models[0], provider: 'anthropic'};
test.before(async () => {
  sdk = await import(sdkPath('models.js'));
  labels = load('lib/thinking-levels.ts');
  thinking = load('agent/thinking.ts', {'@earendil-works/pi-ai': sdk, '../lib/thinking-levels.js': labels});
});

test('native Max and Extra High remain distinct for GPT and Claude without mutating catalog entries', () => {
  for (const model of [gpt, claude]) {
    const before = JSON.stringify(model);
    for (const level of ['max', 'xhigh', 'high', 'xhigh', 'max']) {
      const resolved = thinking.toPiThinking(model, level);
      assert.equal(resolved.level, level);
      assert.equal(resolved.model, model);
      assert.equal(sdk.clampThinkingLevel(resolved.model, resolved.level), level);
    }
    assert.equal(JSON.stringify(model), before);
  }
});

test('model switches preserve requested preferences and expose effective fallbacks', () => {
  const saved = {thinkingLevel: 'max', openaiSpeed: 'standard'};
  const legacy = {...gpt, id: 'legacy', thinkingLevelMap: {minimal: 'low', xhigh: 'xhigh'}};
  const budgetClaude = {...claude, compat: {}, thinkingLevelMap: {}};
  assert.equal(thinking.toPiThinking(legacy, saved.thinkingLevel).level, 'xhigh');
  assert.equal(thinking.toPiThinking(budgetClaude, saved.thinkingLevel).level, 'high');
  assert.equal(thinking.toPiThinking(gpt, saved.thinkingLevel).level, 'max');
  assert.deepEqual(saved, {thinkingLevel: 'max', openaiSpeed: 'standard'});
  assert.equal(thinking.thinkingCapabilities(legacy).effectiveLevels.max, 'xhigh');
});

test('choices follow model metadata, hide duplicate aliases and preserve legacy saved values', () => {
  const gptCaps = thinking.thinkingCapabilities(gpt);
  assert.deepEqual(plain(gptCaps.levels), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(gptCaps.effectiveLevels.minimal, 'low');
  const caps = thinking.thinkingCapabilities(claude);
  assert(!caps.levels.includes('off'));
  assert(!caps.levels.includes('minimal'));
  assert.equal(caps.effectiveLevels.off, 'low');
  const nonReasoning = thinking.thinkingCapabilities({...gpt, reasoning: false});
  assert.deepEqual(plain(nonReasoning.levels), ['off']);
  assert.equal(nonReasoning.effectiveLevels.max, 'off');
});

test('saved unsupported effort is labelled explicitly; rendering never saves a preference', () => {
  const React = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const {ThinkingPicker} = load('components/thinking-picker.tsx', {'../lib/thinking-levels': labels});
  const legacy = {...gpt, thinkingLevelMap: {xhigh: 'xhigh'}};
  const option = {key: 'openai-codex/legacy', provider: 'openai-codex', modelId: 'legacy', thinking: thinking.thinkingCapabilities(legacy)};
  let saves = 0;
  const render = (models, model) => renderToStaticMarkup(React.createElement(ThinkingPicker, {current: 'max', models, model, onChange: () => saves++}));
  const html = render([option], option);
  assert.match(html, /Thinking: Max \(uses Extra High\)/);
  assert.match(html, /value="max"[^>]*disabled=""[^>]*selected=""|value="max"[^>]*selected=""[^>]*disabled=""/);
  assert.match(render([], option), /Thinking: Max \(saved\)/);
  assert.equal(saves, 0);
});

test('actual provider request builders send native Max and unchanged Extra High, with no network calls', async () => {
  const context = {systemPrompt: 'Fixture only.', messages: [{role: 'user', content: 'Fixture', timestamp: 1}]};
  const token = 'fixture.' + Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'fixture'}})).toString('base64url') + '.fixture';
  const originalFetch = global.fetch;
  global.fetch = () => { throw Error('Network forbidden in thinking test'); };
  try {
    for (const [model, adapterFile, apiKey] of [[gpt, 'api/openai-codex-responses.js', token], [claude, 'api/anthropic-messages.js', 'fixture-key']]) {
      const adapter = await import(sdkPath(adapterFile));
      for (const level of ['max', 'xhigh', 'high']) {
        const choice = thinking.toPiThinking(model, level);
        let body;
        const stream = adapter.streamSimple(choice.model, context, {
          apiKey, reasoning: choice.level, transport: 'sse',
          onPayload: payload => { body = payload; throw Error('Fixture captured before network'); },
        });
        const result = await stream.result();
        assert(body, result.errorMessage);
        assert.equal(model === gpt ? body.reasoning.effort : body.output_config.effort, level);
        assert.match(result.errorMessage, /Fixture captured before network/);
      }
    }
  } finally { global.fetch = originalFetch; }
});

test('Codex Off explicitly sends none while preserving callbacks and other payload options', async () => {
  let payload, calls = 0;
  const stream = async (model, context, options) => { payload = await options.onPayload({model: model.id, reasoning: {summary: 'auto'}}, model); };
  await thinking.withThinkingControls(stream)(gpt, {}, {onPayload: body => {calls++; return {...body, service_tier: 'default'};}});
  assert.equal(payload.reasoning.effort, 'none');
  assert.equal(payload.reasoning.summary, 'auto');
  assert.equal(payload.service_tier, 'default');
  assert.equal(calls, 1);
  let forwarded;
  const passthrough = thinking.withThinkingControls((_m, _c, options) => {forwarded = options;});
  const settings = {reasoning: 'xhigh', serviceTier: 'priority'};
  passthrough(gpt, {}, settings);
  assert.equal(forwarded, settings);
  passthrough(claude, {}, settings);
  assert.equal(forwarded, settings);
});

test('refreshed RimWorld prompt requires targeted source checks and verification without changing user instructions', () => {
  const imports = {
    './rimworld/runtime.js': {inspectRimWorldRuntime: () => {throw Error('Not needed');}},
    '@earendil-works/pi-coding-agent': {formatSkillsForPrompt: () => ''},
    './paths.js': {detectRimWorldPaths: () => ({modsDir: 'C:/game/Mods', managedDir: null}), detectGameVersionMajorMinorSync: () => '1.7'},
    './user-config.js': {readUserInstructionsSync: () => 'Keep my chosen thinking settings.', discoverUserSkillsSync: () => []},
    './workspace.js': {getWorkspacePaths: () => ({workspaceDir: 'C:/fixture/Mods'})},
    './settings.js': {loadSettings: () => ({defaultAuthor: 'Felix', autoLaunch: false})},
    './lore.js': {buildIndexSync: () => [], loreTopics: () => []},
    './cookbook.js': {buildCookbookCatalogueSync: () => []},
    './schematic.js': {readSchematicSync: () => null},
    './games/registry.js': {resolveGameId: () => 'rimworld'},
    './adapters/index.js': {}, './minecraft/versions.js': {},
  };
  const prompt = load('agent/system-prompt.ts', imports);
  const text = prompt.buildRimworldSystemPrompt({type: 'new'});
  assert.equal(prompt.PROMPT_VERSION, 3);
  assert.match(text, /operating inside Atlas/);
  assert.match(text, /verify unfamiliar Def fields/);
  assert.match(text, /run build_mod, read the diagnostics/);
  assert.match(text, /Keep my chosen thinking settings/);
  assert.doesNotMatch(text, /half-right code|~5 read-only|write.*speculatively/);
});
