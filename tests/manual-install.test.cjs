const test=require('node:test');
const {load,fixture,release,mirrors,fs,fsp,path,assert}=require('./runtime-fixture.cjs');
const dll=load('agent/rimworld/dll-update.ts',{'./release-package.js':release,'./runtime-mirror.js':mirrors});
const list=value=>JSON.parse(JSON.stringify(value));

test('DLL inventory compares bytes, detects removals and leaves source files intact',async t=>{
  const f=fixture(t);f.write('Assemblies/Changed.dll','old');f.write('Assemblies/Removed.dll','old');f.write('Defs/Old.xml','old');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const stamp=fs.statSync(path.join(f.source,'Assemblies/Changed.dll'));
  f.write('Assemblies/Changed.dll','new');fs.utimesSync(path.join(f.source,'Assemblies/Changed.dll'),stamp.atime,stamp.mtime);
  fs.unlinkSync(path.join(f.source,'Assemblies/Removed.dll'));f.write('Assemblies/Added.dll','new');f.write('Source/Hidden.dll','developer');f.write('Textures/New.png','not a DLL');
  const changes=await dll.inspectDllUpdate(f.source,f.target,f.state);
  assert.deepEqual(list(changes),[{path:'Assemblies/Added.dll',action:'added'},{path:'Assemblies/Changed.dll',action:'modified'},{path:'Assemblies/Removed.dll',action:'removed'}]);
  assert.equal(fs.readFileSync(path.join(f.source,'Source/Hidden.dll'),'utf8'),'developer');
});
test('XML and texture edits do not show the DLL update button; removing the last DLL does',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','same');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  f.write('Defs/New.xml','new');f.write('Textures/New.png','new');assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state)).length,0);
  fs.unlinkSync(path.join(f.source,'Assemblies/Main.dll'));assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state))[0].action,'removed');
});
test('DLL inventory follows every LoadFolders version and approved extra DLL path',async t=>{
  const f=fixture(t);f.write('LoadFolders.xml','<loadFolders><v1.6><li>1.6</li></v1.6><v1.7><li>1.7</li></v1.7></loadFolders>');
  f.write('1.6/Assemblies/Older.dll','old');f.write('1.7/Assemblies/Newer.dll','old');f.write('World/Native.dll','old');f.write('.atlas/release.json',JSON.stringify({include:['World'],allowDlls:['World/Native.dll']}));
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  f.write('1.6/Assemblies/Older.dll','new');f.write('1.7/Assemblies/Newer.dll','new');f.write('World/Native.dll','new');
  assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state)).length,3);
  const partial=await release.planRelease(f.source,{},true);
  await assert.rejects(release.copyRelease(f.source,path.join(f.root,'partial'),partial),/DLL inventory/);
});
test('first installs and unmanaged destinations are left to ordinary sync',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','new');assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state)).length,0);
  fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'Other.dll'),'unmanaged');assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state)).length,0);
});
test('removed managed mirrors can be restored and dependencies/companions are included',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','new');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);fs.rmSync(f.target,{recursive:true});
  assert.equal((await dll.inspectDllUpdate(f.source,f.target,f.state))[0].action,'added');
  const mod=(folder,id,deps=[])=>({folder,source:'workspace',about:{packageIdLc:id,modDependencies:deps.map(packageId=>({packageId}))}});
  const result=dll.dllTestFolders({mods:[mod('current','a',['b']),mod('duplicate','a'),mod('parent','b',['c']),mod('shared','c'),mod('companion','d',['c'])]},'current',['D']);
  assert.deepEqual(list(result),['current','companion','parent','shared']);
});

