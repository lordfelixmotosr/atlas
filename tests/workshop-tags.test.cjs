const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('../build-tools/native/node_modules/typescript');
const sourceRoot = path.resolve(__dirname, '../src');

function load(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const localRequire = name => {
    if (name in imports) return imports[name];
    if (name.startsWith('node:')) return require(name);
    throw new Error('Unexpected dependency in test: ' + name);
  };
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
    console, Buffer, process, __dirname: path.join(sourceRoot, path.dirname(file)),
    setTimeout, clearTimeout, ...globals,
  })(localRequire, module, module.exports);
  return module.exports;
}
const tags = load('agent/rimworld/workshop-tags.ts');
const parser = load('agent/registry/about-xml.ts');

test('Steam tags follow About.xml major/minor versions and preserve non-version categories', () => {
  const about = parser.parseAboutXml('<ModMetaData><supportedVersions><li>1.6</li><!-- <li>1.5</li> --><li>1.7.4976</li><li>1.7</li></supportedVersions></ModMetaData>');
  assert.deepEqual(Array.from(tags.workshopTags(about.supportedVersions, ['Mod', '1.5', '1.6', 'Weapons', 'Translation', 'weapons'])),
    ['Mod', 'Weapons', 'Translation', '1.6', '1.7']);
  assert.deepEqual(Array.from(tags.workshopTags(['1.7'], ['Mod', '1.6', 'Quality of Life'])), ['Mod', 'Quality of Life', '1.7']);
  assert.throws(() => tags.workshopTags([]), /supported RimWorld version/);
});

test('Steam tag lookup requests fresh metadata and refuses incomplete results', async () => {
  let request;
  const existing = ['Mod', '1.6', 'Weapons'];
  assert.equal(await tags.readWorkshopTags({ getItem: async (...args) => { request = args; return { tags: existing, tagsTruncated: false }; } }, 123n), existing);
  assert.equal(request[0], 123n);
  assert.equal(request[1].cachedResponseMaxAge, 0);
  for (const item of [null, { tags: existing, tagsTruncated: true }, { tags: 'Mod,1.6', tagsTruncated: false }, { tags: [null], tagsTruncated: false }]) {
    await assert.rejects(tags.readWorkshopTags({ getItem: async () => item }, 123n), /stopped before uploading/);
  }
  await assert.rejects(tags.readWorkshopTags({ getItem: async () => { throw new Error('Offline'); } }, 123n), /existing Workshop tags/);
  await assert.rejects(tags.readWorkshopTags({ getItem: () => new Promise(() => {}) }, 123n, 5), /existing Workshop tags/);
});

