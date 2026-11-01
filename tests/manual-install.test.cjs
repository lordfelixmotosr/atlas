const test=require('node:test');
const {load,fixture,release,mirrors,fs,fsp,path,assert}=require('./runtime-fixture.cjs');
const dll=load('agent/rimworld/dll-update.ts',{'./release-package.js':release,'./runtime-mirror.js':mirrors});
const previews=load('agent/rimworld/install-preview.ts',{'./release-package.js':release,'./runtime-mirror.js':mirrors});
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
test('DLL inventory ignores XML and texture edits; removing the last DLL counts',async t=>{
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
test('Install update notices every runtime file Test syncs, not only DLLs',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','same');f.write('Defs/Old.xml','old');f.write('Textures/Kept.png','png');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal((await dll.inspectRuntimeUpdate(f.source,f.target,f.state)).length,0);
  f.write('Defs/New.xml','new');f.write('Textures/Kept.png','PNG');fs.unlinkSync(path.join(f.source,'Defs/Old.xml'));f.write('Source/Ignored.cs','developer only');
  assert.deepEqual(list(await dll.inspectRuntimeUpdate(f.source,f.target,f.state)),[{path:'Defs/New.xml',action:'added'},{path:'Defs/Old.xml',action:'removed'},{path:'Textures/Kept.png',action:'modified'}]);
});
test('repeated toolbar checks still see same-size edits that keep the old modified time',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','aaaa');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal((await dll.inspectRuntimeUpdate(f.source,f.target,f.state)).length,0);
  const file=path.join(f.source,'Defs/Main.xml'),stamp=fs.statSync(file);
  await new Promise(resolve=>setTimeout(resolve,20));f.write('Defs/Main.xml','bbbb');fs.utimesSync(file,stamp.atime,stamp.mtime);
  assert.deepEqual(list(await dll.inspectRuntimeUpdate(f.source,f.target,f.state)),[{path:'Defs/Main.xml',action:'modified'}]);
});
test('runtime change checks leave first installs and unmanaged destinations to ordinary sync',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','new');assert.equal((await dll.inspectRuntimeUpdate(f.source,f.target,f.state)).length,0);
  fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'Other.xml'),'unmanaged');assert.equal((await dll.inspectRuntimeUpdate(f.source,f.target,f.state)).length,0);
});

