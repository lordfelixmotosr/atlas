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
const release = load('agent/rimworld/release-package.ts', {'fast-xml-parser': require('fast-xml-parser')});
const parser = load('agent/registry/about-xml.ts');
const metadata=load('agent/mod-metadata.ts');
const verification=load('agent/rimworld/workshop-verification.ts',{'../mod-metadata.js':metadata,'./release-package.js':release});
const buildState=load('agent/rimworld/build-state.ts',{'../mod-metadata.js':metadata,'./release-package.js':release});

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
    './rimworld/workshop-verification.js':verification,
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

function publisher(t, { existing = true, failTags = false, versions = ['1.6', '1.7'], failDownload = false, gameRunning = false, downloadMismatch = false, subscribed = true, failState = false } = {}) {
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
          if(message.op==='downloadItem') {if(failDownload)throw new Error('Steam is offline');result=path.join(root,'steamapps/workshop/content/294100',existing?'123':'456');fs.mkdirSync(path.dirname(result),{recursive:true});await fsp.cp(uploaded[0].snapshot,result,{recursive:true});if(downloadMismatch)fs.mkdirSync(path.join(result,'Source'));}
          if(message.op==='downloadState'){if(failState)throw new Error('Subscription unavailable');result=subscribed?5:4;}
          if (message.op === 'updateItem') {
            const files = [];
            const walk = async (dir, prefix = '') => {for (const e of await fsp.readdir(dir, {withFileTypes:true})) {if(e.isDirectory()) await walk(path.join(dir,e.name),prefix+e.name+'/');else files.push(prefix+e.name);}};
            await walk(message.updateDetails.contentPath);
            const snapshot=path.join(root,'uploaded-snapshot');await fsp.cp(message.updateDetails.contentPath,snapshot,{recursive:true});
            uploaded.push({ ...message.updateDetails, snapshot, files, publishedId: await fsp.readFile(path.join(message.updateDetails.contentPath,'About/PublishedFileId.txt'),'utf8'), about: await fsp.readFile(path.join(message.updateDetails.contentPath, 'About/About.xml'), 'utf8') });
          }
          this.emit('message', { id: message.id, ok: true, result });
        } catch (error) { this.emit('message', { id: message.id, ok: false, error: error.message }); }
      });
    }
    kill() { killed = true; this.emit('exit'); }
  }
  const api = load('agent/rimworld/workshop.ts', {
    electron: { app: { isPackaged: false, getPath: () => root }, utilityProcess: { fork: () => new Child() } },
    '../workspace.js': { getWorkspacePaths: () => ({ workspaceDir: root }), getMirrorStateDir: () => path.join(root, 'mirror-state'), getRimWorldModsDir: () => path.join(root, 'gameMods'), readModAbout: async () => parser.parseAboutXml(await fsp.readFile(path.join(mod, 'About/About.xml'), 'utf8')) },
    '../mod-prefs.js': { readModPrefs: async () => ({}), writeModPrefs: async () => {} },
    '../license-file.js': { syncLicenseFile: async () => {} },
    '../licenses.js': { DEFAULT_LICENSE_ID: 'MIT' },
    '../assets/preview-normalize.js': { STEAM_PREVIEW_LIMIT_BYTES: 1024 * 1024 },
    '../assets/workshop-preview.js': { selectWorkshopPreviewPath: () => undefined },
    '../snapshots.js': { commitTurn: async () => {} },
    '../telemetry.js': { track() {} },
    '../../atlas/mod-changes': { collectModInventory: async () => ({files:{},signature:'fixture',modifiedAt:0}), mergePublishedInventory: (a,b) => b, recordModBaseline: async () => { baseline = true; } },
    './workshop-tags.js': tags,
    './release-package.js': release,
    './runtime-mirror.js': {reconcileMirrorId: async () => false},
    './build-state.js':buildState,
    './workshop-verification.js':verification,
    './game.js':{isRimWorldRunning:async()=>gameRunning},
    '../mod-events.js':{emitModChanged:()=>{}},
    '../license-text.js': {renderLicenseText: () => null},
    'node:os': { tmpdir: () => root },
  });
  return { api, mod, requests, uploaded, killed: () => killed, baseline: () => baseline };
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

