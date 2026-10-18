const test=require('node:test');
const {load,fixture,release,mirrors,fs,fsp,path,assert}=require('./runtime-fixture.cjs');
const previews=load('agent/rimworld/install-preview.ts',{'./release-package.js':release,'./runtime-mirror.js':mirrors});
const read=(f,p)=>fs.readFileSync(path.join(f.target,p),'utf8');
const historyFile=f=>path.join(f.state,fs.readdirSync(f.state).find(n=>n.endsWith('.previous.json')));
const history=f=>JSON.parse(fs.readFileSync(historyFile(f),'utf8'));

test('first install has no previous version; changed runtime retains exactly one',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(await mirrors.previousRuntimeInfo(f.source,f.target,f.state),null);
  f.write('Assemblies/Main.dll','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);const first=history(f);assert(fs.existsSync(first.staging));
  f.write('Assemblies/Main.dll','v3');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);const second=history(f);assert.notEqual(first.staging,second.staging);assert(!fs.existsSync(first.staging));assert.equal(fs.readFileSync(path.join(second.staging,'previous/Assemblies/Main.dll'),'utf8'),'v2');
});
test('unchanged sync does not rewrite files, rotate history or add staging copies',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const before=history(f),id=fs.statSync(f.target).ino;await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  assert.equal(fs.statSync(f.target).ino,id);assert.equal(history(f).staging,before.staging);
});
test('the reviewed source and installed contents are checked again inside the sync lease',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');
  const plan=await release.planRelease(f.source),installed=await release.runtimeInventory(f.target),options={forceWorkspace:true,expectedRuntime:release.runtimeSignature(plan),expectedInstalled:release.runtimeSignature(installed)};
  f.write('Defs/Main.xml','v3');await assert.rejects(mirrors.refreshRuntimeMirror(f.source,f.target,f.state,options),/Runtime files changed after review/);assert.equal(read(f,'Defs/Main.xml'),'v1');
  f.write('Defs/Main.xml','v2');fs.writeFileSync(path.join(f.target,'Defs/Main.xml'),'external edit');await assert.rejects(mirrors.refreshRuntimeMirror(f.source,f.target,f.state,options),/Installed files changed after review/);assert.equal(read(f,'Defs/Main.xml'),'external edit');
});
test('restore replaces the runtime, restores deleted assets and keeps workspace sources',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','v1');f.write('Textures/Old.png','old art');f.write('World/marker.dat','custom runtime');f.write('.atlas/release.json',JSON.stringify({include:['World']}));f.write('Source/Main.cs','source v1');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  // Simulate development leftovers from a historical upload. Restore never copies them.
  fs.mkdirSync(path.join(f.target,'Source'));fs.writeFileSync(path.join(f.target,'Source/Legacy.cs'),'dev');
  f.write('Assemblies/Main.dll','v2');f.write('Textures/New.png','new art');f.write('Source/Main.cs','source v2');fs.unlinkSync(path.join(f.source,'Textures/Old.png'));await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const preview=await previews.previewRuntimeMod(f.source,f.target,f.state,'restore');assert(preview.preview.changes.some(c=>c.path==='Textures/Old.png'&&c.action==='added'));assert(preview.preview.changes.some(c=>c.path==='Textures/New.png'&&c.action==='removed'));assert(!preview.preview.changes.some(c=>c.path.startsWith('Source/')));
  await mirrors.restoreRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'Assemblies/Main.dll'),'v1');assert.equal(read(f,'Textures/Old.png'),'old art');assert.equal(read(f,'World/marker.dat'),'custom runtime');assert(!fs.existsSync(path.join(f.target,'Textures/New.png')));assert(!fs.existsSync(path.join(f.target,'Source')));assert.equal(fs.readFileSync(path.join(f.source,'Source/Main.cs'),'utf8'),'source v2');
});
test('automatic testing retains a restored runtime; explicit install and new edits replace it',async t=>{
  const f=fixture(t);f.write('Assemblies/Main.dll','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Assemblies/Main.dll','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  await mirrors.restoreRuntimeMirror(f.source,f.target,f.state);await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'Assemblies/Main.dll'),'v1');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state,{forceWorkspace:true});assert.equal(read(f,'Assemblies/Main.dll'),'v2');
  await mirrors.restoreRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Changed.xml','new runtime edit');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'Assemblies/Main.dll'),'v2');assert.equal(read(f,'Defs/Changed.xml'),'new runtime edit');
});
test('restore preserves a newer Workshop ID including one written by the game',async t=>{
  const f=fixture(t);f.write('About/PublishedFileId.txt','111');f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  fs.writeFileSync(path.join(f.target,'About/PublishedFileId.txt'),'222');
  const preview=await mirrors.previousRuntimePlan(f.source,f.target,f.state);assert(preview.plan.files.some(f=>f.path==='About/PublishedFileId.txt'&&f.bytes===3));
  await mirrors.restoreRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'About/PublishedFileId.txt'),'222');assert.equal(fs.readFileSync(path.join(f.source,'About/PublishedFileId.txt'),'utf8'),'222');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'Defs/Main.xml'),'v1');assert.equal(read(f,'About/PublishedFileId.txt'),'222');
});
test('tampered backup bytes are rejected before replacing the current runtime',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  fs.writeFileSync(path.join(history(f).staging,'previous/Defs/Main.xml'),'tampered');
  await assert.rejects(mirrors.previousRuntimePlan(f.source,f.target,f.state),/Previous runtime changed/);await assert.rejects(mirrors.restoreRuntimeMirror(f.source,f.target,f.state),/Runtime file changed/);assert.equal(read(f,'Defs/Main.xml'),'v2');
});
test('unsafe snapshot paths and unmanaged targets cannot be restored or deleted',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const original=history(f),modified={...original,staging:path.join(f.root,'unmanaged')};fs.writeFileSync(historyFile(f),JSON.stringify(modified));await assert.rejects(mirrors.restoreRuntimeMirror(f.source,f.target,f.state),/paths do not match/);assert(fs.existsSync(original.staging));
  fs.writeFileSync(historyFile(f),JSON.stringify(original));fs.renameSync(f.target,f.target+'-owned');fs.mkdirSync(f.target);fs.writeFileSync(path.join(f.target,'unmanaged.txt'),'keep');
  await assert.rejects(mirrors.restoreRuntimeMirror(f.source,f.target,f.state),/unmanaged game mod/);assert.equal(read(f,'unmanaged.txt'),'keep');
});
test('failed restoration retains the current runtime, history and recovery journal',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const saved=history(f),proxy=Object.create(fsp);proxy.rename=async(a,b)=>{if(path.basename(a)==='runtime'&&b===f.target)throw Object.assign(new Error('INSTALL FAILED'),{code:'EIO'});return fsp.rename(a,b);};
  const m=load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release,'node:fs/promises':proxy});await assert.rejects(m.restoreRuntimeMirror(f.source,f.target,f.state),/INSTALL FAILED.*Recovery retained/s);assert.equal(read(f,'Defs/Main.xml'),'v2');assert.equal(history(f).staging,saved.staging);assert(fs.existsSync(saved.staging));
});
test('older successful retention never deletes failed transaction recovery data',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const parent=path.dirname(history(f).staging),failed=path.join(parent,'mirror-failure-evidence');fs.mkdirSync(failed);fs.writeFileSync(path.join(failed,'transaction.json'),JSON.stringify({format:'atlas-runtime-transaction-v1',source:f.source,target:f.target,phase:'recovered'}));fs.writeFileSync(path.join(failed,'evidence.txt'),'keep');
  f.write('Defs/Main.xml','v3');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(fs.readFileSync(path.join(failed,'evidence.txt'),'utf8'),'keep');
});
test('legacy records preserve custom non-DLL runtime folders without release.json in the mirror',async t=>{
  const f=fixture(t);f.write('World/data.json','custom');f.write('.atlas/release.json',JSON.stringify({include:['World']}));f.write('Defs/Main.xml','v1');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const record=path.join(f.state,fs.readdirSync(f.state).find(n=>!n.endsWith('.previous.json'))),value=JSON.parse(fs.readFileSync(record));delete value.plan;fs.writeFileSync(record,JSON.stringify(value));
  f.write('Defs/Main.xml','v2');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);await mirrors.restoreRuntimeMirror(f.source,f.target,f.state);assert.equal(read(f,'World/data.json'),'custom');
});