async function routes(t,{companion=false}={}){
  const f=fixture(t);f.write('Assemblies/Main.dll','old');f.write('Defs/Removed.xml','old');f.write('Textures/Old.png','old');f.write('About/PublishedFileId.txt','123456');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  // Prior uploads may contain dev leftovers. A complete replacement removes them.
  fs.mkdirSync(path.join(f.target,'Source'));fs.writeFileSync(path.join(f.target,'Source/Old.cs'),'old');
  f.write('Assemblies/Main.dll','new');fs.unlinkSync(path.join(f.source,'Defs/Removed.xml'));fs.unlinkSync(path.join(f.source,'Textures/Old.png'));f.write('Defs/Added.xml','new');
  const sourceOf=folder=>path.join(path.dirname(f.source),folder),targetOf=folder=>path.join(path.dirname(f.target),folder);
  const writeCompanion=(p,data)=>{const file=path.join(sourceOf('Companion'),p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);};
  const mods=[{folder:'Example',source:'workspace',about:{name:'Fixture',packageIdLc:'atlas.release.fixture',modDependencies:[]}}];
  if(companion){
    writeCompanion('About/About.xml','<ModMetaData><name>Companion</name><packageId>atlas.release.companion</packageId><supportedVersions><li>1.6</li></supportedVersions></ModMetaData>');
    writeCompanion('Defs/Companion.xml','old');await mirrors.refreshRuntimeMirror(sourceOf('Companion'),targetOf('Companion'),f.state);writeCompanion('Defs/Companion.xml','new');
    mods.push({folder:'Companion',source:'workspace',about:{name:'Companion',packageIdLc:'atlas.release.companion',modDependencies:[]}});
    t.after(()=>fs.unwatchFile(path.join(targetOf('Companion'),'About','PublishedFileId.txt')));
  }
  const flags={running:false,busy:false,companionBusy:false,otherWork:false,gameInUse:false,building:false,buildStatus:'current',saved:{},quitSucceeds:true,syncError:null,installs:0,installed:[],quits:0,stops:0,onInstallLock:null};
  const handlers={};
  const workspace={getWorkspacePaths:()=>({workspaceDir:path.dirname(f.source)}),getMirrorStateDir:()=>f.state,getRimWorldModsDir:()=>path.dirname(f.target),listWorkspaceMods:async()=>[],syncModToGame:async(folder,options)=>{
    flags.installs++;if(flags.syncError)throw flags.syncError;await mirrors.refreshRuntimeMirror(sourceOf(folder),targetOf(folder),f.state,options);flags.installed.push(folder);return {assetWarnings:[]};
  }};
  const module=load('main/routes/dll-updates.ts',{
    electron:{app:{getPath:()=>path.join(f.root,'profile')},shell:{}},
    '../../agent/workspace.js':workspace,'../../agent/conversations.js':{getConversation:()=>({scope:{type:'mod',modFolder:'Example'},game:'rimworld'})},
    '../../agent/registry/index.js':{getRegistry:()=>({start:async()=>{},getSnapshot:()=>({mods})})},
    '../../agent/rimworld/game.js':{isRimWorldRunning:async()=>flags.running,quitRimWorld:async()=>{flags.quits++;if(flags.quitSucceeds)flags.running=false;return {killed:flags.quitSucceeds,exited:flags.quitSucceeds};}},
    '../../agent/rimworld/runtime-mirror.js':{...mirrors,withRuntimeSync:(root,work)=>{flags.onInstallLock?.();return mirrors.withRuntimeSync(root,work);}},'../../agent/rimworld/release-package.js':release,
    '../../agent/rimworld/install-preview.js':previews,
    '../../agent/rimworld/build-state.js':{isBuildInProgress:()=>flags.building,getBuildState:async()=>({status:flags.buildStatus,message:''}),getCompletedBuildStore:()=>({get:async source=>flags.saved[path.basename(source)]??null})},'../../agent/rimworld/dll-update.js':dll,
    '../../agent/rimworld/test-history.js':{readTestOptions:async()=>({companionMods:companion?['atlas.release.companion']:[]})},'../../atlas/mod-folder-shortcuts.js':{}
  });
  const host={hasActiveWork:()=>flags.busy||flags.companionBusy||flags.otherWork,modWorkBusy:folder=>folder==='Example'?flags.busy:folder==='Companion'&&flags.companionBusy,gameInUseByAgent:()=>flags.gameInUse,stopMonitoring:()=>flags.stops++};
  module.registerDllUpdateRoutes({ipc:{handle:(name,fn)=>handlers[name]=fn},requireConsent:()=>{},host});
  return {...f,flags,writeCompanion,companionTarget:targetOf('Companion'),apply:(token,mode)=>handlers['atlas:mods:apply-dll-update']({},'Example','conversation',token,mode),state:()=>handlers['atlas:mods:dll-update-state']({},'Example','conversation')};
}
test('manual install replaces the whole runtime and removes obsolete and dev files',async t=>{
  const f=await routes(t),sourceBefore=await release.planRelease(f.source);
  const preview=await f.apply();assert.equal(preview.status,'confirmation');assert.equal(f.flags.installs,0);assert.equal(preview.preview.added,1);assert.equal(preview.preview.modified,1);assert.equal(preview.preview.removed,3);
  const result=await f.apply(preview.token);assert.equal(result.status,'installed');assert.equal(f.flags.quits,0);assert.equal(f.flags.running,false);
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
  const first=await f.apply();assert.equal(first.status,'confirmation');assert.match(first.warnings.join('\n'),/Unknown root folder omitted: World/);assert.equal(f.flags.installs,0);
  f.write('Defs/Added.xml','changed while reviewing');const second=await f.apply(first.token);assert.equal(second.status,'confirmation');assert.notEqual(second.token,first.token);assert.equal(f.flags.installs,0);
  assert.equal((await f.apply(second.token)).status,'installed');
});
test('failed close, active AI work, active builds and invalid releases never install',async t=>{
  const f=await routes(t);f.flags.running=true;f.flags.quitSucceeds=false;
  const preview=await f.apply();await assert.rejects(f.apply(preview.token),/did not close/);assert.equal(f.flags.installs,0);
  f.flags.busy=true;await assert.rejects(f.apply(),/still working on Fixture/);f.flags.busy=false;
  f.flags.building=true;await assert.rejects(f.apply(),/C# build/);f.flags.building=false;
  f.write('Assemblies/Bad.pdb','dev');f.write('World/Stray.dll','stray');f.write('.atlas/release.json',JSON.stringify({include:['World']}));
  await assert.rejects(f.apply(),/Stray DLL/);assert.equal(f.flags.installs,0);
});
test('installation failure reports the original error and leaves the previous copy',async t=>{
  const f=await routes(t);f.flags.syncError=new Error('EPERM: recovery retained at fixture/previous');
  const preview=await f.apply();await assert.rejects(f.apply(preview.token),/Installed so far: none.*EPERM: recovery retained/);
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'old');
});