async function routes(t){
  const f=fixture(t);f.write('Assemblies/Main.dll','old');f.write('Defs/Removed.xml','old');f.write('Textures/Old.png','old');f.write('About/PublishedFileId.txt','123456');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  // Prior uploads may contain dev leftovers. A complete replacement removes them.
  fs.mkdirSync(path.join(f.target,'Source'));fs.writeFileSync(path.join(f.target,'Source/Old.cs'),'old');
  f.write('Assemblies/Main.dll','new');fs.unlinkSync(path.join(f.source,'Defs/Removed.xml'));fs.unlinkSync(path.join(f.source,'Textures/Old.png'));f.write('Defs/Added.xml','new');
  const flags={running:false,busy:false,building:false,quitSucceeds:true,syncError:null,installs:0,quits:0,stops:0};
  const handlers={};
  const workspace={getWorkspacePaths:()=>({workspaceDir:path.dirname(f.source)}),getMirrorStateDir:()=>f.state,getRimWorldModsDir:()=>path.dirname(f.target),listWorkspaceMods:async()=>[],syncModToGame:async()=>{
    flags.installs++;if(flags.syncError)throw flags.syncError;await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);return {assetWarnings:[]};
  }};
  const module=load('main/routes/dll-updates.ts',{
    electron:{app:{getPath:()=>path.join(f.root,'profile')},shell:{}},
    '../../agent/workspace.js':workspace,'../../agent/conversations.js':{getConversation:()=>({scope:{type:'mod',modFolder:'Example'},game:'rimworld'})},
    '../../agent/registry/index.js':{getRegistry:()=>({start:async()=>{},getSnapshot:()=>({mods:[{folder:'Example',source:'workspace',about:{name:'Fixture',packageIdLc:'atlas.release.fixture',modDependencies:[]}}]})})},
    '../../agent/rimworld/game.js':{isRimWorldRunning:async()=>flags.running,quitRimWorld:async()=>{flags.quits++;if(flags.quitSucceeds)flags.running=false;return {killed:flags.quitSucceeds,exited:flags.quitSucceeds};}},
    '../../agent/rimworld/runtime-mirror.js':mirrors,'../../agent/rimworld/release-package.js':release,
    '../../agent/rimworld/build-state.js':{isBuildInProgress:()=>flags.building},'../../agent/rimworld/dll-update.js':dll,
    '../../agent/rimworld/test-history.js':{readTestOptions:async()=>({companionMods:[]})},'../../atlas/mod-folder-shortcuts.js':{}
  });
  module.registerDllUpdateRoutes({ipc:{handle:(name,fn)=>handlers[name]=fn},requireConsent:()=>{},host:{hasActiveWork:()=>flags.busy,stopMonitoring:()=>flags.stops++}});
  return {...f,flags,apply:token=>handlers['atlas:mods:apply-dll-update']({},'Example','conversation',token)};
}
test('manual install replaces the whole runtime and removes obsolete and dev files',async t=>{
  const f=await routes(t),sourceBefore=await release.planRelease(f.source);
  const result=await f.apply();assert.equal(result.status,'installed');assert.equal(f.flags.quits,0);assert.equal(f.flags.running,false);
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'new');assert(fs.existsSync(path.join(f.target,'Defs/Added.xml')));
  for(const obsolete of ['Defs/Removed.xml','Textures/Old.png','Source'])assert(!fs.existsSync(path.join(f.target,obsolete)));
  assert.equal(fs.readFileSync(path.join(f.target,'About/PublishedFileId.txt'),'utf8'),'123456');
  assert.deepEqual(list((await release.planRelease(f.source)).files),list(sourceBefore.files));
  assert.equal((await f.apply()).status,'current');
});
test('closing the game requires confirmation and installation leaves it closed',async t=>{
  const f=await routes(t);f.flags.running=true;
  const preview=await f.apply();assert.equal(preview.status,'confirmation');assert.match(preview.message,/Save your game first/);assert.equal(f.flags.installs,0);assert.equal(f.flags.quits,0);
  const result=await f.apply(preview.token);assert.equal(result.status,'installed');assert.equal(f.flags.running,false);assert.equal(f.flags.quits,1);assert.equal(f.flags.stops,1);
});
test('unknown folders are warned about and a changed package invalidates confirmation',async t=>{
  const f=await routes(t);f.write('World/Map.json','data');
  const first=await f.apply();assert.equal(first.status,'confirmation');assert.match(first.message,/Unknown root folder omitted: World/);assert.equal(f.flags.installs,0);
  f.write('Defs/Added.xml','changed while reviewing');const second=await f.apply(first.token);assert.equal(second.status,'confirmation');assert.notEqual(second.token,first.token);assert.equal(f.flags.installs,0);
  assert.equal((await f.apply(second.token)).status,'installed');
});
test('failed close, active AI work, active builds and invalid releases never install',async t=>{
  const f=await routes(t);f.flags.running=true;f.flags.quitSucceeds=false;
  const preview=await f.apply();await assert.rejects(f.apply(preview.token),/did not close/);assert.equal(f.flags.installs,0);
  f.flags.busy=true;await assert.rejects(f.apply(),/active agent work/);f.flags.busy=false;
  f.flags.building=true;await assert.rejects(f.apply(),/C# build/);f.flags.building=false;
  f.write('Assemblies/Bad.pdb','dev');f.write('World/Stray.dll','stray');f.write('.atlas/release.json',JSON.stringify({include:['World']}));
  await assert.rejects(f.apply(),/Stray DLL/);assert.equal(f.flags.installs,0);
});
test('installation failure reports the original error and leaves the previous copy',async t=>{
  const f=await routes(t);f.flags.syncError=new Error('EPERM: recovery retained at fixture/previous');
  await assert.rejects(f.apply(),/Installed so far: none.*EPERM: recovery retained/);
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'old');
});
test('test history retains companions without changing the normal savedata mode',async t=>{
  const f=fixture(t),history=load('agent/rimworld/test-history.ts',{electron:{app:{getPath:()=>path.join(f.root,'profile')}}});
  await history.saveTestOptions('Example',{isolated:false,quicktest:false,autoOpenPalette:false,companionMods:['a','a','b'],paletteEntries:['c']});
  const saved=await history.readTestOptions('Example');assert.equal(saved.isolated,true);assert.equal(saved.quicktest,false);assert.deepEqual(list(saved.companionMods),['a','b']);
  assert.equal((await history.readTestOptions('different')).quicktest,true);
});
