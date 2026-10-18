const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {spawn} = require('node:child_process');
const ts = require('../build-tools/native/node_modules/typescript');
function load(file, imports = {}) {
  const module = {exports:{}};
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+code+'\n})', {console,process,Buffer,setTimeout,clearTimeout})(id=>{
    if(id in imports)return imports[id];
    if(id.startsWith('node:'))return require(id);
    throw Error('Unexpected dependency '+id);
  },module,module.exports);
  return module.exports;
}
const release = load('agent/rimworld/release-package.ts', {'fast-xml-parser':require('fast-xml-parser')});
const mirrors = load('agent/rimworld/runtime-mirror.ts', {'./release-package.js':release});
const base = path.resolve(__dirname,'../build-check/fixtures');
function fixture(t) {
  fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'release-')),source=path.join(root,'workspace','Example'),target=path.join(root,'Mods','Example'),state=path.join(root,'profile','runtime-mirrors');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const write=(p,data='fixture')=>{const f=path.join(source,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);};
  write('About/About.xml','<ModMetaData><name>Fixture</name><packageId>atlas.release.fixture</packageId><supportedVersions><li>1.6</li><li>1.7</li></supportedVersions></ModMetaData>');
  t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  return {root,source,target,state,write};
}

test('copies the union of every version and conditional folder, keeping identical load content and XML',async t=>{
  const f=fixture(t);
  const xml='<loadFolders><!-- do not rewrite condition order --><v1.4><li>Common</li><li>1.4</li></v1.4><v1.5><li>Common</li><li>1.5</li></v1.5><v1.6><li>Common</li><li>1.6</li><li IfModActive="some.mod">Compat/WithMod</li></v1.6><v1.7><li>Common</li><li>1.7</li><li IfModNotActive="some.mod">Compat/WithoutMod</li></v1.7></loadFolders>';
  f.write('LoadFolders.xml',xml);
  for(const v of ['1.4','1.5','1.6','1.7']){f.write(v+'/Defs/Duplicate.xml','<Defs><ThingDef><defName>Variant</defName><label>'+v+'</label></ThingDef></Defs>');f.write(v+'/Assemblies/Mod.dll','runtime-'+v);f.write(v+'/Assemblies/Mod.pdb','debug');f.write(v+'/Source/Private.cs','private');}
  f.write('Common/Textures/shared.png','runtime');f.write('Compat/WithMod/Defs/Compat.xml','conditional-on');f.write('Compat/WithoutMod/Defs/Compat.xml','conditional-off');
  f.write('Source/Project.csproj');f.write('Tests/Fixture.xml');f.write('Tools/Build.ps1');f.write('ArtSources/master.psd');f.write('.atlas/schematic.json');f.write('.git/config');
  f.write('1.7/Textures/OBJ/private.png');f.write('1.7/Assemblies/Mod.deps.json');f.write('1.7/Assets.zip.001');f.write('Common/Stray.cs');
  const plan=await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(plan.valid,true);
  assert.equal((await fsp.lstat(f.target)).isSymbolicLink(),false);
  assert.equal(await fsp.readFile(path.join(f.target,'LoadFolders.xml'),'utf8'),xml);
  assert.deepEqual(Array.from(plan.versions,v=>v.version),['1.4','1.5','1.6','1.7']);
  // For every listed version, preserve ordered overriding content and all
  // conditional branches. Matching all branch bytes covers any active-mod set.
  for(const version of plan.versions) for(const folder of version.folders) {
    const files=plan.files.filter(p=>p.path.startsWith(folder+'/'));
    assert(files.length>0,'Missing load folder '+folder);
    for(const file of files)assert.equal(await release.fileSha(path.join(f.source,file.path)),await release.fileSha(path.join(f.target,file.path)));
  }
  assert(!plan.files.some(p=>release.isDevelopmentPath(p.path)));
  for(const p of ['Source','Tests','Tools','ArtSources','.atlas','.git','1.7/Assemblies/Mod.pdb','1.7/Assemblies/Mod.deps.json','1.7/Textures/OBJ','1.7/Assets.zip.001','Common/Stray.cs'])assert.equal(fs.existsSync(path.join(f.target,p)),false,p);
});