test('restore has its own review and an installation token cannot authorize it',async t=>{
  const f=await routes(t);const preview=await f.apply();await f.apply(preview.token);
  const restore=await f.apply(preview.token,'restore');assert.equal(restore.status,'confirmation');assert.equal(restore.preview.mode,'restore');assert(restore.preview.mods[0].previousSavedAt);
  await f.apply(restore.token,'restore');assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(f.source,'Assemblies/Main.dll'),'utf8'),'new');
});
test('changes to the installed runtime invalidate the file review',async t=>{
  const f=await routes(t),first=await f.apply();fs.writeFileSync(path.join(f.target,'UserAdded.txt'),'changed after preview');
  const next=await f.apply(first.token);assert.equal(next.status,'confirmation');assert.notEqual(next.token,first.token);assert(next.preview.mods[0].changes.some(c=>c.path==='UserAdded.txt'&&c.action==='removed'));assert.equal(f.flags.installs,0);
});
test('XML-only edits show Install update and install the project files like Test',async t=>{
  const f=await routes(t),first=await f.apply();await f.apply(first.token);
  f.write('Defs/OnlyXml.xml','<Defs/>');
  const state=await f.state();assert.equal(state.pending,true);assert.deepEqual(list(state.mods[0].changes),[{path:'Defs/OnlyXml.xml',action:'added'}]);
  const preview=await f.apply();assert.equal(preview.status,'confirmation');assert.match(preview.message,/same way Test in RimWorld does/);
  assert.equal((await f.apply(preview.token)).status,'installed');assert(fs.existsSync(path.join(f.target,'Defs/OnlyXml.xml')));
});
test('agent work in other chats does not block installing this mod',async t=>{
  const f=await routes(t);f.flags.otherWork=true;
  const preview=await f.apply();assert.equal((await f.apply(preview.token)).status,'installed');
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'new');
});
test('an agent test or live session using the game blocks installation',async t=>{
  const f=await routes(t);f.flags.gameInUse=true;
  const preview=await f.apply();await assert.rejects(f.apply(preview.token),/active agent test or live session/);assert.equal(f.flags.installs,0);
});
test('a game launch while installation waits for the shared lock prevents replacement',async t=>{
  for(const agentSession of [false,true])await t.test(agentSession?'agent test or live session':'ordinary game launch',async t=>{
    const f=await routes(t),preview=await f.apply();
    let lockHeld,releaseLaunch,installationQueued;
    const held=new Promise(resolve=>{lockHeld=resolve;}),release=new Promise(resolve=>{releaseLaunch=resolve;}),queued=new Promise(resolve=>{installationQueued=resolve;});
    const launch=mirrors.withRuntimeSync(path.dirname(f.target),async()=>{
      lockHeld();await release;f.flags.running=true;f.flags.gameInUse=agentSession;
    });
    await held;f.flags.onInstallLock=installationQueued;
    const install=f.apply(preview.token);
    const rejected=assert.rejects(install,agentSession?/active agent test or live session/:/RimWorld started during preparation/);
    try{
      await Promise.race([queued,install.then(()=>assert.fail('Installation finished without waiting for the launch lock.'))]);
    }finally{releaseLaunch();}
    await launch;await rejected;
    assert.equal(f.flags.installs,0);assert.equal(f.flags.quits,0);assert.equal(f.flags.running,true);
    assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'old');
  });
});

