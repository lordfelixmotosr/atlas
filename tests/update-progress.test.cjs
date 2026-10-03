'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Library,sha}=require('../src/atlas/library.cjs');
const {ApplicationUpdate}=require('../src/atlas/application-update.cjs');
const {sign}=require('../scripts/atlas/publish-packs.cjs');
const base=path.resolve(__dirname,'../build-check/fixtures');fs.mkdirSync(base,{recursive:true});
function fixture(t){
  const root=fs.mkdtempSync(path.join(base,'update-progress-')),resources=path.join(root,'resources'),updates=path.join(root,'updates'),keys=crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(resources);fs.mkdirSync(updates);
  fs.writeFileSync(path.join(resources,'trust.json'),JSON.stringify({keys:{'atlas-local-1':keys.publicKey.export({format:'pem',type:'spki'})}}));
  t.after(()=>{assert(root.startsWith(base+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const bytes=Buffer.alloc(1024*1024,42),entry={version:'0.3.0',file:'Atlas-0.3.0.zip',size:bytes.length,sha256:sha(bytes)};
  const feed=()=>sign({type:'feed',sequence:1,issuedAt:Date.now()-1000,expiresAt:Date.now()+86400000,packs:[],application:entry},keys.privateKey);
  fs.writeFileSync(path.join(updates,entry.file),bytes);fs.writeFileSync(path.join(updates,'index.atlas.json'),feed());
  const library=new Library(root,resources),states=[];let time=0;
  const app=new ApplicationUpdate(library,{app:{}},()=>false,{onState:state=>states.push(state),now:()=>time});
  return{root,resources,updates,bytes,entry,feed,library,app,states,tick:()=>time+=300};
}
function network(f,body,contentLength=1){
  f.library.configure({source:'https://example.com/updates/'});
  f.library.fetch=async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    if(String(url).endsWith('index.atlas.json'))return new Response(f.feed());
    return{ok:true,status:200,headers:new Headers({'content-length':String(contentLength)}),body:body()};
  };
}
function assertFailed(f){
  assert.equal(f.app.status().working,false);assert.equal(f.app.status().ready,null);
  assert.equal(f.app.status().progress.stage,'error');assert(!f.states.some(s=>s.progress.stage==='ready'));
  assert.deepEqual(fs.readdirSync(path.join(f.root,'data/updates')),[]);
}
test('local application archive streams to disk with monotonic byte progress and verified readiness',async t=>{
  const f=fixture(t),result=await f.app.download();
  assert.equal(result.working,false);assert.equal(result.ready,'0.3.0');
  assert.deepEqual([...new Set(f.states.map(s=>s.progress.stage))],['checking','downloading','verifying','ready']);
  const download=f.states.filter(s=>s.progress.stage==='downloading');assert(download.length>=3);assert(download.length<=5,'fast local chunks should be throttled');
  assert(download.every((s,i)=>s.progress.totalBytes===f.bytes.length&&(!i||s.progress.receivedBytes>=download[i-1].progress.receivedBytes)));
  assert.equal(download.at(-1).progress.receivedBytes,f.bytes.length);
  assert.equal(sha(fs.readFileSync(f.app.ready.path)),sha(f.bytes));
  assert(f.states.filter(s=>s.progress.stage==='verifying').every(s=>s.ready===null));
  assert.deepEqual(fs.readdirSync(path.join(f.root,'data/updates')),['Atlas-0.3.0.zip']);
});
test('network progress uses signed totals, reports real transfer speed and locks competing actions',async t=>{
  const f=fixture(t);let unblock,entered;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>unblock=resolve);
  network(f,async function*(){entered();await gate;for(let at=0;at<f.bytes.length;at+=65536){f.tick();yield f.bytes.subarray(at,at+65536);}});
  const download=f.app.download();await waiting;
  await assert.rejects(f.app.check(),/running/);await assert.rejects(f.app.download(),/running/);unblock();await download;
  const events=f.states.filter(s=>s.progress.stage==='downloading'&&s.progress.receivedBytes>0);
  assert.equal(events.length,16);assert(events.every(s=>s.progress.totalBytes===f.bytes.length&&s.progress.bytesPerSecond>0));
  assert.equal(f.app.status().ready,'0.3.0');
});
for(const mode of ['truncated','oversized','corrupted'])test(mode+' archive never becomes installable and leaves no partial archive',async t=>{
  const f=fixture(t);
  network(f,async function*(){yield mode==='truncated'?f.bytes.subarray(0,128):mode==='oversized'?Buffer.concat([f.bytes,Buffer.from('x')]):Buffer.alloc(f.bytes.length,43);});
  await assert.rejects(f.app.download(),mode==='oversized'?/size limit/:/checksum/);assertFailed(f);
});
test('a disconnected download retains its byte count, removes staging and resets on retry',async t=>{
  const f=fixture(t);network(f,async function*(){f.tick();yield f.bytes.subarray(0,65536);throw new Error('Connection interrupted');});
  await assert.rejects(f.app.download(),/Connection interrupted/);assertFailed(f);assert.equal(f.app.status().progress.receivedBytes,65536);
  const start=f.states.length;network(f,async function*(){f.tick();yield f.bytes;});
  const result=await f.app.download();assert.equal(result.error,null);assert.equal(result.ready,'0.3.0');
  assert.equal(f.states.slice(start).find(s=>s.progress.stage==='downloading').progress.receivedBytes,0);
});
test('scheduled automatic downloads broadcast application progress without per-chunk library refreshes',async t=>{
  const f=fixture(t),events=[];let quit,tick;
  fs.mkdirSync(path.join(f.resources,'seed'));fs.writeFileSync(path.join(f.resources,'seed/index.atlas.json'),f.feed());
  const electron={app:{on:(name,fn)=>{if(name==='before-quit')quit=fn;}},ipcMain:{handle(){}},shell:{},dialog:{}};
  const interval=global.setInterval;global.setInterval=(fn,...args)=>{tick=fn;return interval(fn,...args);};
  let runtime;
  try{
    runtime=require('../src/atlas/runtime.cjs').init({root:f.root,resources:f.resources,host:{},getWindow:()=>({isDestroyed:()=>false,webContents:{send:(channel,state)=>events.push({channel,state})}}),electron,isBusy:()=>false});
    t.after(()=>quit?.());await runtime.ready;
  }finally{global.setInterval=interval;}
  runtime.library.config.lastCheckedAt=0;await tick();
  assert.equal(runtime.application.status().ready,'0.3.0');
  const appEvents=events.filter(e=>e.channel==='atlas:app:state');
  assert(appEvents.some(e=>e.state.progress?.stage==='downloading'&&e.state.progress.receivedBytes>0));
  assert(appEvents.some(e=>e.state.progress?.stage==='verifying'));
  assert(appEvents.at(-1).state.ready);assert.equal(appEvents.at(-1).state.working,false);
  assert(events.filter(e=>e.channel==='atlas:library:state').length<=3);
});