test('unknown root folders warn; explicit extras retain path-based runtime data and empty load folders',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml');f.write('World/Planet.xml');f.write('ArtSources/master.psd');
  let plan=await release.planRelease(f.source);
  assert.equal(plan.valid,true);assert(plan.warnings.some(w=>w.includes('World/')));assert(!plan.files.some(p=>p.path.startsWith('World/')));
  f.write('.atlas/release.json',JSON.stringify({include:['World']}));f.write('LoadFolders.xml','<loadFolders><v1.6><li>/</li></v1.6><v1.7><li>EmptyVersion</li></v1.7></loadFolders>');fs.mkdirSync(path.join(f.source,'EmptyVersion'));
  plan=await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(fs.readFileSync(path.join(f.target,'World/Planet.xml'),'utf8'),'fixture');
  assert(fs.statSync(path.join(f.target,'EmptyVersion')).isDirectory());
  assert.equal(plan.unknownRootFolders.includes('World'),false);assert.equal(fs.existsSync(path.join(f.target,'.atlas')),false);
});

test('malformed manifests, escapes, forbidden explicit includes and stray DLLs block a release',async t=>{
  const f=fixture(t);f.write('LoadFolders.xml','<loadFolders><v1.7><li>Runtime</li></v1.7></loadFolders>');f.write('Runtime/Defs/Main.xml');f.write('Runtime/random.dll');
  let plan=await release.planRelease(f.source);assert.equal(plan.valid,false);assert(plan.errors.some(e=>e.includes('Stray DLL')));
  f.write('.atlas/release.json',JSON.stringify({allowDlls:['Runtime/random.dll']}));assert.equal((await release.planRelease(f.source)).valid,true);
  for(const manifest of [{include:['../outside']},{include:['Source']},{allowDlls:['Tools/native.dll']},{includes:['World']},{include:'World'}]){
    f.write('.atlas/release.json',JSON.stringify(manifest));assert.equal((await release.planRelease(f.source)).valid,false,JSON.stringify(manifest));
  }
  f.write('.atlas/release.json','{}');
  for(const bad of ['<loadFolders><v1.7><li>../outside</li></v1.7></loadFolders>','<loadFolders><v1.7><li>C:/other</li></v1.7></loadFolders>','<loadFolders><v1.7><li>Source</li></v1.7></loadFolders>','<loadFolders><v1.7>']){
    f.write('LoadFolders.xml',bad);assert.equal((await release.planRelease(f.source)).valid,false,bad);
  }
});

test('default load folders and generated licenses are previewed without modifying the workspace',async t=>{
  const f=fixture(t);f.write('LoadFolders.xml','<loadFolders><default><li>Shared</li></default><v1.7><li>Shared</li><li>1.7</li></v1.7></loadFolders>');f.write('Shared/Defs/Common.xml');f.write('1.7/Defs/Current.xml');
  const plan=await release.planRelease(f.source,{LICENSE:'generated license'});
  assert.equal(plan.valid,true);assert.equal(plan.versions[0].version,'default');assert.equal(plan.files.find(x=>x.path==='LICENSE').bytes,17);assert(!fs.existsSync(path.join(f.source,'LICENSE')));
});

test('game and engine assemblies cannot be shipped even from Assemblies or an explicit DLL allowlist',async t=>{
  const f=fixture(t);f.write('Assemblies/Assembly-CSharp.dll','game code');f.write('.atlas/release.json','{"allowDlls":["Assemblies/Assembly-CSharp.dll"]}');
  const plan=await release.planRelease(f.source);assert.equal(plan.valid,false);assert(plan.errors.some(e=>e.includes('Assembly-CSharp.dll')));
});

test('audit catches injected development files, unexpected DLLs and changed bytes',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml');const plan=await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const bad=path.join(f.target,'Tests');fs.mkdirSync(bad);fs.writeFileSync(path.join(bad,'hidden.txt'),'private');
  await assert.rejects(release.auditRelease(f.target,plan),/Development/);fs.rmSync(bad,{recursive:true});
  fs.writeFileSync(path.join(f.target,'stray.dll'),'stray');await assert.rejects(release.auditRelease(f.target,plan),/Unexpected|Stray/);fs.unlinkSync(path.join(f.target,'stray.dll'));
  fs.writeFileSync(path.join(f.target,'Defs/Main.xml'),'changed');await assert.rejects(release.auditRelease(f.target,plan),/changed during staging/);
});

test('refresh copies edits and removes stale files while keeping development work private',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');f.write('Textures/Old.png');f.write('Source/Code.cs','keep me');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');fs.unlinkSync(path.join(f.source,'Textures/Old.png'));f.write('Textures/New.png');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');assert(!fs.existsSync(path.join(f.target,'Textures/Old.png')));assert(fs.existsSync(path.join(f.target,'Textures/New.png')));
  assert.equal(fs.readFileSync(path.join(f.source,'Source/Code.cs'),'utf8'),'keep me');
});