test('the review warns when C# changed since the last build',async t=>{
  const f=await routes(t);f.flags.buildStatus='needs-rebuild';
  const preview=await f.apply();assert.match(preview.warnings.join('\n'),/Fixture: C# code changed since its last build/);
});
test('a busy companion keeps its game copy and is reported; once idle it installs too',async t=>{
  const f=await routes(t,{companion:true});
  const state=await f.state();assert.equal(state.pending,true);assert.equal(state.error,undefined);assert.deepEqual(list(state.mods.map(m=>m.folder)).sort(),['Companion','Example']);
  f.flags.companionBusy=true;
  const preview=await f.apply();assert.match(preview.warnings.join('\n'),/Companion: not updated, its current game copy is kept/);assert.deepEqual(list(preview.preview.mods.map(m=>m.folder)),['Example']);
  await f.apply(preview.token);assert.deepEqual(f.flags.installed,['Example']);assert.equal(fs.readFileSync(path.join(f.companionTarget,'Defs/Companion.xml'),'utf8'),'old');
  f.flags.companionBusy=false;
  const next=await f.apply();await f.apply(next.token);assert.equal(f.flags.installed.at(-1),'Companion');assert.equal(fs.readFileSync(path.join(f.companionTarget,'Defs/Companion.xml'),'utf8'),'new');
});
test('a companion with a broken release does not block the chosen mod',async t=>{
  const f=await routes(t,{companion:true});f.writeCompanion('World/Stray.dll','stray');f.writeCompanion('.atlas/release.json',JSON.stringify({include:['World']}));
  const state=await f.state();assert.equal(state.error,undefined);assert.match(state.skipped[0].error,/Stray DLL/);
  const preview=await f.apply();assert.match(preview.warnings.join('\n'),/Companion: not updated, its current game copy is kept\. Stray DLL/);
  assert.equal((await f.apply(preview.token)).status,'installed');assert.deepEqual(f.flags.installed,['Example']);
});
async function savedBuildOf(f,source,id){const plan=await release.planRelease(source),dir=path.join(f.root,'completed-builds',id);fs.mkdirSync(path.dirname(dir),{recursive:true});await release.copyRelease(source,dir,plan);return {id,path:dir,plan,builtAt:Date.now()-1000,capturedAt:Date.now()-500};}
test('while the assistant edits a mod, Install update installs its last completed build',async t=>{
  const f=await routes(t);f.flags.saved.Example=await savedBuildOf(f,f.source,'saved-example');
  f.write('Defs/HalfDone.xml','partial edit');f.flags.busy=true;
  const preview=await f.apply();assert.equal(preview.status,'confirmation');assert.equal(preview.preview.mods[0].buildSnapshot.id,'saved-example');assert.match(preview.message,/last completed build/);
  assert.equal((await f.apply(preview.token)).status,'installed');assert.equal(f.flags.installs,0);
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Main.dll'),'utf8'),'new');assert.equal(fs.existsSync(path.join(f.target,'Defs/HalfDone.xml')),false);
  assert.equal(fs.readFileSync(path.join(f.target,'About/PublishedFileId.txt'),'utf8'),'123456');
});
test('a newer completed build after review requires a fresh review',async t=>{
  const f=await routes(t);f.flags.busy=true;f.flags.saved.Example=await savedBuildOf(f,f.source,'first');
  const preview=await f.apply();f.write('Defs/Later.xml','built later');f.flags.saved.Example=await savedBuildOf(f,f.source,'second');
  const again=await f.apply(preview.token);assert.equal(again.status,'confirmation');assert.notEqual(again.token,preview.token);
  assert.equal((await f.apply(again.token)).status,'installed');assert(fs.existsSync(path.join(f.target,'Defs/Later.xml')));
});
test('a busy companion with a completed build installs that build',async t=>{
  const f=await routes(t,{companion:true});
  f.flags.saved.Companion=await savedBuildOf(f,path.join(path.dirname(f.source),'Companion'),'companion-build');
  f.writeCompanion('Defs/Companion.xml','half done');f.flags.companionBusy=true;
  const preview=await f.apply();assert.deepEqual(list(preview.preview.mods.map(m=>m.folder)).sort(),['Companion','Example']);
  assert.equal((await f.apply(preview.token)).status,'installed');assert.deepEqual(f.flags.installed,['Example']);
  assert.equal(fs.readFileSync(path.join(f.companionTarget,'Defs/Companion.xml'),'utf8'),'new');
});
test('test history retains companions without changing the normal savedata mode',async t=>{
  const f=fixture(t),history=load('agent/rimworld/test-history.ts',{electron:{app:{getPath:()=>path.join(f.root,'profile')}}});
  await history.saveTestOptions('Example',{isolated:false,quicktest:false,autoOpenPalette:false,companionMods:['a','a','b'],paletteEntries:['c']});
  const saved=await history.readTestOptions('Example');assert.equal(saved.isolated,true);assert.equal(saved.quicktest,false);assert.deepEqual(list(saved.companionMods),['a','b']);
  assert.equal((await history.readTestOptions('different')).quicktest,true);
});