test('actual Steam payload contains only planned runtime files and a freshly created Workshop ID', async t => {
  const p = publisher(t, {existing:false});
  for(const [name,content] of Object.entries({'Source/Secret.cs':'private','Tests/Test.xml':'private','Tools/Build.ps1':'private','ArtSources/master.psd':'private','.atlas/release.json':'{"include":["World"]}','World/Planet.xml':'runtime','Defs/Thing.xml':'runtime','Assemblies/Mod.dll':'runtime','Assemblies/Mod.pdb':'debug','Assets.zip.001':'private'})){
    const file=path.join(p.mod,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);
  }
  const dry=await p.api.dryRunWorkshop('Example');assert.equal(dry.valid,true);assert.equal(p.requests.length,0);assert(dry.files.some(f=>f.path==='World/Planet.xml'));
  await p.api.publishToWorkshop('Example',2,'',false);
  const files=p.uploaded[0].files;
  assert(files.includes('World/Planet.xml'));assert(files.includes('Assemblies/Mod.dll'));assert.equal(p.uploaded[0].publishedId,'456');
  assert(!files.some(f=>release.isDevelopmentPath(f)));assert.equal(fs.readFileSync(path.join(p.mod,'Source/Secret.cs'),'utf8'),'private');
});

test('a stray DLL blocks publishing before any Steam initialization or item creation', async t => {
  const p=publisher(t,{existing:false});
  fs.mkdirSync(path.join(p.mod,'Common'));fs.writeFileSync(path.join(p.mod,'Common/stray.dll'),'stray');
  const dry=await p.api.dryRunWorkshop('Example');assert.equal(dry.valid,false);
  await assert.rejects(p.api.publishToWorkshop('Example',0,'',false),/Stray DLL/);
  assert.equal(p.requests.length,0);assert.equal(p.uploaded.length,0);assert(!fs.existsSync(path.join(p.mod,'About/PublishedFileId.txt')));
});


test('post-publish verification compares Steam bytes with the saved upload manifest',async t=>{const p=publisher(t);const result=await p.api.publishToWorkshop('Example',0,'verify',false);assert.equal(result.verification.status,'verified');const status=await p.api.getWorkshopReleaseStatus('Example');assert.equal(status.release.verification.status,'verified');assert.equal(status.release.itemId,'123');});
test('publishing an unsubscribed mod does not create a second Steam download',async t=>{
 const p=publisher(t,{subscribed:false});const result=await p.api.publishToWorkshop('Example',0,'verify',false);
 assert.equal(result.verification.status,'pending');assert.equal(result.verification.downloadRequired,true);assert.equal(p.uploaded.length,1);assert.equal(p.baseline(),true);assert.equal(p.killed(),true);
 assert(!p.requests.some(r=>r.op==='downloadItem'));assert(!fs.existsSync(path.join(p.mod,'../steamapps')));
 const retry=await p.api.verifyWorkshopRelease('Example');assert.equal(retry.downloadRequired,true);assert(!p.requests.some(r=>r.op==='downloadItem'));
 const automatic=await p.api.verifyWorkshopRelease('Example',true,true);assert.equal(automatic.downloadRequired,true);assert(!p.requests.some(r=>r.op==='downloadItem'));
 const consent=await p.api.verifyWorkshopRelease('Example',false,true);assert.equal(consent.status,'verified');assert.equal(p.requests.filter(r=>r.op==='downloadItem').length,1);
});
test('a failed subscription check never starts a verification download or fails the upload',async t=>{
 const p=publisher(t,{failState:true});const result=await p.api.publishToWorkshop('Example',0,'verify',false);
 assert.equal(result.verification.status,'unavailable');assert.equal(p.uploaded.length,1);assert.equal(p.baseline(),true);assert(!p.requests.some(r=>r.op==='downloadItem'));assert.equal(p.killed(),true);
});
test('download failure keeps upload success and its baseline, with a retryable result',async t=>{const p=publisher(t,{failDownload:true});const result=await p.api.publishToWorkshop('Example',0,'verify',false);assert.equal(result.verification.status,'unavailable');assert.equal(p.uploaded.length,1);assert.equal(p.baseline(),true);assert.equal(p.killed(),true);});
test('actual development leftovers in the Steam copy fail verification',async t=>{const p=publisher(t,{downloadMismatch:true});const result=await p.api.publishToWorkshop('Example',0,'verify',false);assert.equal(result.verification.status,'mismatch');assert(result.verification.unexpected.includes('Source/'));});
test('a running game defers download verification without cancelling the successful upload',async t=>{const p=publisher(t,{gameRunning:true});const result=await p.api.publishToWorkshop('Example',0,'verify',false);assert.equal(result.verification.status,'pending');assert.equal(p.requests.some(r=>r.op==='downloadItem'),false);assert.equal(p.baseline(),true);});

test('an older upload record cannot verify a newer successful publication',async t=>{const p=publisher(t);await p.api.publishToWorkshop('Example',0,'latest',false);const file=path.join(p.mod,'.atlas/published-runtime.json'),receipt=JSON.parse(fs.readFileSync(file));receipt.uploadedAt-=10000;fs.writeFileSync(file,JSON.stringify(receipt));assert.equal((await p.api.getWorkshopReleaseStatus('Example')).release,null);await assert.rejects(p.api.verifyWorkshopRelease('Example'),/No recorded Atlas upload/);});
