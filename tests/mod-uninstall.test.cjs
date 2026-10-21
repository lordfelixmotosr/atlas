const test=require('node:test');
const {release,mirrors,load,fixture,fs,fsp,path,spawn,assert}=require('./runtime-fixture.cjs');
function injected(overrides){return load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release,'node:fs/promises':Object.assign(Object.create(fsp),overrides)});}
const failure=(code,message)=>Object.assign(new Error(message),{code});

test('uninstall removes only the managed game copy, retains workspace/dev files and stops automatic recovery',async t=>{
  const f=fixture(t);f.write('Source/Main.cs','source');f.write('.atlas/prefs.json','{}');f.write('Assemblies/Main.dll','runtime');f.write('About/PublishedFileId.txt','123');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  fs.writeFileSync(path.join(f.target,'About/PublishedFileId.txt'),'456');
  const workshop=path.join(f.root,'Workshop','123');fs.mkdirSync(workshop,{recursive:true});fs.writeFileSync(path.join(workshop,'untouched.txt'),'Steam');
  const config=path.join(f.root,'ModsConfig.xml');fs.writeFileSync(config,'normal load order');
  assert.equal((await mirrors.uninstallRuntimeMirror(f.source,f.target,f.state)).removed,true);
  assert(!fs.existsSync(f.target));assert.equal(await mirrors.missingRecordedMirror(f.source,f.target,f.state),false);
  await mirrors.restoreMirrorWatchers(f.state,path.dirname(f.source),path.dirname(f.target));assert(!fs.existsSync(f.target));
  for(const [file,value]of [['Source/Main.cs','source'],['.atlas/prefs.json','{}'],['Assemblies/Main.dll','runtime'],['About/PublishedFileId.txt','456']])assert.equal(fs.readFileSync(path.join(f.source,file),'utf8'),value);
  assert.equal(fs.readFileSync(path.join(workshop,'untouched.txt'),'utf8'),'Steam');assert.equal(fs.readFileSync(config,'utf8'),'normal load order');
  assert.equal((await mirrors.uninstallRuntimeMirror(f.source,f.target,f.state)).removed,false);
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert(fs.existsSync(path.join(f.target,'Assemblies/Main.dll')));
});

test('unowned game directories are never removed and legacy junction removal retains its source',async t=>{
  const f=fixture(t);f.write('Source/Main.cs','keep');fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'manual.txt'),'keep');
  assert.equal((await mirrors.uninstallRuntimeMirror(f.source,f.target,f.state)).removed,false);
  assert.equal(fs.readFileSync(path.join(f.target,'manual.txt'),'utf8'),'keep');
  fs.unlinkSync(path.join(f.target,'manual.txt'));fs.rmdirSync(f.target);
  fs.symlinkSync(f.source,f.target,process.platform==='win32'?'junction':'dir');
  assert.equal((await mirrors.uninstallRuntimeMirror(f.source,f.target,f.state)).removed,true);
  assert.equal(fs.readFileSync(path.join(f.source,'Source/Main.cs'),'utf8'),'keep');assert(!fs.existsSync(f.target));
});

test('rename failure leaves the whole installed copy and its ownership intact',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','original');f.write('Defs/Keep.xml','keep');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const m=injected({rename:async(a,b)=>{if(a===f.target)throw failure('EIO','INJECTED RENAME FAILURE');return fsp.rename(a,b);}});
  await assert.rejects(m.uninstallRuntimeMirror(f.source,f.target,f.state),/INJECTED RENAME FAILURE.*Atlas project is retained/);
  assert.equal(fs.readFileSync(path.join(f.target,'Defs/Keep.xml'),'utf8'),'keep');assert.equal(await mirrors.ownedMirror(f.source,f.target,f.state),true);
});

test('transient locks retry and cleanup failure stays outside Mods without reinstalling',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','runtime');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);let retries=0;
  const m=injected({rename:async(a,b)=>{if(a===f.target&&retries++<2)throw failure('EPERM','TRANSIENT');return fsp.rename(a,b);},unlink:async file=>{if(path.dirname(file)===f.state)throw failure('EIO','OWNERSHIP CLEANUP FAILURE');return fsp.unlink(file);}});
  const result=await m.uninstallRuntimeMirror(f.source,f.target,f.state);
  assert.equal(retries,3);assert.equal(result.removed,true);assert(result.retainedPath.startsWith(path.join(f.root,'.atlas-release-stage')+path.sep));
  assert(!fs.existsSync(f.target));assert(fs.existsSync(path.join(result.retainedPath,'runtime','Assemblies/Main.dll')));
  assert.equal(await m.missingRecordedMirror(f.source,f.target,f.state),false);
  await m.restoreMirrorWatchers(f.state,path.dirname(f.source),path.dirname(f.target));assert(!fs.existsSync(f.target));
});

