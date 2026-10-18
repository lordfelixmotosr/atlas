const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('../build-tools/native/node_modules/typescript');
const source = path.resolve(__dirname, '../src');
function loader(stubs = new Map()) {
  const cache = new Map();
  function load(file) {
    const full = path.resolve(source, file);
    if (stubs.has(full)) return stubs.get(full);
    if (cache.has(full)) return cache.get(full).exports;
    const module = { exports: {} }; cache.set(full, module);
    const code = ts.transpileModule(fs.readFileSync(full, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const local = id => stubs.has(id) ? stubs.get(id) : id.startsWith('.') ? load(path.resolve(path.dirname(full), id.replace(/\.js$/, '.ts'))) : require(id);
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', { console, Buffer, process, Map, Set, Date, setTimeout, clearTimeout })(local, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = loader(), paths = load('agent/paths.ts'), runtime = load('agent/rimworld/runtime.ts');
const base = path.resolve(__dirname, '../build-check/fixtures'); fs.mkdirSync(base, { recursive: true });
function fixture(t, engine, version, platform = 'win32') {
  const root = fs.mkdtempSync(path.join(base, 'runtime-'));
  t.after(() => { assert(root.startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const dir = engine === 'waylith' ? root : path.join(root, platform === 'linux' ? 'RimWorldLinux_Data/Managed' : 'RimWorldWin64_Data/Managed');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(root, 'Data/Core/Defs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Version.txt'), version);
  fs.writeFileSync(path.join(root, platform === 'linux' ? (engine === 'waylith' ? 'RimWorld' : 'RimWorldLinux') : (engine === 'waylith' ? 'RimWorld.exe' : 'RimWorldWin64.exe')), '');
  const names = engine === 'waylith' ? ['Assembly-CSharp', 'Waylith', 'UnityStubs', 'Waylith.UnityCompat'] : ['Assembly-CSharp', 'UnityEngine', 'UnityEngine.CoreModule'];
  for (const name of names) fs.writeFileSync(path.join(dir, name + '.dll'), '');
  if (engine === 'waylith') fs.writeFileSync(path.join(root, 'RimWorld.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { tfm: 'net10.0' } }));
  return { root, dir };
}
test('1.6 and 1.7 resolve assemblies, executable, mods and Data from the same installation', t => {
  for (const platform of ['win32', 'linux']) for (const engine of ['unity', 'waylith']) {
    const { root, dir } = fixture(t, engine, engine === 'waylith' ? '1.7.4976 rev1043' : '1.6.4850 rev1', platform);
    const result = paths.inspectRimWorldInstall(root, platform);
    assert.equal(result.managedDir, dir); assert.equal(result.installRoot, root); assert.equal(result.engine, engine);
    assert.equal(result.modsDir, path.join(root, 'Mods')); assert.equal(result.dataDir, path.join(root, 'Data')); assert(fs.existsSync(result.executable));
  }
});
test('Waylith wins over a stale Unity directory and configuration version', t => {
  const { root } = fixture(t, 'waylith', '1.7.4976');
  fs.mkdirSync(path.join(root, 'RimWorldWin64_Data/Managed'), { recursive: true }); fs.writeFileSync(path.join(root, 'RimWorldWin64_Data/Managed/Assembly-CSharp.dll'), '');
  paths.setRimWorldInstallOverride(root); t.after(() => paths.setRimWorldInstallOverride(null));
  assert.equal(paths.detectRimWorldPaths().managedDir, root);
  assert.equal(paths.detectGameVersionMajorMinorSync(), '1.7');
  fs.writeFileSync(path.join(root, 'Version.txt'), '1.7.5000'); assert.equal(paths.detectRimWorldPaths().version, '1.7.5000');
});
test('existing 1.6 macOS bundle detection is preserved', t => {
  const { root } = fixture(t, 'unity', '1.6.4850');
  const bundle = path.join(root, 'RimWorldMac.app'), dir = path.join(bundle, 'Contents/Resources/Data/Managed');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Assembly-CSharp.dll'), '');
  fs.writeFileSync(path.join(bundle, 'Contents/Info.plist'), '<key>CFBundleExecutable</key><string>RimWorld by Ludeon Studios</string>');
  fs.writeFileSync(path.join(bundle, 'Contents/MacOS/RimWorld by Ludeon Studios'), '');
  const result = paths.inspectRimWorldInstall(bundle, 'darwin'); assert.equal(result.managedDir, dir); assert.equal(result.modsDir, path.join(bundle, 'Mods')); assert(result.executable.endsWith('RimWorld by Ludeon Studios'));
});
test('scaffolds target actual runtime, reference existing DLLs, escape paths and do not copy game assemblies', async t => {
  for (const engine of ['unity', 'waylith']) {
    const { root, dir } = fixture(t, engine, engine === 'unity' ? '1.6.4850' : '1.7.4976');
    const mod = path.join(root, 'Mod & Example');
    await load('agent/rimworld/scaffold.ts').layRimworldCSharpScaffold(mod, { managedDir: dir, assemblyName: 'AtlasSmoke' });
    const xml = fs.readFileSync(path.join(mod, 'Source/AtlasSmoke.csproj'), 'utf8');
    assert(xml.includes('<TargetFramework>' + (engine === 'unity' ? 'net472' : 'net10.0') + '</TargetFramework>'));
    assert.equal(xml.includes('Microsoft.NETFramework.ReferenceAssemblies'), engine === 'unity');
    assert.equal(xml.includes('UnityStubs'), engine === 'waylith');
    assert.equal(xml.includes('UnityEngine.CoreModule'), engine === 'unity');
    assert(!xml.includes('<Private>true</Private>'));
    fs.writeFileSync(path.join(mod, 'Source/Mod.cs'), '// custom code');
    await load('agent/rimworld/scaffold.ts').layRimworldCSharpScaffold(mod, { managedDir: dir, assemblyName: 'AtlasSmoke' });
    assert.equal(fs.readFileSync(path.join(mod, 'Source/Mod.cs'), 'utf8'), '// custom code');
  }
  assert(runtime.escapeProjectXml('C:/Rim & World/Mod').includes('&amp;'));
});
test('damaged Waylith config fails clearly rather than silently targeting Unity', t => {
  const { root } = fixture(t, 'waylith', '1.7'); fs.writeFileSync(path.join(root, 'RimWorld.runtimeconfig.json'), '{broken');
  assert.throws(() => runtime.inspectRimWorldRuntime(root), /Verify the game files/);
});
test('framework diagnostics follow the selected runtime', async t => {
  const { root } = fixture(t, 'waylith', '1.7'); fs.mkdirSync(path.join(root, 'Source')); fs.writeFileSync(path.join(root, 'Source/Old.csproj'), '<Project><TargetFramework>net472</TargetFramework></Project>');
  const { lintMod } = load('agent/build-lint.ts');
  assert((await lintMod(root, 'net10.0')).some(f => f.rule === 'wrong-target-framework' && f.message.includes('net10.0')));
  assert(!(await lintMod(root, 'net472')).some(f => f.rule === 'wrong-target-framework'));
});
test('Windows launcher recognizes both games and passes the isolated profile to the selected Waylith executable', async () => {
  let stdout = '', launched, refreshes = 0, failRefresh = false;
  const game = loader(new Map([
    ['node:os', { platform: () => 'win32' }],
    ['node:child_process', { exec: (_command, _options, cb) => cb(null, stdout, ''), spawn: (file, args, options) => { launched = { file, args, options }; return { unref() {} }; } }],
    [path.join(source, 'agent/paths.ts'), { detectRimWorldPaths: () => ({ executable: 'C:/Games/RimWorld/RimWorld.exe', engine: 'waylith' }) }],
    [path.join(source, 'agent/workspace.ts'), {refreshSyncedRuntimeMirrors: async () => {refreshes++;if(failRefresh)throw Error('Mirror DLL locked');}}], [path.join(source, 'agent/registry/index.ts'), {}],
  ]))('agent/rimworld/game.ts');
  for (const name of ['RimWorld.exe', 'RimWorldWin64.exe']) { stdout = '"' + name + '","123"'; assert.equal(await game.isRimWorldRunning(), true); }
  stdout = '"steam.exe","123"';
  await game.launchRimWorld({ savedataFolder: 'C:/Test profile', args: ['-quicktest'] });
  assert.equal(launched.file, 'C:/Games/RimWorld/RimWorld.exe');
  assert.deepEqual(Array.from(launched.args), ['-savedatafolder=C:/Test profile', '-quicktest']);
  assert.equal(launched.options.env.SteamAppId, '294100');
  await game.launchRimWorld(); assert.equal(launched.file, 'C:/Games/RimWorld/RimWorld.exe');
  assert.equal(refreshes,2);
  launched=null;failRefresh=true;
  await assert.rejects(game.launchRimWorld(),/Mirror DLL locked/);assert.equal(launched,null);
});
