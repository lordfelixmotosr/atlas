const test=require('node:test');
const {release,mirrors,load,fixture,fs,fsp,path,spawn,assert}=require('./runtime-fixture.cjs');
const stage=f=>path.join(f.root,'.atlas-release-stage');
const transactions=f=>fs.readdirSync(stage(f)).filter(n=>n.startsWith('mirror-')).map(n=>path.join(stage(f),n));
function injected(rename){const proxy=Object.create(fsp);proxy.rename=rename;return load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release,'node:fs/promises':proxy});}
function error(code,message){return Object.assign(Error(message),{code});}
async function hold(file,dir=false){
  const args=dir?['-Command',fs.readFileSync(path.join(__dirname,'windows-directory-lock.ps1'),'utf8')]:['-Command','$h=[IO.File]::Open($env:ATLAS_LOCK_FIXTURE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine("READY");[Console]::ReadLine()|Out-Null;$h.Dispose()'];
  const child=spawn('powershell.exe',['-NoProfile',...args],{env:{...process.env,ATLAS_LOCK_FIXTURE:file},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Lock fixture timeout '+stderr));},10000);child.stdout.on('data',b=>{if(String(b).includes('READY')){clearTimeout(timer);resolve();}});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error('Lock fixture exited '+stderr));});});
  return ()=>new Promise(resolve=>{child.once('exit',resolve);child.stdin.end('\n');});
}

test('failed installation restores the previous runtime and retains candidate, journal and original error',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');
  const m=injected(async(a,b)=>{if(path.basename(a)==='runtime'&&b===f.target)throw error('EIO','ORIGINAL INSTALL FAILURE');return fsp.rename(a,b)});
  await assert.rejects(m.refreshRuntimeMirror(f.source,f.target,f.state),e=>e.message.includes('ORIGINAL INSTALL FAILURE')&&e.cause.message==='ORIGINAL INSTALL FAILURE'&&e.message.includes('Recovery retained'));
  assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'old');assert(await mirrors.ownedMirror(f.source,f.target,f.state));
  const dirs=transactions(f);assert.equal(dirs.length,1);const j=JSON.parse(fs.readFileSync(path.join(dirs[0],'transaction.json')));assert.equal(j.phase,'recovered');assert(fs.existsSync(path.join(dirs[0],'runtime/Defs/Main.xml')));
});

test('failed rollback rename falls back to a copy, retains the backup and does not hide the install failure',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');
  const m=injected(async(a,b)=>{if(path.basename(a)==='runtime'&&b===f.target)throw error('EIO','ORIGINAL INSTALL FAILURE');if(path.basename(a)==='previous')throw error('EPERM','ROLLBACK DIRECTORY LOCK');return fsp.rename(a,b)});
  await assert.rejects(m.refreshRuntimeMirror(f.source,f.target,f.state),/ORIGINAL INSTALL FAILURE.*ROLLBACK DIRECTORY LOCK.*Restored previous runtime by copying/s);
  assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'old');assert(await mirrors.ownedMirror(f.source,f.target,f.state));
  const dir=transactions(f)[0];assert.equal(fs.readFileSync(path.join(dir,'previous/Defs/Main.xml'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(dir,'runtime/Defs/Main.xml'),'utf8'),'new');
});

test('ownership-save failure and blocked candidate rollback leave the installed runtime and previous copy available',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');
  const m=injected(async(a,b)=>{if(path.dirname(b)===f.state)throw error('EIO','RECORD WRITE FAILURE');if(a===f.target&&path.basename(b)==='runtime')throw error('EPERM','CANDIDATE ROLLBACK LOCK');return fsp.rename(a,b)});
  await assert.rejects(m.refreshRuntimeMirror(f.source,f.target,f.state),/RECORD WRITE FAILURE.*CANDIDATE ROLLBACK LOCK/s);
  assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(transactions(f)[0],'previous/Defs/Main.xml'),'utf8'),'old');
  // Next normal sync recovers the interrupted transaction before refreshing.
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert(await mirrors.ownedMirror(f.source,f.target,f.state));assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');
});

test('two independent modules serialize all targets in one Mods root, including case aliases on Windows',async t=>{
  const f=fixture(t),other=load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release});let inside=0,max=0;
  const work=m=>m.withRuntimeSync(path.dirname(f.target),async()=>{max=Math.max(max,++inside);await new Promise(r=>setTimeout(r,75));await m.refreshRuntimeMirror(f.source,f.target,f.state);inside--;});
  await Promise.all([work(mirrors),work(other),work(mirrors)]);assert.equal(max,1);assert(await mirrors.ownedMirror(f.source,f.target,f.state));
});