test('migrates a legacy junction safely and never overwrites or removes a manually installed mod',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml');f.write('Source/Important.cs');
  fs.symlinkSync(f.source,f.target,process.platform==='win32'?'junction':'dir');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert(!fs.lstatSync(f.target).isSymbolicLink());assert(fs.existsSync(path.join(f.source,'Source/Important.cs')));assert(!fs.existsSync(path.join(f.target,'Source')));
  await mirrors.removeRuntimeMirror(f.source,f.target,f.state);
  fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'manual.txt'),'retain');
  await assert.rejects(mirrors.refreshRuntimeMirror(f.source,f.target,f.state),/unmanaged/);
  assert.equal(await mirrors.removeRuntimeMirror(f.source,f.target,f.state),false);assert.equal(fs.readFileSync(path.join(f.target,'manual.txt'),'utf8'),'retain');
});

test('copies existing and newly game-written Workshop IDs both ways without resurrecting an unlink',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml');f.write('About/PublishedFileId.txt','123');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(fs.readFileSync(path.join(f.target,'About/PublishedFileId.txt'),'utf8'),'123');
  fs.writeFileSync(path.join(f.target,'About/PublishedFileId.txt'),'456');await mirrors.reconcileMirrorId(f.source,f.target,f.state);
  assert.equal(fs.readFileSync(path.join(f.source,'About/PublishedFileId.txt'),'utf8'),'456');
  fs.unlinkSync(path.join(f.source,'About/PublishedFileId.txt'));await mirrors.reconcileMirrorId(f.source,f.target,f.state);
  assert(!fs.existsSync(path.join(f.target,'About/PublishedFileId.txt')));
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert(!fs.existsSync(path.join(f.source,'About/PublishedFileId.txt')));
  fs.writeFileSync(path.join(f.target,'About/PublishedFileId.txt'),'789');
  const deadline=Date.now()+6000;while(!fs.existsSync(path.join(f.source,'About/PublishedFileId.txt'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,60));
  assert.equal(fs.readFileSync(path.join(f.source,'About/PublishedFileId.txt'),'utf8'),'789');
});

test('conflicting Workshop ID changes stop synchronization without destroying either value',async t=>{
  const f=fixture(t);f.write('About/PublishedFileId.txt','123');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  f.write('About/PublishedFileId.txt','456');fs.writeFileSync(path.join(f.target,'About/PublishedFileId.txt'),'789');
  await assert.rejects(mirrors.reconcileMirrorId(f.source,f.target,f.state),/both workspace and mirror/);
  assert.equal(fs.readFileSync(path.join(f.source,'About/PublishedFileId.txt'),'utf8'),'456');assert.equal(fs.readFileSync(path.join(f.target,'About/PublishedFileId.txt'),'utf8'),'789');
});

test('linked runtime folders and linked ancestors cannot pull files from outside the workspace',async t=>{
  const f=fixture(t);const outside=path.join(f.root,'outside');fs.mkdirSync(path.join(outside,'Nested'),{recursive:true});fs.writeFileSync(path.join(outside,'Nested','secret.txt'),'private');
  fs.symlinkSync(outside,path.join(f.source,'Linked'),process.platform==='win32'?'junction':'dir');f.write('.atlas/release.json',JSON.stringify({include:['Linked/Nested']}));
  const plan=await release.planRelease(f.source);assert.equal(plan.valid,false);assert(!plan.files.some(p=>p.path.endsWith('secret.txt')));
});

test('a real Windows DLL sharing lock produces a clear error and leaves the previous mirror intact',{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Assemblies/Runtime.dll','old assembly');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Assemblies/Runtime.dll','new assembly');
  const script='$h=[IO.File]::Open($env:ATLAS_LOCK_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine("READY");[Console]::ReadLine() | Out-Null;$h.Dispose()';
  const child=spawn('powershell.exe',['-NoProfile','-Command',script],{env:{...process.env,ATLAS_LOCK_FIXTURE:path.join(f.target,'Assemblies/Runtime.dll')},windowsHide:true,stdio:['pipe','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('DLL lock fixture timed out')),10000);child.stdout.on('data',chunk=>{if(String(chunk).includes('READY')){clearTimeout(timeout);resolve();}});child.once('error',reject);});
    await assert.rejects(mirrors.refreshRuntimeMirror(f.source,f.target,f.state),/Runtime\.dll.*locked|locked.*Runtime\.dll/);
    assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Runtime.dll'),'utf8'),'old assembly');assert.equal(fs.readFileSync(path.join(f.source,'Assemblies/Runtime.dll'),'utf8'),'new assembly');
  } finally {child.stdin.end('\n');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},2000).unref();});}
});

module.exports={release,mirrors,load};