test('utility host gets complete tags through the installed SDK API shape', async () => {
  let listener, request;
  const messages = [];
  const parentPort = { on: (_event, callback) => { listener = callback; }, postMessage: msg => messages.push(msg) };
  load('agent/workshop-publish-host.ts', {
    'node:fs': { existsSync: () => true },
    './rimworld/workshop-tags.js': tags,
    fakeSteam: { init: () => ({ workshop: { getItem: async (...args) => { request = args; return { tags: ['Mod', '1.6', 'Weapons'], tagsTruncated: false }; } } }) },
  }, { process: { parentPort, chdir() {} } });
  listener({ data: { id: 1, op: 'init', steamworksModule: 'fakeSteam', appId: 294100, cwd: 'fixture' } });
  listener({ data: { id: 2, op: 'getItemTags', itemId: 123n } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.find(msg => msg.id === 2).ok, true);
  assert.deepEqual(Array.from(messages.find(msg => msg.id === 2).result), ['Mod', '1.6', 'Weapons']);
  assert.equal(request[0], 123n);
  assert.equal(request[1].cachedResponseMaxAge, 0);
});

function publisher(t, { existing = true, failTags = false, versions = ['1.6', '1.7'] } = {}) {
  const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'workshop-tags-'));
  const mod = path.join(root, 'Example'); fs.mkdirSync(path.join(mod, 'About'), { recursive: true });
  const xml = '<ModMetaData><name>Local title</name><description>Local description</description><author>Felix</author><supportedVersions>' + versions.map(v => `<li>${v}</li>`).join('') + '</supportedVersions></ModMetaData>';
  fs.writeFileSync(path.join(mod, 'About/About.xml'), xml);
  if (existing) fs.writeFileSync(path.join(mod, 'About/PublishedFileId.txt'), '123');
  t.after(() => { assert(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const requests = [], uploaded = []; let killed = false, baseline = false;
  class Child extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('spawn')); }
    postMessage(message) {
      requests.push(message);
      queueMicrotask(async () => {
        try {
          let result;
          if (message.op === 'getItemTags') {
            if (failTags) throw new Error('Could not read the existing Workshop tags.');
            result = ['Mod', '1.5', '1.6', 'Weapons'];
          }
          if (message.op === 'createItem') result = { itemId: 456n, needsToAcceptAgreement: false };
          if (message.op === 'updateItem') {
            uploaded.push({ ...message.updateDetails, about: await fsp.readFile(path.join(message.updateDetails.contentPath, 'About/About.xml'), 'utf8') });
          }
          this.emit('message', { id: message.id, ok: true, result });
        } catch (error) { this.emit('message', { id: message.id, ok: false, error: error.message }); }
      });
    }
    kill() { killed = true; this.emit('exit'); }
  }
  const api = load('agent/rimworld/workshop.ts', {
    electron: { app: { isPackaged: false, getPath: () => root }, utilityProcess: { fork: () => new Child() } },
    '../workspace.js': { getWorkspacePaths: () => ({ workspaceDir: root }), readModAbout: async () => parser.parseAboutXml(await fsp.readFile(path.join(mod, 'About/About.xml'), 'utf8')) },
    '../mod-prefs.js': { readModPrefs: async () => ({}), writeModPrefs: async () => {} },
    '../license-file.js': { syncLicenseFile: async () => {} },
    '../licenses.js': { DEFAULT_LICENSE_ID: 'MIT' },
    '../assets/preview-normalize.js': { STEAM_PREVIEW_LIMIT_BYTES: 1024 * 1024 },
    '../assets/workshop-preview.js': { selectWorkshopPreviewPath: () => undefined },
    '../snapshots.js': { commitTurn: async () => {} },
    '../telemetry.js': { track() {} },
    '../../atlas/mod-changes': { collectModInventory: async () => ({}), recordModBaseline: async () => { baseline = true; } },
    './workshop-tags.js': tags,
    'node:os': { tmpdir: () => root },
  });
  return { api, requests, uploaded, killed: () => killed, baseline: () => baseline };
}

test('existing-item publishing uploads 1.7 and retains Steam categories and page edits', async t => {
  const p = publisher(t);
  await p.api.publishToWorkshop('Example', 0, '1.7 compatibility', false);
  assert.equal(p.uploaded.length, 1);
  const update = p.uploaded[0];
  assert.deepEqual(Array.from(update.tags), ['Mod', 'Weapons', '1.6', '1.7']);
  for (const field of ['title', 'description', 'visibility']) assert.equal(Object.hasOwn(update, field), false);
  assert.match(update.about, /<li>1.7<\/li>/);
  assert.equal(update.changeNote, '1.7 compatibility');
  assert.equal(p.requests.some(req => req.op === 'createItem'), false);
  assert.equal(p.baseline(), true); assert.equal(p.killed(), true);
  assert.equal(fs.existsSync(update.contentPath), false);
});

test('first publishing still sets tags and initial page metadata without an existing-tag lookup', async t => {
  const p = publisher(t, { existing: false, versions: ['1.7'] });
  const result = await p.api.publishToWorkshop('Example', 2, '', false);
  const update = p.uploaded[0];
  assert.deepEqual(Array.from(update.tags), ['Mod', '1.7']);
  assert.equal(update.title, 'Local title'); assert.equal(update.description, 'Local description'); assert.equal(update.visibility, 2);
  assert.equal(result.itemId, '456');
  assert.equal(p.requests.some(req => req.op === 'getItemTags'), false);
  assert.equal(p.killed(), true);
});

test('an unavailable tag lookup prevents uploading and recording a publish baseline', async t => {
  const p = publisher(t, { failTags: true });
  await assert.rejects(p.api.publishToWorkshop('Example', 0, '', false), /existing Workshop tags/);
  assert.equal(p.uploaded.length, 0); assert.equal(p.baseline(), false); assert.equal(p.killed(), true);
});

test('missing supported versions cannot create a Workshop item or clear its version tags', async t => {
  const p = publisher(t, { existing: false, versions: [] });
  await assert.rejects(p.api.publishToWorkshop('Example', 0, '', false), /supported RimWorld version/);
  assert.equal(p.requests.length, 0); assert.equal(p.uploaded.length, 0); assert.equal(p.baseline(), false);
});