test('transient lease cleanup locks cannot wedge subsequent sync jobs',async t=>{
  const f=fixture(t),proxy=Object.create(fsp);let attempts=0;
  proxy.unlink=async file=>{if(path.basename(file)==='owner.json'&&++attempts<3)throw error('EPERM','TRANSIENT LEASE LOCK');return fsp.unlink(file);};
  const m=load('agent/rimworld/runtime-mirror.ts',{'./release-package.js':release,'node:fs/promises':proxy});
  await m.withRuntimeSync(path.dirname(f.target),async()=>{});assert.equal(attempts,3);assert(!fs.existsSync(path.join(stage(f),'.sync-lock')));await m.refreshRuntimeMirror(f.source,f.target,f.state);assert(await m.ownedMirror(f.source,f.target,f.state));
});

test('real processes serialize a shared Mods root',async t=>{
  const f=fixture(t),events=path.join(f.root,'events.txt');
  const child=()=>new Promise((resolve,reject)=>{const c=spawn(process.execPath,[path.join(__dirname,'runtime-sync-worker.cjs'),f.source,f.target,f.state,events],{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='';c.stderr.on('data',b=>out+=b);c.once('error',reject);c.once('exit',code=>code===0?resolve():reject(Error(out)));});
  await Promise.all([child(),child()]);const lines=fs.readFileSync(events,'utf8').trim().split('\n');assert.equal(lines.length,4);assert.equal(lines[0].replace('start','end'),lines[1]);assert.equal(lines[2].replace('start','end'),lines[3]);assert(await mirrors.ownedMirror(f.source,f.target,f.state));
});

test('a process crash after moving the previous copy is recovered on the next sync',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');
  const code=await new Promise((resolve,reject)=>{const c=spawn(process.execPath,[path.join(__dirname,'runtime-sync-worker.cjs'),f.source,f.target,f.state,path.join(f.root,'events.txt'),'crash'],{windowsHide:true,stdio:'ignore'});c.once('error',reject);c.once('exit',resolve);});
  assert.equal(code,23);assert(!fs.existsSync(f.target));const retained=transactions(f)[0];assert.equal(fs.readFileSync(path.join(retained,'previous/Defs/Main.xml'),'utf8'),'old');
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');assert(await mirrors.ownedMirror(f.source,f.target,f.state));assert(fs.existsSync(path.join(retained,'transaction.json')));
});

test('a pre-journal backup in the old Mods staging location is recovered without discarding it',async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);
  const retained=path.join(path.dirname(f.target),'.atlas-release-stage','mirror-legacy');fs.mkdirSync(retained,{recursive:true});await fsp.rename(f.target,path.join(retained,'previous'));f.write('Defs/Main.xml','new');
  assert(await mirrors.missingRecordedMirror(f.source,f.target,f.state));await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');assert(fs.existsSync(path.join(retained,'transaction.json')));
});

test('Windows directory handle without FILE_SHARE_DELETE preserves the old runtime after bounded retries', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');const releaseLock=await hold(f.target,true);const started=Date.now();
  try{await assert.rejects(mirrors.refreshRuntimeMirror(f.source,f.target,f.state),/EPERM|EACCES|EBUSY/);assert(Date.now()-started<12000);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'old');assert(transactions(f).length>0);}finally{await releaseLock();}
  await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');
});

test('transient Windows DLL sharing lock and directory lock clear within the retry budget', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Assemblies/Runtime.dll','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Assemblies/Runtime.dll','new');
  for(const [file,dir] of [[path.join(f.target,'Assemblies/Runtime.dll'),false],[f.target,true]]){
    const unlock=await hold(file,dir);const timer=setTimeout(()=>void unlock(),200);try{await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);}finally{clearTimeout(timer);}
  }
  assert.equal(fs.readFileSync(path.join(f.target,'Assemblies/Runtime.dll'),'utf8'),'new');
});

test('a real Windows lock on the candidate clears after the previous directory has moved', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');let first=true,unlock;
  const m=injected(async(a,b)=>{if(first&&path.basename(a)==='runtime'&&b===f.target){first=false;assert(!fs.existsSync(f.target));unlock=await hold(a,true);setTimeout(()=>void unlock(),200);}return fsp.rename(a,b);});
  await m.refreshRuntimeMirror(f.source,f.target,f.state);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'new');
});

test('a real Windows directory lock blocks rollback rename but copy recovery restores the previous runtime', {skip:process.platform!=='win32'},async t=>{
  const f=fixture(t);f.write('Defs/Main.xml','old');await mirrors.refreshRuntimeMirror(f.source,f.target,f.state);f.write('Defs/Main.xml','new');let unlock;
  const m=injected(async(a,b)=>{if(path.basename(a)==='runtime'&&b===f.target){unlock=await hold(path.join(path.dirname(a),'previous'),true);throw error('EIO','ORIGINAL INSTALL FAILURE');}return fsp.rename(a,b)});
  try{await assert.rejects(m.refreshRuntimeMirror(f.source,f.target,f.state),/ORIGINAL INSTALL FAILURE.*Restored previous runtime by copying/s);assert.equal(fs.readFileSync(path.join(f.target,'Defs/Main.xml'),'utf8'),'old');assert.equal(fs.readFileSync(path.join(transactions(f)[0],'previous/Defs/Main.xml'),'utf8'),'old');}finally{await unlock?.();}
});