test('uninstall queues after an in-flight sync and retains previous-runtime history',async t=>{
  const f=fixture(t);f.write('Defs/Keep.xml','first');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Keep.xml','second');
  const first=mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const second=mirrors.uninstallRuntimeMirror(f.source,f.target,f.state);
  await first;assert.equal((await second).removed,true);assert(!fs.existsSync(f.target));assert(await mirrors.previousRuntimeInfo(f.source,f.target,f.state));
  assert.equal(fs.readFileSync(path.join(f.source,'Defs/Keep.xml'),'utf8'),'second');
});

async function hold(file,dir){
  const command=dir?fs.readFileSync(path.join(__dirname,'windows-directory-lock.ps1'),'utf8'):'$h=[IO.File]::Open($env:ATLAS_LOCK_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine("READY");[Console]::ReadLine()|Out-Null;$h.Dispose()';
  const child=spawn('powershell.exe',['-NoProfile','-Command',command],{env:{...process.env,ATLAS_LOCK_FIXTURE:file},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Lock fixture timed out: '+stderr)),15000);child.stdout.on('data',b=>{if(String(b).includes('READY')){clearTimeout(timer);resolve();}});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(stderr));});});}
  catch(error){child.stdin.end('\n');throw error;}
  return ()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('\n');});
}

for(const directory of [false,true])test(`Windows ${directory?'directory':'DLL'} lock preserves the installed files until a successful retry`,{skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','runtime');f.write('Defs/Keep.xml','keep');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const unlock=await hold(directory?f.target:path.join(f.target,'Assemblies/Main.dll'),directory);
  try{await assert.rejects(mirrors.uninstallRuntimeMirror(f.source,f.target,f.state),/locked|Could not uninstall/);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Keep.xml'),'utf8'),'keep');assert.equal(await mirrors.ownedMirror(f.source,f.target,f.state),true);}
  finally{await unlock();}
  assert.equal((await mirrors.uninstallRuntimeMirror(f.source,f.target,f.state)).removed,true);assert(!fs.existsSync(f.target));
});

test('uninstall IPC validates selection, blocks running game/build/agent and rechecks after waiting for sync',async()=>{
  const flags={running:false,building:false,busy:false,waiting:false,removed:0,events:0,consent:0};let handler;
  const api=load('main/routes/mod-uninstall.ts',{
    '../../agent/workspace.js':{getWorkspaceMod:async()=>({prefs:{game:'rimworld'}}),getWorkspacePaths:()=>({workspaceDir:'workspace'}),getRimWorldModsDir:()=> 'game/Mods',unsyncModFromGame:async()=>{flags.removed++;return {removed:true};}},
    '../../agent/rimworld/game.js':{isRimWorldRunning:async()=>flags.running},'../../agent/rimworld/build-state.js':{isBuildInProgress:()=>flags.building},
    '../../agent/rimworld/runtime-mirror.js':{withRuntimeSync:async(_root,fn)=>{if(flags.waiting)flags.running=true;return fn();}},
    '../../agent/mod-events.js':{emitModChanged:()=>flags.events++},'../../agent/registry/index.js':{getRegistry:()=>({refresh:async()=>{}})},
  });
  api.registerModUninstallRoute({ipc:{handle:(_id,fn)=>handler=fn},requireConsent:()=>flags.consent++,host:{hasActiveWork:()=>flags.busy}});
  await assert.rejects(handler({},'../escape'),/Invalid/);
  for(const [flag,message]of [['running',/Save and close/],['building',/C# build/],['busy',/agent work/],['waiting',/Save and close/]]){
    flags[flag]=true;await assert.rejects(handler({},'Example'),message);flags[flag]=false;flags.running=false;assert.equal(flags.removed,0);
  }
  assert.equal((await handler({},'Example')).removed,true);assert.equal(flags.removed,1);assert.equal(flags.events,1);
});
